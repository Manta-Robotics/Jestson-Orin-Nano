import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GimbalRecording } from '../backend/gimbal_recording.js';
const exec = promisify(execFile);

test('real FFmpeg produces playable finalized MP4 files over five start/stop cycles', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-real-recording-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const recorder = new GimbalRecording();
  t.after(() => recorder.stop());
  for (let index = 0; index < 5; index++) {
    const output = path.join(directory, `cycle-${index}.mp4`);
    recorder.start('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-re', '-f', 'lavfi',
      '-i', 'testsrc2=size=160x120:rate=25', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '0',
      '-progress', 'pipe:1', '-movflags', '+faststart', output], { name: path.basename(output) }, directory);
    const deadline = Date.now() + 3000;
    while (recorder.state().phase === 'starting' && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(recorder.state().phase, 'recording', JSON.stringify(recorder.state()));
    await new Promise(r => setTimeout(r, 100));
    await recorder.stop();
    const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output])).stdout);
    assert.equal(probe.streams[0].codec_name, 'h264');
    assert.ok(Number(probe.streams[0].nb_frames) > 0);
    assert.ok(Number(probe.format.duration) > 0);
  }
});
