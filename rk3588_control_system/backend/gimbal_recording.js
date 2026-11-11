import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// The recorder owns its child until close: SIGINT alone does not finalize MP4.
export class GimbalRecording {
  constructor({ spawnProcess = spawn, onChange = () => {}, log = () => {}, discardEmpty = () => {} } = {}) {
    this.spawnProcess = spawnProcess;
    this.onChange = onChange;
    this.log = log;
    this.discardEmpty = discardEmpty;
    this.run = null;
    this.phase = 'idle';
    this.error = null;
    this.revision = 0;
    this.instanceId = randomUUID();
  }

  state() {
    const run = this.run;
    return { instanceId: this.instanceId, revision: this.revision, phase: this.phase,
      active: Boolean(run && run.frames > 0), error: this.error,
      current: run ? { ...run.recording, elapsedMs: Date.now() - run.startedAt } : null };
  }

  publish() { this.revision++; this.onChange(this.state()); }

  start(binary, args, recording, cwd) {
    if (this.run) return { alreadyRunning: true, state: this.state() };
    const child = this.spawnProcess(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const run = { child, recording, frames: 0, startedAt: Date.now(), stopping: false, pending: '' };
    run.closed = new Promise(resolve => { run.resolve = resolve; });
    this.run = run;
    this.phase = 'starting';
    this.error = null;
    child.stdout.on('data', data => {
      run.pending += data.toString();
      const lines = run.pending.split(/\r?\n/);
      run.pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('frame=')) continue;
        const frames = Number(line.slice(6));
        if (frames > 0) {
          const firstFrame = run.frames === 0;
          run.frames = frames;
          if (firstFrame && !run.stopping) {
            this.phase = 'recording';
            this.publish();
          }
        }
      }
    });
    child.stderr.on('data', data => { run.lastError = data.toString().trim(); this.log(run.lastError); });
    child.once('error', error => { run.lastError = error.message; });
    child.once('close', (code, signal) => {
      const failed = !run.stopping && (code !== 0 || run.frames === 0);
      this.error = failed ? (run.lastError || `FFmpeg exited before recording (code=${code}, signal=${signal || ''})`) : null;
      this.phase = failed ? 'failed' : 'stopped';
      if (run.frames === 0) this.discardEmpty(run.recording);
      this.run = null;
      this.publish();
      run.resolve(this.state());
    });
    this.publish();
    return { alreadyRunning: false, state: this.state() };
  }

  async stop() {
    const run = this.run;
    if (!run) return this.state();
    if (!run.stopping) {
      run.stopping = true;
      this.phase = 'stopping';
      this.publish();
      run.child.kill('SIGINT');
    }
    return run.closed;
  }
}
