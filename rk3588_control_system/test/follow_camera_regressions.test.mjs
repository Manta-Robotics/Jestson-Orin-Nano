import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import vm from 'node:vm';
import { GimbalRecording } from '../backend/gimbal_recording.js';
import { boundedBeaconYaw, computeBeaconControl } from '../backend/gimbal_beacon.js';
import { prepareBoardShutdown, powerOffBoard } from '../backend/board_shutdown.js';
import { UwbFollowController } from '../backend/uwb_follow.js';
const Smoother = createRequire(import.meta.url)('../backend/vendor/responsive_smoother.cjs');
const wrap = angle => ((angle + 180) % 360 + 360) % 360 - 180;

test('45 degree/s UWB output remains consistent with XY and 1 m/s through steps, rear crossings and jitter', () => {
  for (const radius of [16, 25, 50, 250, 1000]) {
    const filter = new Smoother({ periodMs: 1000 / 35, maxSpeedCmPerSecond: 100, maxAzimuthRateDegS: 45 });
    let previous = null, at = 1000, seed = 913;
    for (let index = 0; index < 12000; index++) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      const dt = index % 7 === 0 ? 8 : 1000 / 35 + seed % 30;
      at += dt;
      const angle = index < 30 ? 170 : index < 800 ? (index % 2 ? 179 : -179)
        : index < 4000 ? 90 : seed % 360 - 180;
      const result = filter.update(radius + (seed % 5), angle, at);
      if (!result.ready) continue;
      if (previous) {
        const change = Math.abs(wrap(result.smoothedAzimuthDeg - previous.smoothedAzimuthDeg));
        assert.ok(change <= 45 * dt / 1000 + 1e-8, `${radius}cm: ${change}deg in ${dt}ms`);
        assert.ok(Math.hypot(result.smoothedXcm - previous.smoothedXcm, result.smoothedYcm - previous.smoothedYcm) <= 100 * dt / 1000 + 1e-8);
      }
      assert.ok(Math.abs(wrap(Math.atan2(result.smoothedYcm, result.smoothedXcm) * 180 / Math.PI - result.smoothedAzimuthDeg)) < 1e-8);
      previous = result;
    }
  }
});

test('UWB wrap crossing follows two degrees; repeated timestamps do not advance output', () => {
  const filter = new Smoother({ periodMs: 20, deadbandCm: 0, maxAzimuthRateDegS: 45 });
  let at = 1000;
  for (let i = 0; i < 10; i++) filter.update(250, 179, at += 20);
  let result;
  for (let i = 0; i < 60; i++) result = filter.update(250, -179, at += 20);
  assert.ok(Math.abs(wrap(result.smoothedAzimuthDeg + 179)) < .1);
  const repeated = filter.update(250, 90, at);
  assert.equal(repeated.smoothedXcm, result.smoothedXcm);
  assert.equal(repeated.smoothedYcm, result.smoothedYcm);
});

test('bounded gimbal keeps its original rear boundary until the target is reachable', () => {
  let previous = 120;
  for (const bearing of [140, 170, 179, -179, -160, -136]) {
    previous = boundedBeaconYaw(bearing, -135, 135, previous);
    assert.equal(previous, 135);
  }
  assert.equal(boundedBeaconYaw(-130, -135, 135, previous), -130);
  previous = -120;
  for (const bearing of [-140, -170, -179, 179, 160, 136]) {
    previous = boundedBeaconYaw(bearing, -135, 135, previous);
    assert.equal(previous, -135);
  }
  const r = computeBeaconControl({ now: 1000, uwb: { online: true, fresh: true, updatedAt: 1000, azimuthDeg: -179, distanceM: 2.5 },
    feedback: { checksumValid: true, attitudeValid: true, updatedAt: 1000, pitchDeg: 0, yawDeg: 120 },
    config: { use_pitch: false, control_mode: 'absolute_angle' }, limits: { yawMinDeg: -135, yawMaxDeg: 135 }, previousTargetYawDeg: 135 });
  assert.equal(r.targetYawDeg, 135); assert.equal(r.yawUnreachable, true);
});

function recorder() {
  const children = [], states = [], discarded = [];
  const controller = new GimbalRecording({ onChange: s => states.push(s), discardEmpty: r => discarded.push(r),
    spawnProcess() {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.signals = []; child.kill = signal => { child.signals.push(signal); return true; };
      children.push(child); return child;
    } });
  const start = () => controller.start('ffmpeg', [], { name: 'test.mp4' }, '.');
  return { controller, children, states, discarded, start };
}

test('recording becomes active only after encoded frames, and startup errors are visible', () => {
  const r = recorder(); r.start();
  assert.equal(r.controller.state().active, false);
  r.children[0].stdout.write('frame=0\n'); assert.equal(r.controller.state().active, false);
  r.children[0].stdout.write('fra'); r.children[0].stdout.write('me=1\n');
  assert.equal(r.controller.state().active, true);
  r.children[0].stderr.write('RTSP connection lost'); r.children[0].emit('close', 1, null);
  assert.equal(r.controller.state().phase, 'failed'); assert.match(r.controller.state().error, /RTSP connection lost/);
  r.start(); r.children[1].emit('error', new Error('spawn ffmpeg ENOENT')); r.children[1].emit('close', -2, null);
  assert.match(r.controller.state().error, /ENOENT/); assert.equal(r.discarded.length, 1);
});

