import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { SegmentedRecording } from '../backend/segmented_recording.js';
import { exportRecording } from '../backend/recording_export.js';
import { validateRecordingConfig } from '../backend/recording_config.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 6000) { const end = Date.now() + timeout; while (!check()) { assert.ok(Date.now() < end, 'Condition timed out'); await delay(25); } }
function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manta-segments-'));
  const children = [];
  const options = { directory, input: 'rtsp://camera/main', reserveBytes: 0, reserveRatio: 0,
    diskSpace: () => ({ free: 1e10, total: 1e11 }), retryMs: 25,
    spawnProcess(binary, args) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.args = args; child.signals = [];
      child.kill = signal => { child.signals.push(signal); queueMicrotask(() => child.emit('close', 255, signal)); return true; };
      children.push(child); return child;
    }, ...extra };
  const recorder = new SegmentedRecording(options);
  t.after(async () => { await recorder.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  function frame(index = children.length - 1) {
    const child = children[index];
    const output = child.args.at(-1).replace('%06d', String(Number(child.args[child.args.indexOf('-segment_start_number') + 1])).padStart(6, '0'));
    const bytes = Buffer.alloc(2048); bytes.writeUInt32BE(2048); bytes.write('moof', 4);
    fs.writeFileSync(output, bytes);
    child.stdout.write('frame=1\n');
  }
  return { recorder, children, directory, options, frame };
}

test('no optimistic REC, one child, fresh segment after disconnect, manual stop cancels retries', async t => {
  const r = fixture(t); r.recorder.start({ name: 'session' });
  assert.equal(r.recorder.state().active, false);
  assert.equal(r.recorder.start().alreadyRunning, true);
  r.frame(); assert.equal(r.recorder.state().active, true);
  const id = r.recorder.state().current.sessionId;
  r.children[0].emit('close', 1, null);
  assert.equal(r.recorder.state().phase, 'recovering');
  assert.equal(r.recorder.state().active, false);
  await until(() => r.children.length === 2); r.frame();
  assert.equal(r.recorder.state().current.sessionId, id);
  assert.equal(r.recorder.session.segments.length, 2);
  assert.equal(r.recorder.session.segments[0].finalized, true);
  r.children[1].emit('close', 1, null);
  await r.recorder.stop(); await delay(80);
  assert.equal(r.children.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(r.recorder.activeFile)).desired, false);
});

test('watchdog detects a live but frameless process and retries', async t => {
  const r = fixture(t, { startupTimeoutMs: 20 });
  r.recorder.start(); await until(() => r.children.length > 1);
  assert.deepEqual(r.children[0].signals, ['SIGINT']);
});

test('service restart preserves intent and segment numbering; manual stop survives restart', async t => {
  const r = fixture(t); r.recorder.start(); r.frame(); await r.recorder.stop({ preserveIntent: true });
  const resumed = new SegmentedRecording(r.options);
  assert.equal(resumed.state().desired, true); resumed.resume();
  const child = r.children.at(-1);
  assert.equal(child.args[child.args.indexOf('-segment_start_number') + 1], '2');
  await resumed.stop();
  const stopped = new SegmentedRecording(r.options); stopped.resume();
  assert.equal(stopped.state().desired, false);
  assert.equal(r.children.length, 2);
});

test('disk reserve stops cleanly and cannot trigger an endless recovery loop', async t => {
  let free = 1e10;
  const r = fixture(t, { reserveBytes: 1000, diskSpace: () => ({ free, total: 1e11 }) });
  r.recorder.start(); r.frame(); free = 0;
  await until(() => r.recorder.state().phase === 'failed');
  assert.equal(r.recorder.state().desired, false);
  await delay(80); assert.equal(r.children.length, 1);
});

test('recording configuration rejects unsafe values', () => {
  assert.equal(validateRecordingConfig({ segment_seconds: 120, tf_sync_enabled: false }).length, 0);
  assert.equal(validateRecordingConfig({ segment_seconds: 0, reserve_ratio: 1, tf_sync_enabled: 'true' }).length, 3);
});

