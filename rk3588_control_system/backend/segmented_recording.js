import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const safeName = value => String(value || 'recording').replace(/[^\w\u4e00-\u9fff.-]+/g, '_').replace(/^[._-]+/, '').slice(0, 80) || 'recording';

function hasFragment(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  try {
    const header = Buffer.alloc(16), end = fs.fstatSync(fd).size;
    for (let offset = 0; offset + 8 <= end;) {
      fs.readSync(fd, header, 0, Math.min(16, end - offset), offset);
      if (header.toString('ascii', 4, 8) === 'moof') return true;
      const size = header.readUInt32BE(0) === 1 ? Number(header.readBigUInt64BE(8)) : header.readUInt32BE(0);
      if (size < 8 || !Number.isSafeInteger(size)) break;
      offset += size;
    }
    return false;
  } finally { fs.closeSync(fd); }
}

// One persisted user intent owns all reconnect attempts and all segments.
export class SegmentedRecording {
  constructor({ directory, input, binary = 'ffmpeg', codec = 'copy', bitrate = '12M',
    transport = 'tcp', segmentSeconds = 120, startupTimeoutMs = 15000, stallTimeoutMs = 8000,
    retryMs = 1000, stopTimeoutMs = 10000, reserveBytes = 1024 ** 3, reserveRatio = 0.05,
    spawnProcess = spawn, diskSpace, onChange = () => {}, log = () => {} }) {
    Object.assign(this, { directory, input, binary, codec, bitrate, transport, segmentSeconds,
      startupTimeoutMs, stallTimeoutMs, retryMs, stopTimeoutMs, reserveBytes, reserveRatio,
      spawnProcess, onChange, log });
    fs.mkdirSync(directory, { recursive: true });
    this.metadataDirectory = path.join(directory, '.sessions');
    fs.mkdirSync(this.metadataDirectory, { recursive: true });
    this.activeFile = path.join(this.metadataDirectory, 'active.json');
    this.diskSpace = diskSpace || (() => {
      const stat = fs.statfsSync(directory);
      return { free: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize };
    });
    this.instanceId = randomUUID(); this.revision = 0; this.phase = 'idle';
    this.session = null; this.run = null; this.error = null; this.suspended = false;
    this.retryTimer = null; this.attempt = 0;
    this.metadataCache = null; this.liveParts = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(this.activeFile, 'utf8'));
      if (saved.version === 1 && /^[a-f0-9-]{36}$/.test(saved.id)
        && saved.prefix === safeName(saved.prefix) && Array.isArray(saved.segments)) {
        this.session = saved;
        if (saved.desired) this.phase = 'recovering'; else this.phase = 'stopped';
      }
    } catch (error) { if (error.code !== 'ENOENT') this.log(`Session restore: ${error.message}`); }
  }

  state() {
    const s = this.session;
    return { instanceId: this.instanceId, revision: this.revision, serverTime: Date.now(),
      phase: this.phase, desired: Boolean(s?.desired), active: this.phase === 'recording', error: this.error,
      current: s ? { sessionId: s.id, name: s.prefix, title: s.title, startedAt: s.startedAt,
        elapsedMs: Math.max(0, (s.endedAt ? Date.parse(s.endedAt) : Date.now()) - Date.parse(s.startedAt)),
        segmentCount: s.segments.filter(p => p.finalized).length,
        bytes: s.segments.reduce((sum, p) => sum + p.size, 0),
        currentSegment: s.segments.find(p => !p.finalized)?.name || null,
        interruptions: s.interruptions || 0 } : null };
  }

  persist() {
    if (!this.session) return;
    const data = JSON.stringify(this.session, null, 2);
    for (const file of [path.join(this.metadataDirectory, `${this.session.id}.json`), this.activeFile]) {
      const temporary = `${file}.tmp`;
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    }
  }

  publish(persist = true) {
    this.revision++;
    if (persist) {
      try { this.persist(); }
      catch (error) {
        this.error = `Cannot save recording session: ${error.message}`;
        this.phase = 'failed';
        if (this.session) this.session.desired = false;
        // An invalid intent file is safer than resurrecting an unpersisted stop.
        try { fs.truncateSync(this.activeFile, 0); } catch {}
        if (this.run) this.interrupt(this.run);
        this.log(this.error);
      }
    }
    this.onChange(this.state());
  }

  spaceAvailable(extra = 0) {
    const space = this.diskSpace();
    return space.free > Math.max(this.reserveBytes, space.total * this.reserveRatio) + extra;
  }

  start({ name = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
    if (this.session?.desired || this.run) return { alreadyRunning: true, state: this.state() };
    if (!this.spaceAvailable()) throw new Error('Insufficient recording space');
    this.suspended = false; this.attempt = 0; this.error = null;
    const id = randomUUID();
    this.session = { version: 1, id, title: safeName(name), prefix: `${safeName(name).slice(0, 60)}_${id.slice(0, 8)}`,
      desired: true, startedAt: new Date().toISOString(), endedAt: null, segments: [], interruptions: 0 };
    this.metadataCache = null; this.liveParts = new Map();
    try { this.persist(); } catch (error) { this.session.desired = false; this.phase = 'failed'; throw error; }
    this.launch();
    return { alreadyRunning: false, state: this.state() };
  }

  resume() {
    this.suspended = false;
    if (this.session?.desired && !this.run) {
      try {
      this.scan(true);
      const empty = this.session.segments.filter(part => !hasFragment(path.join(this.directory, part.name)));
      for (const part of empty) { fs.rmSync(path.join(this.directory, part.name), { force: true }); this.liveParts.delete(part.name); }
      this.session.segments = this.session.segments.filter(part => !empty.includes(part));
      this.launch();
      } catch (error) {
        this.error = error.message; this.session.desired = false; this.phase = 'failed'; this.publish();
      }
    }
  }

  scan(closed = false) {
    const s = this.session;
    if (!s) return;
    const prefix = `${s.prefix}__`;
    const files = fs.readdirSync(this.directory).filter(name => name.startsWith(prefix)
      && /^\d{6}\.mp4$/.test(name.slice(prefix.length))).sort();
    const known = new Map(s.segments.map(part => [part.name, part]));
    for (const name of files) {
      let part = known.get(name);
      if (part?.finalized) continue;
      const size = fs.statSync(path.join(this.directory, name)).size;
      if (!part) { part = { name, index: Number(name.slice(prefix.length, -4)), finalized: false }; s.segments.push(part); known.set(name, part); }
      part.size = size;
      if (closed || name !== files.at(-1)) part.finalized = true;
    }
    s.segments.sort((a, b) => a.index - b.index);
    this.liveParts = known;
  }

  launch() {
    clearTimeout(this.retryTimer); this.retryTimer = null;
    if (!this.session?.desired || this.suspended || this.run) return;
    try {
      if (!this.spaceAvailable()) { this.failSpace(); return; }
      this.scan(true);
      const startIndex = Math.max(0, ...this.session.segments.map(p => p.index)) + 1;
      const args = ['-hide_banner', '-loglevel', 'warning', '-n', '-progress', 'pipe:1', '-nostats'];
      // Use the frame watchdog for timeout: FFmpeg 4.4's "timeout" means RTSP listen mode.
      if (this.input.startsWith('rtsp://')) args.push('-rtsp_transport', this.transport);
      args.push('-i', this.input, '-map', '0:v:0', '-an', '-c:v', this.codec);
      if (this.codec !== 'copy') args.push('-b:v', this.bitrate);
      args.push('-f', 'segment', '-segment_time', String(this.segmentSeconds), '-segment_start_number', String(startIndex),
        '-reset_timestamps', '1', '-segment_format', 'mp4', '-segment_format_options',
        'movflags=+frag_keyframe+empty_moov+default_base_moof', '-flush_packets', '1',
        path.join(this.directory, `${this.session.prefix}__%06d.mp4`));
      const child = this.spawnProcess(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const run = { child, startIndex, frames: 0, pending: '', started: Date.now(), lastFrame: Date.now(), stopping: false };
      run.closed = new Promise(resolve => { run.resolve = resolve; });
      this.run = run; this.phase = 'starting'; this.publish();
      child.stdout.on('data', data => {
        run.pending += data.toString();
        const lines = run.pending.split(/\r?\n/); run.pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('frame=')) continue;
          const frames = Number(line.slice(6));
          if (frames <= run.frames) continue;
          run.frames = frames; run.lastFrame = Date.now();
          this.scan();
          if (!run.stopping && this.phase !== 'recording'
            && this.session.segments.some(p => p.index >= startIndex && p.size > 0)) {
            this.phase = 'recording'; this.error = null; this.attempt = 0; this.publish();
          }
        }
      });
      child.stderr.on('data', data => { run.lastError = data.toString().slice(-2000).trim(); this.log(run.lastError); });
      child.once('error', error => { run.lastError = error.message; });
      child.once('close', (code, signal) => {
        clearInterval(run.monitor); clearTimeout(run.killTimer);
        this.scan(true);
        {
          const empty = this.session.segments.filter(p => p.index >= startIndex
            && (run.frames === 0 || !hasFragment(path.join(this.directory, p.name))));
          for (const part of empty) {
            fs.rmSync(path.join(this.directory, part.name), { force: true });
          }
          this.session.segments = this.session.segments.filter(p => !empty.includes(p));
          for (const part of empty) this.liveParts.delete(part.name);
        }
        this.run = null;
        if (this.session.desired && !this.suspended) {
          this.session.interruptions++;
          this.error = run.lastError || `Video source ended (${code}, ${signal || ''})`;
          this.phase = 'recovering'; this.publish();
          this.retryTimer = setTimeout(() => this.launch(), Math.min(15000, this.retryMs * 2 ** Math.min(this.attempt++, 4)));
          this.retryTimer.unref?.();
        } else { this.phase = this.suspended ? 'suspended' : (this.error ? 'failed' : 'stopped'); this.publish(); }
        run.resolve(this.state());
      });
      run.monitor = setInterval(() => {
        try {
          this.scan();
          if (!this.spaceAvailable()) { this.failSpace(); return; }
          const timeout = run.frames ? this.stallTimeoutMs : this.startupTimeoutMs;
          if (!run.stopping && Date.now() - run.lastFrame > timeout) {
            this.error = 'Video frames timed out'; this.phase = 'recovering'; this.publish(); this.interrupt(run);
          }
        } catch (error) {
          this.error = error.message; this.session.desired = false; this.publish(); this.interrupt(run);
        }
      }, 500);
      run.monitor.unref?.();
    } catch (error) {
      this.error = error.message; this.phase = 'failed'; this.session.desired = false; this.publish();
    }
  }

  interrupt(run) {
    if (run.stopping) return;
    run.stopping = true;
    run.child.kill('SIGINT');
    run.killTimer = setTimeout(() => run.child.kill('SIGKILL'), this.stopTimeoutMs);
    run.killTimer.unref?.();
  }

  failSpace() {
    this.error = 'Insufficient recording space';
    this.session.desired = false; this.session.endedAt = new Date().toISOString();
    this.phase = 'failed'; this.publish();
    if (this.run) this.interrupt(this.run);
  }

  async stop({ preserveIntent = false } = {}) {
    clearTimeout(this.retryTimer); this.retryTimer = null;
    if (!this.session) return this.state();
    this.suspended = preserveIntent;
    if (!preserveIntent) { this.session.desired = false; this.session.endedAt = new Date().toISOString(); this.error = null; }
    this.phase = this.run ? 'stopping' : (preserveIntent ? 'suspended' : 'stopped');
    this.publish(); // Persist manual stop before touching the child: it must never resurrect.
    if (this.run) { const run = this.run; this.interrupt(run); await run.closed; }
    return this.state();
  }

  metadata(name) {
    if (this.session) {
      const part = this.liveParts.get(name);
      if (part) return { ...part, sessionId: this.session.id, sessionTitle: this.session.title };
    }
    if (!this.metadataCache) {
      this.metadataCache = new Map();
      for (const file of fs.readdirSync(this.metadataDirectory).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
        let session;
        try { session = JSON.parse(fs.readFileSync(path.join(this.metadataDirectory, file), 'utf8')); }
        catch (error) { this.log(`Invalid recording manifest ${file}: ${error.message}`); continue; }
        for (const part of session.segments || []) this.metadataCache.set(part.name, { ...part, sessionId: session.id, sessionTitle: session.title });
      }
    }
    return this.metadataCache.get(name) || null;
  }

  isOpen(name) {
    if (!this.run) return false;
    const known = this.liveParts.get(name);
    if (known) return !known.finalized;
    const prefix = `${this.session.prefix}__`;
    return name.startsWith(prefix) && /^\d{6}\.mp4$/.test(name.slice(prefix.length))
      && Number(name.slice(prefix.length, -4)) >= this.run.startIndex;
  }

  updateMetadata(name, replacement = null) {
    this.metadataCache = null;
    for (const file of fs.readdirSync(this.metadataDirectory).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
      const target = path.join(this.metadataDirectory, file);
      const session = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!session.segments.some(part => part.name === name)) continue;
      session.segments = session.segments.flatMap(part => part.name !== name ? [part] : replacement ? [{ ...part, name: replacement }] : []);
      if (this.session?.id === session.id) { this.session.segments = session.segments; this.liveParts = new Map(session.segments.map(part => [part.name, part])); this.persist(); }
      else { fs.writeFileSync(`${target}.tmp`, JSON.stringify(session, null, 2)); fs.renameSync(`${target}.tmp`, target); }
    }
  }
}
