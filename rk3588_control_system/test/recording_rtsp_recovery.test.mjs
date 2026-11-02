import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { SegmentedRecording } from '../backend/segmented_recording.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!check()) { assert.ok(Date.now() < end, 'RTSP recovery timed out'); await delay(30); }
}

test('real RTSP source outage reconnects without browser involvement or overwriting a segment',
  { skip: !process.env.MANTA_TEST_MEDIAMTX || process.platform === 'win32', timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manta-rtsp-recovery-'));
  let media, publisher, recorder;
  t.after(async () => { await recorder?.stop(); publisher?.kill('SIGKILL'); media?.kill('SIGKILL'); fs.rmSync(directory, { recursive: true, force: true }); });
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const source = path.join(directory, 'source.mp4');
  execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=25','-t','2','-c:v','libx264','-g','25','-bf','0',source]);
  const config = path.join(directory, 'mediamtx.yml');
  fs.writeFileSync(config, `logLevel: warn\nrtspAddress: 127.0.0.1:${port}\nrtspTransports: [tcp]\nrtmp: no\nhls: no\nwebrtc: no\nsrt: no\npaths:\n  camera:\n    source: publisher\n`);
  media = spawn(process.env.MANTA_TEST_MEDIAMTX, [config], { stdio: 'ignore' }); await delay(500);
  assert.equal(media.exitCode, null);
  const url = `rtsp://127.0.0.1:${port}/camera`;
  function publish() { return spawn('ffmpeg', ['-v','error','-re','-stream_loop','-1','-i',source,'-an','-c:v','copy','-f','rtsp','-rtsp_transport','tcp',url], { stdio: 'ignore' }); }
  publisher = publish(); await delay(600); assert.equal(publisher.exitCode, null);
  recorder = new SegmentedRecording({ directory, input: url, segmentSeconds: 1, startupTimeoutMs: 2500,
    stallTimeoutMs: 1200, stopTimeoutMs: 500, retryMs: 100, reserveBytes: 0, reserveRatio: 0 });
  recorder.start({ name: 'outage' }); await until(() => recorder.state().active);
  const id = recorder.state().current.sessionId;
  await delay(1500); publisher.kill('SIGKILL');
  await until(() => recorder.state().phase === 'recovering');
  assert.equal(recorder.state().desired, true); await delay(1000);
  publisher = publish();
  await until(() => recorder.state().active);
  assert.equal(recorder.state().current.sessionId, id);
  assert.ok(recorder.state().current.interruptions > 0);
  await delay(1500); await recorder.stop();
  assert.ok(recorder.session.segments.length >= 2);
  assert.equal(new Set(recorder.session.segments.map(p => p.name)).size, recorder.session.segments.length);
});