test('metadata write failure cancels recovery and invalidates a stale persisted start', async t => {
  const r = fixture(t); r.recorder.start(); r.frame();
  r.recorder.persist = () => { throw new Error('disk write failed'); };
  await r.recorder.stop();
  assert.equal(r.recorder.state().desired, false);
  assert.equal(new SegmentedRecording(r.options).state().desired, false);
});

test('an open file is protected before first progress; archived session metadata survives rename and delete', async t => {
  const r = fixture(t); r.recorder.start();
  const name = path.basename(r.children[0].args.at(-1).replace('%06d', '000001'));
  assert.equal(r.recorder.isOpen(name), true);
  r.frame(); const sessionId = r.recorder.state().current.sessionId; await r.recorder.stop();
  r.recorder.start(); assert.equal(r.recorder.metadata(name).sessionId, sessionId);
  fs.renameSync(path.join(r.directory, name), path.join(r.directory, 'renamed.mp4'));
  r.recorder.updateMetadata(name, 'renamed.mp4');
  assert.equal(r.recorder.metadata('renamed.mp4').sessionId, sessionId);
  fs.unlinkSync(path.join(r.directory, 'renamed.mp4')); r.recorder.updateMetadata('renamed.mp4');
  assert.equal(r.recorder.metadata('renamed.mp4'), null);
});

test('restart discards a header-only unfinished file left by a crashed backend', async t => {
  const r = fixture(t); r.recorder.start(); r.frame(); await r.recorder.stop({ preserveIntent: true });
  const header = path.join(r.directory, r.recorder.session.prefix + '__000002.mp4'); fs.writeFileSync(header, Buffer.alloc(20));
  const recovered = new SegmentedRecording(r.options); recovered.resume();
  assert.equal(fs.existsSync(header), false); assert.equal(recovered.session.segments.length, 1);
  await recovered.stop();
});

test('real FFmpeg segments play, a killed writer resumes, and export produces ordinary MP4 without re-encoding',
  { skip: spawnSync('ffmpeg', ['-version']).status !== 0, timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manta-real-segments-'));
  const source = path.join(directory, 'source.mp4');
  execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=25','-t','2','-c:v','libx264','-g','25','-bf','0',source]);
  const recorder = new SegmentedRecording({ directory, input: source, segmentSeconds: 1, reserveBytes: 0, reserveRatio: 0, retryMs: 25,
    spawnProcess(binary, args, options) { const index = args.indexOf('-i'); args.splice(index, 0, '-re', '-stream_loop', '-1'); return spawn(binary, args, options); } });
  t.after(async () => { await recorder.stop(); fs.rmSync(directory, { recursive: true, force: true }); }); recorder.start({ name: 'real' });
  await until(() => recorder.state().active);
  await until(() => recorder.session.segments.filter(s => s.finalized).length >= 2);
  const sessionId = recorder.state().current.sessionId;
  recorder.run.child.kill('SIGKILL');
  await until(() => recorder.state().phase === 'recovering');
  await until(() => recorder.state().active);
  assert.equal(recorder.state().current.sessionId, sessionId);
  await delay(1200); await recorder.stop();
  const segments = recorder.session.segments.filter(s => s.size > 0);
  assert.ok(segments.length >= 3);
  for (const item of segments) {
    const file = path.join(directory, item.name);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',file]));
    assert.equal(probe.streams[0].width, 160);
    assert.ok(Number(probe.format.duration) > 0);
  }
  const exported = await exportRecording(path.join(directory, segments[0].name));
  const bytes = fs.readFileSync(exported.path);
  assert.equal(bytes.includes(Buffer.from('moof')), false);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_streams','-of','json',exported.path]));
  assert.equal(probe.streams[0].codec_name, 'h264'); exported.cleanup();
});
