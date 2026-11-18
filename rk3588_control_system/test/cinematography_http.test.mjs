import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeSiyiPackets, encodeSiyiPacket, siyiCrc16 } from '../backend/siyi_gimbal.js';
import { api, channel, delay, pair } from './helpers/control_client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = !process.env.MANTA_TEST_MEDIAMTX || !process.env.MANTA_TEST_MEDIA_PYTHON || !process.env.MANTA_TEST_CINEMA_PYTHON;

async function freePort() {
  const socket = http.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

const swimmerVideo = process.env.MANTA_TEST_CINEMA_SWIMMER_VIDEO;
const swimmerPython = process.env.MANTA_TEST_CINEMA_SWIMMER_PYTHON;

const cameraPublisher = `
import av, sys, time
from fractions import Fraction
source_file, destination = sys.argv[1:]
with av.open(destination, 'w', format='rtsp', options={'rtsp_transport':'tcp'}) as output:
    stream = output.add_stream('libx264', rate=15)
    stream.width, stream.height, stream.pix_fmt = 640, 360, 'yuv420p'
    stream.options = {'preset':'ultrafast','tune':'zerolatency','g':'15','threads':'1'}
    start, seq = time.monotonic(), 0
    while True:
        with av.open(source_file) as source:
            for raw in source.decode(video=0):
                frame = raw.reformat(width=640, height=360, format='yuv420p')
                frame.pts, frame.time_base = seq, Fraction(1, 15)
                for packet in stream.encode(frame):
                    output.mux(packet)
                seq += 1
                time.sleep(max(0, start + seq/15 - time.monotonic()))
`;

test('real cinema HTTP owns a UWB-only boat, runs the shipped actor on the shared RTSP broker and releases both outputs',
  { skip, timeout: 55000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-ppo-http-'));
  const children = [];
  t.after(async () => {
    for (const { child } of children.reverse()) {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const [port, rtspPort, framePort] = await Promise.all([freePort(), freePort(), freePort()]);
  const sockets = await Promise.all(Array.from({ length: 3 }, async () => {
    const s = dgram.createSocket('udp4');
    await new Promise(resolve => s.bind(0, '127.0.0.1', resolve));
    return s;
  }));
  const [fcu, a8, telem] = sockets;
  const inbound = telem.address().port;
  await new Promise(resolve => telem.close(resolve));
  t.after(() => { fcu.close(); a8.close(); });
  const cfg = JSON.parse(await fs.readFile(path.join(root, 'config/system.config.json')));
  Object.assign(cfg, { web_host: '127.0.0.1', web_port: port, bridge_host: '127.0.0.1', bridge_command_port: fcu.address().port,
    bridge_telemetry_port: inbound, logs_dir: path.join(dir, 'logs') });
  const rtsp = 'rtsp://127.0.0.1:' + rtspPort + '/camera';
  cfg.uwb_usb = { enabled:false };
  cfg.recordings.dir = path.join(dir, 'recordings');
  cfg.camera.enabled = false;
  cfg.hotspot.managed_externally = true;
  Object.assign(cfg.gimbal, { enabled:true, auto_connect:true, protocol:'siyi',
    control_transport:'udp', udp_host:'127.0.0.1', udp_port:a8.address().port });
  Object.assign(cfg.gimbal.beacon, { enabled:true, calibration_required:false, dry_run:false,
    use_pitch:false, control_mode:'absolute_angle' });
  Object.assign(cfg.gimbal.face, { keep_warm:false, prewarm:false });
  Object.assign(cfg.gimbal.swimmer, { device:'cpu', detector_threads:2 });
  Object.assign(cfg.gimbal.video, { proxy_host:'127.0.0.1', proxy_port:framePort,
    recognition_input:rtsp, record_input:rtsp, shared_frame_alignment:true });
  const configFile = path.join(dir, 'config.json');
  await fs.writeFile(configFile, JSON.stringify(cfg));
  const mediaConfig = path.join(dir, 'rtsp.yml');
  await fs.writeFile(mediaConfig, 'rtspAddress: 127.0.0.1:'+rtspPort+'\nrtspTransports: [tcp]\nplayback: no\nmoq: no\nrtmp: no\nhls: no\nwebrtc: no\nsrt: no\npaths:\n  camera:\n    source: publisher\n');
  const env = { ...process.env, MANTA_CONFIG_FILE:configFile, MANTA_CONTROL_PIN:'123456',
    MANTA_PPO_PYTHON:process.env.MANTA_TEST_CINEMA_PYTHON, CUDA_VISIBLE_DEVICES:'', OMP_NUM_THREADS:'1',
    MANTA_PPO_DEVICE:'cpu', MANTA_UWB_VISION_CONFIG:path.join(dir, 'fusion.json') };
  if (swimmerPython) env.SWIMMER_PYTHON_EXEC = swimmerPython;
  delete env.MANTA_SIMULATION;
  function launch(binary, args) {
    const child = spawn(binary, args, { env, cwd:root, stdio:['ignore','pipe','pipe'] });
    const entry = { child, binary, log:'' }; children.push(entry);
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', b => { entry.log = (entry.log + b).slice(-2800); });
    return child;
  }
  async function waitFor(fn, name, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const result = await fn();
      if (result) return result;
      const failed = children.find(e => e.child.exitCode !== null);
      assert.ok(!failed, name + ' ' + (failed?.log || ''));
      await delay(40);
    }
    assert.fail(name + ' ' + children.map(e => e.log).join('\n').slice(-4000));
  }

  const motors = [], pans = [];
  fcu.on('message', b => {
    const packet = JSON.parse(b);
    if (packet.command === 'ROVER_DRIVE') motors.push(packet.params);
  });
  a8.on('message', (bytes, peer) => {
    for (const packet of decodeSiyiPackets(bytes).packets) {
      let payload;
      if (packet.command === 0x0a) { payload = Buffer.alloc(6); payload[5] = 2; }
      if (packet.command === 0x0d) { payload = Buffer.alloc(12); payload.writeInt16LE(1800, 2); }
      if (packet.command === 0x07) pans.push([packet.payload.readInt8(0), packet.payload.readInt8(1)]);
      if (payload) {
        const response = encodeSiyiPacket(packet.command, payload, packet.sequence);
        response[2] = 2; response.writeUInt16LE(siyiCrc16(response.subarray(0, -2)), response.length - 2);
        a8.send(response, peer.port, peer.address);
      }
    }
  });
  const mediaPython = process.env.MANTA_TEST_MEDIA_PYTHON;
  launch(process.env.MANTA_TEST_MEDIAMTX, [mediaConfig]);
  await delay(250);
  launch(mediaPython, ['-c', cameraPublisher, swimmerVideo || 'frontend/assets/manta-app/gimbal-demo.mp4', rtsp]);
  launch(mediaPython, ['-u','scripts/gimbal_rtsp_stream_server.py']);
  launch(process.execPath, ['backend/server.js']);
  const base = 'http://127.0.0.1:' + port;
  const retrieveOk = async url => { try { const r = await fetch(url); await r.body?.cancel(); return r.ok; } catch { return false; } };
  await waitFor(() => retrieveOk(base+'/health'), 'HTTP server unavailable', 7000);
  await waitFor(() => retrieveOk('http://127.0.0.1:'+framePort+'/_cinema-frame.jpg'), 'Shared RTSP camera unavailable', 10000);
  const client = 'ppo-hardware-peer-0001';
  const cookie = await pair(base, client);
  const owner = channel(t, base, cookie, client); await owner.ready;
  const request = api(base, cookie, client);
  assert.equal((await request('/api/control/claim',{})).status,200);
  let distance = 5;
  function telemetry() {
    const at = Date.now(), bearing = -25;
    const payload = { flightMode:'MANUAL', armed:true, pilotSteering:{ready:true,type:0},
      attitude:{yaw:0,pitch:0,roll:0,yawRateDegS:0,updatedAt:at}, uwb: { online:true, fresh:true,
        streamId:'loopback', measurementStatus:'trusted', coordinateSource:'smoothed', smoothing:{ready:true},
        measurementUpdatedAt:at, updatedAt:at, distanceM:distance, azimuthDeg:bearing, elevationValid:false,
        relativeXM:distance*Math.cos(bearing*Math.PI/180), relativeYM:distance*Math.sin(bearing*Math.PI/180) } };
    fcu.send(Buffer.from(JSON.stringify({type:'telemetry',payload})), inbound, '127.0.0.1');
  }
  const timer = setInterval(telemetry, 30); t.after(() => clearInterval(timer)); telemetry();
  const getState = async () => (await (await request('/api/cinematography/state')).json()).data;
  await waitFor(async () => (await getState()).can_start, 'FCU and camera feedback unavailable', 5000);
  const set = await request('/api/cinematography/vision', {p_enabled:false});
  assert.equal(set.status,200); assert.equal((await set.json()).data.p_enabled,false);
  const started = await request('/api/cinematography/start', {mode:'ppo'});
  assert.equal(started.status,200, JSON.stringify(await started.json()));
  const running = await waitFor(async () => {
    const state = await getState();
    assert.notEqual(state.state, 'fault', JSON.stringify(state));
    return state.state === 'running' && state;
  }, 'Policy did not start on real frames', 20000);
  assert.match(running.policy_version, /^hybrid_qppo_u/);
  assert.equal(running.target_state, 'uwb');
  const m = motors.length, g = pans.length;
  distance = 5.6;
  await waitFor(() => motors.slice(m).some(p => Math.abs(p.throttle) > 0 || Math.abs(p.steering) > 0),
    'Policy reference did not produce motion inside nominal range', 3500);
  // Increasing range forces recovery regardless of the sampled original mode.
  distance = 9.1;
  await waitFor(() => motors.slice(m).some(p => p.throttle > 0 && p.motorTargetSemantics === true)
    && pans.slice(g).some(([x,y]) => x || y), 'PPO failed to write both hardware protocols', 4000);
  let visualObserved = false;
  if (swimmerVideo && swimmerPython) {
    distance = 5.4;
    const toggle = async enabled => {
      const response = await request('/api/cinematography/vision', {p_enabled:enabled});
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.data.p_enabled, enabled);
    };
    await toggle(true);
    await waitFor(async () => {
      const state = await getState();
      assert.notEqual(state.state, 'fault', JSON.stringify(state));
      return state.state === 'running' && state.p_enabled && state.target_state === 'detected';
    }, 'No measured swimmer reached the real actor', 20000);
    visualObserved = true;
    await toggle(false);
    await waitFor(async () => {
      const state = await getState();
      assert.notEqual(state.state, 'fault', JSON.stringify(state));
      return state.state === 'running' && !state.p_enabled && state.target_state === 'uwb';
    }, 'Exited visual worker interrupted the new UWB session', 10000);
    await delay(900);
    const state = await getState();
    assert.equal(state.state, 'running', JSON.stringify(state));
    const gimbal = (await (await request('/api/gimbal/state')).json()).state;
    assert.equal(gimbal.trackMode, 'beacon'); assert.equal(gimbal.trackWorkerActive, false);
  }
  const stopped = await request('/api/cinematography/stop', {});
  assert.equal(stopped.status,200); assert.equal((await stopped.json()).data.state,'idle');
  await waitFor(() => motors.at(-1)?.throttle === 0 && motors.at(-1)?.steering === 0
    && pans.at(-1)?.every(v => v === 0), 'Stop did not neutralize both protocols', 2000);
  const n = motors.length;
  await delay(400);
  assert.ok(motors.slice(n).every(p => p.throttle === 0 && p.steering === 0));
  t.diagnostic(JSON.stringify({ policy:running.policy_version, initialIntent:running.intent_mode,
    p_enabled:running.p_enabled, liveVisualRoundTrip:visualObserved, target:running.target_state, maxThrottle:Math.max(...motors.map(m => m.throttle)),
    peakPan:Math.max(...pans.map(([x]) => Math.abs(x))), lastMotor:[motors.at(-1).throttle,motors.at(-1).steering], lastGimbal:pans.at(-1) }));
});