test('300 repeated recording starts/stops wait for file close and cannot clear a new session', async () => {
  const r = recorder();
  for (let i = 0; i < 300; i++) {
    r.start(); const child = r.children[i]; child.stdout.write('frame=1\n');
    let resolved = false; const stopped = r.controller.stop().then(() => { resolved = true; });
    assert.equal(r.start().alreadyRunning, true); assert.equal(r.children.length, i + 1);
    const secondStop = r.controller.stop(); await Promise.resolve();
    assert.equal(resolved, false); assert.deepEqual(child.signals, ['SIGINT']);
    child.emit('close', 255, null); await Promise.all([stopped, secondStop]);
    assert.equal(r.controller.state().phase, 'stopped');
  }
});

test('shutdown waits for recording close before dispatch; systemctl is executed without a shell', async () => {
  const calls = []; let close;
  const work = prepareBoardShutdown({ stopFollow: () => calls.push('disarm'), stopGimbal: () => calls.push('gimbal-stop'),
    stopRecording: () => new Promise(resolve => { close = resolve; calls.push('recorder-wait'); }) });
  let complete = false; work.then(() => { complete = true; }); await Promise.resolve();
  assert.equal(complete, false); close(); await work;
  powerOffBoard({ spawnProcess(binary, args, options) { calls.push([binary, args, options]); const c = new EventEmitter(); c.stderr = new PassThrough(); return c; } });
  assert.deepEqual(calls.slice(0, 3), ['disarm', 'gimbal-stop', 'recorder-wait']);
  assert.equal(calls[3][0], 'sudo'); assert.deepEqual(calls[3][1], ['-n', '/usr/bin/systemctl', 'poweroff']);
  assert.equal(calls[3][2].shell, undefined);
});

test('mobile recording waits for backend state and preserves state after a failed stop', async () => {
  const html = fs.readFileSync(new URL('../frontend/mobile-preview-kimi-k26.html', import.meta.url), 'utf8');
  const elements = new Map(); let resolve, reject;
  const box = { state: { recording: false, transportMode: 'mock' }, recordingBusy: false, recordingRevision: -1, recordingInstance: null,
    recordTimerHandle: null, Date, Number, Promise, clearInterval() {}, setInterval: () => 1,
    localize: x => x, showToast() {}, renderRecordTimer() {}, loadLiveRecordings() {},
    ensureTransport: () => ({ gimbal: () => new Promise((yes, no) => { resolve = yes; reject = no; }) }),
    $: key => { if (!elements.has(key)) elements.set(key, { classList: { toggle() {} } }); return elements.get(key); } };
  const ctx = vm.createContext(box);
  vm.runInContext(html.slice(html.indexOf('function applyRecordingState('), html.indexOf('function shutdownBoard(')), ctx);
  const starting = box.setRecording(true); assert.equal(box.state.recording, false);
  resolve({ state: { revision: 1, active: true, phase: 'recording', current: { elapsedMs: 500 } } }); await starting;
  assert.equal(box.state.recording, true);
  const stopping = box.setRecording(false); reject(new Error('HTTP 500')); await stopping;
  assert.equal(box.state.recording, true);
  box.applyRecordingState({ revision: 0, active: false }); assert.equal(box.state.recording, true);
  box.applyRecordingState({ instanceId: 'new-backend', revision: 0, active: false, phase: 'idle' });
  assert.equal(box.state.recording, false, 'backend restart starts a new recording-state revision');
});

test('2.5 m target cannot be overridden by legacy forward approach below 1.2 m', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../config/jetson-follow-profile.json', import.meta.url)));
  const c = new UwbFollowController({ ...config.uwb_follow, following_distance_m: 2.5 });
  const telemetry = distanceM => ({ armed: true, flightMode: 'MANUAL', pilotSteering:{ready:true,type:0}, attitude: { yaw: 0, yawRateDegS: 0, updatedAt: 10000 },
    uwb: { online: true, fresh: true, updatedAt: 10000, measurementUpdatedAt: 10000, azimuthDeg: 0, distanceM,
      relativeXM: distanceM, relativeYM: 0, directControl:true, coordinateCalibration: { bearing_sign: 1, bearing_scale: 1, bearing_offset_deg: 0 } } });
  for (const distance of [.6, 1, 2, 2.5]) {
    c.reset(); const result = c.update({now:10000,telemetry:telemetry(distance),connected:true});
    assert.equal(result.safe,true,JSON.stringify(result));
    assert.equal(result.rangeErrorM,distance-2.5);
    assert.notEqual(result.pausePropulsion,true);
    assert.ok(result.throttlePercent <= 0, `${distance}m: ${JSON.stringify(result)}`);
  }
  c.reset();
  assert.ok(c.update({now:10000,telemetry:telemetry(4),connected:true}).throttlePercent>0);
});
