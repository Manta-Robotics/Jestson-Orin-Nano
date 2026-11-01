import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { encodeSiyiPacket, decodeSiyiPackets, siyiCrc16 } from '../backend/siyi_gimbal.js';
import { api, channel, pair, delay, until } from './helpers/control_client.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);

test('isolated production HTTP/Socket.IO routes control a simulated A8, save video and dispatch mocked poweroff',
  { skip: process.platform === 'win32' || !process.env.MANTA_TEST_MEDIAMTX, timeout: 45000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-follow-camera-http-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'source.mp4');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=25', '-t', '1', '-c:v', 'libx264', '-bf', '0', input]);
  const rtspSocket = http.createServer(); await new Promise(resolve => rtspSocket.listen(0, '127.0.0.1', resolve));
  const rtspPort = rtspSocket.address().port; await new Promise(resolve => rtspSocket.close(resolve));
  const mediaConfig = path.join(directory, 'mediamtx.yml');
  await fs.writeFile(mediaConfig, `rtspAddress: 127.0.0.1:${rtspPort}\nrtmp: no\nhls: no\nwebrtc: no\nsrt: no\npaths:\n  camera:\n    source: publisher\n`);
  const media = spawn(process.env.MANTA_TEST_MEDIAMTX, [mediaConfig], { stdio: 'ignore' });
  t.after(() => media.kill('SIGKILL')); await delay(300);
  assert.equal(media.exitCode, null, 'Isolated MediaMTX failed to start');
  const rtspUrl = `rtsp://127.0.0.1:${rtspPort}/camera`;
  const publisher = spawn('ffmpeg', ['-v', 'error', '-re', '-stream_loop', '-1', '-i', input, '-an', '-c:v', 'copy', '-f', 'rtsp', '-rtsp_transport', 'tcp', rtspUrl], { stdio: 'ignore' });
  t.after(() => publisher.kill('SIGKILL')); await delay(500);
  assert.equal(publisher.exitCode, null, 'Simulated RTSP source failed');
  const bin = path.join(directory, 'bin'); await fs.mkdir(bin);
  const shutdownLog = path.join(directory, 'poweroff.json');
  const fakeSudo = path.join(bin, 'sudo');
  await fs.writeFile(fakeSudo, '#!/usr/bin/env node\nrequire("fs").writeFileSync('+JSON.stringify(shutdownLog)+', JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  // Confirm the executable used by this child is our test double before any route runs.
  await exec(fakeSudo, ['mock-check']); assert.deepEqual(JSON.parse(await fs.readFile(shutdownLog)), ['mock-check']); await fs.unlink(shutdownLog);
  const camera = dgram.createSocket('udp4'), bridge = dgram.createSocket('udp4'), temp = dgram.createSocket('udp4');
  await Promise.all([camera, bridge, temp].map(socket => new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))));
  const telemetryPort = temp.address().port; await new Promise(resolve => temp.close(resolve));
  t.after(() => { camera.close(); bridge.close(); });
  const yawCommands = []; let yaw = 0;
  camera.on('message', (message, peer) => {
    for (const packet of decodeSiyiPackets(message).packets) {
      let payload;
      if (packet.command === 0x0a) { payload = Buffer.alloc(6); payload[5] = 2; }
      if (packet.command === 0x0d) { payload = Buffer.alloc(12); payload.writeInt16LE(Math.round(yaw * 10), 0); payload.writeInt16LE(1800, 2); }
      if (packet.command === 0x0e) { yaw = packet.payload.readInt16LE(0) / 10; yawCommands.push({ yaw, at: performance.now() }); }
      if (payload) { const response = encodeSiyiPacket(packet.command, payload, packet.sequence); response[2] = 2;
        // Recompute CRC after changing the response-control byte.
        response.writeUInt16LE(siyiCrc16(response.subarray(0, -2)), response.length-2); camera.send(response, peer.port, peer.address); }
    }
  });
  const web = http.createServer(); await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const port = web.address().port; await new Promise(resolve => web.close(resolve));
  const config = JSON.parse(await fs.readFile(path.join(root, 'config/system.config.json')));
  const profile = JSON.parse(await fs.readFile(path.join(root, 'config/jetson-follow-profile.json')));
  Object.assign(config, { web_host: '127.0.0.1', web_port: port, bridge_host: '127.0.0.1', bridge_command_port: bridge.address().port,
    bridge_telemetry_port: telemetryPort, logs_dir: path.join(directory, 'logs') });
  config.uwb_follow = profile.uwb_follow; config.uwb_usb = { enabled: false };
  Object.assign(config.gimbal, { enabled: true, auto_connect: true, protocol: 'siyi', control_transport: 'udp', udp_host: '127.0.0.1', udp_port: camera.address().port, beacon: profile.gimbal.beacon });
  Object.assign(config.gimbal.axis, profile.gimbal.axis);
  config.gimbal.face.keep_warm = false; config.gimbal.face.prewarm = false;
  config.gimbal.video.record_input = rtspUrl; config.gimbal.video.record_codec = 'copy';
  config.camera.enabled = false; config.hotspot.managed_externally = true;
  config.recordings.dir = path.join(directory, 'recordings');
  const filename = path.join(directory, 'config.json'); await fs.writeFile(filename, JSON.stringify(config));
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, MANTA_CONFIG_FILE: filename, MANTA_CONTROL_PIN: '123456' }; delete env.MANTA_SIMULATION;
  const child = spawn(process.execPath, ['backend/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  t.after(() => child.kill('SIGKILL'));
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 5000;
  while (true) { try { if ((await fetch(base+'/health')).ok) break; } catch {} assert.equal(child.exitCode, null, output); assert.ok(Date.now()<end, output); await delay(20); }
  const ownerId = 'test-camera-owner-0001', cookie = await pair(base, ownerId), owner = channel(t, base, cookie, ownerId);
  await owner.ready; const request = api(base, cookie, ownerId);
  assert.equal((await api(base, '', ownerId)('/api/system/shutdown', {})).status, 401);
  assert.equal((await request('/api/control/claim', {})).status, 200);
  let angle = -40;
  const sendUwb = () => bridge.send(Buffer.from(JSON.stringify({ type: 'uwb', payload: { source: 'simulated', streamId: 'test', online: true, fresh: true,
    measurementStatus: 'trusted', smoothing: { ready: true }, distanceM: 2.5, azimuthDeg: angle, measurementUpdatedAt: Date.now(), updatedAt: Date.now(),
    relativeXM: 2.5*Math.cos(angle*Math.PI/180), relativeYM: 2.5*Math.sin(angle*Math.PI/180) } })), telemetryPort, '127.0.0.1');
  const timer = setInterval(sendUwb, 28); t.after(() => clearInterval(timer)); sendUwb();
  await delay(250);
  assert.equal((await request('/api/gimbal/track/start', { mode: 'beacon' })).status, 200);
  await until(() => yawCommands.some(c => c.yaw > 3), 'No SIYI tracking command arrived', 2000);
  let state = (await (await request('/api/gimbal/state')).json()).state;
  assert.equal(state.trackStatus.controlMode, 'absolute_angle'); assert.equal(state.trackStatus.targetYawDeg, 40);
  angle = -179; await delay(100); angle = 179; await delay(100);
  state = (await (await request('/api/gimbal/state')).json()).state;
  assert.equal(state.trackStatus.targetYawDeg, 135); assert.equal(state.trackStatus.status, 'yaw_limit_hold');
  // Roundoff in 0.1 degree wire units contributes up to one unit to adjacent steps.
  for (let i=1;i<yawCommands.length;i++) assert.ok(Math.abs(yawCommands[i].yaw-yawCommands[i-1].yaw) <= 20*(yawCommands[i].at-yawCommands[i-1].at)/1000 + .15);
  for (let i=0;i<5;i++) {
    assert.equal((await request('/api/gimbal/recording/start', { name: 'http-cycle-'+i })).status, 200);
    let status;
    for (let k=0;k<250;k++) { status=(await (await request('/api/gimbal/recording/state')).json()).state; if (status.phase==='recording') break; assert.notEqual(status.phase,'failed',JSON.stringify(status)); await delay(20); }
    assert.equal(status.phase, 'recording');
    assert.equal((await request('/api/gimbal/recording/stop', {})).status, 200);
  }
  const recordings=(await (await request('/api/gimbal/recordings')).json()).recordings; assert.equal(recordings.length,5);
  for (const item of recordings) { const probe=JSON.parse((await exec('ffprobe',['-v','error','-show_format','-of','json',path.join(config.recordings.dir,item.name)])).stdout); assert.ok(Number(probe.format.duration)>0); }
  assert.equal((await request('/api/system/shutdown', {})).status, 200);
  let args;
  for (let i=0;i<100;i++) { try { args=JSON.parse(await fs.readFile(shutdownLog)); break; } catch {} await delay(10); }
  assert.deepEqual(args, ['-n','/usr/bin/systemctl','poweroff']);
});
