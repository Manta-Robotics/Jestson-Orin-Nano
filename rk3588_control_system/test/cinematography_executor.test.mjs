import test from 'node:test';
import assert from 'node:assert/strict';
import { CinematographyExecutor, composeCinemaGimbalRate } from '../backend/cinematography_executor.js';

const config = { bearing_sign: 1, bearing_scale: 1, bearing_offset_deg: 0, commissioning_speed_mps: 0.8,
  traditional_heading_gain: 1, range_deadband_m: 0.05, steering_slew_deg_s: 90 };
function telemetry(at, { range = 5, yaw = 0, azimuth = 0, rate = 0 } = {}) {
  return { armed: true, flightMode: 'MANUAL', pilotSteering: { ready: true, type: 0 },
    uwb: { measurementStatus: 'trusted', online: true, fresh: true, distanceM: range,
      azimuthDeg: azimuth, measurementUpdatedAt: at, sensors: [{ receiverId: 1, tagId: 7, valid: true }] },
    attitude: { yaw, yawRateDegS: rate, updatedAt: at } };
}
function decision(fields = {}) {
  return { intentId: 0, event: 'reselect', mode: 'relative_hold', radialMps: 0, tangentialMps: 0,
    yawDps: 1.5, pitchDps: 0.75, ...fields };
}
function step(controller, at, sample, t = telemetry(at), gimbalYawDeg = 0) {
  return controller.step({ connected: true, now: at, decisionAt: at - 15,
    telemetry: t, decision: sample, gimbalYawDeg });
}

test('relative hold follows UWB translation, uses IMU to preserve its compass offset and relatches only on reselection', () => {
  const c = new CinematographyExecutor(config);
  const d = decision();
  const first = step(c, 10000, d);
  assert.equal(first.safe, true); assert.equal(first.throttlePercent, 0);
  const held = step(c, 10100, { ...d, event: 'continue' }, telemetry(10100, { range: 5.5 }));
  assert.deepEqual(held.referenceOffsetNE, first.referenceOffsetNE);
  assert.ok(held.throttlePercent > 0); assert.equal(held.steeringDegrees, 0);
  // Boat turned right 90 degrees; the same tag remains north in the compass frame.
  const rotated = step(c, 10200, d, telemetry(10200, { range: 5.5, yaw: 90, azimuth: -90 }));
  assert.equal(rotated.throttlePercent, 0); assert.ok(rotated.steeringDegrees < 0);
  const relatched = step(c, 10300, { ...d, intentId: 1 }, telemetry(10300, { range: 5.5 }));
  assert.equal(relatched.referenceOffsetNE.north, -5.5);
  assert.equal(relatched.throttlePercent, 0);
});

test('signed tangential moves mirror in north/east and radial movement away turns the hull before advancing', () => {
  function run(radial, tangential) {
    const c = new CinematographyExecutor(config);
    const d = decision({ mode: 'move', radialMps: radial, tangentialMps: tangential });
    step(c, 10000, d);
    return step(c, 10100, { ...d, event: 'continue' });
  }
  const ccw = run(0, 0.8), clockwise = run(0, -0.8);
  assert.ok(ccw.referenceOffsetNE.east > 0 && ccw.steeringDegrees > 0);
  assert.ok(clockwise.referenceOffsetNE.east < 0 && clockwise.steeringDegrees < 0);
  assert.equal(ccw.throttlePercent, 0);
  assert.equal(run(0.8, 0).throttlePercent, 0);
  assert.ok(run(-0.8, 0).throttlePercent > 0);
});

test('onboard world hold stops the boat in place instead of latching a relative station', () => {
  const c = new CinematographyExecutor(config);
  const d = decision({ mode: 'world_hold' });
  const first = step(c, 10000, d);
  assert.equal(first.originalMode, 'world_hold'); assert.equal(first.executedMode, 'stop');
  assert.equal(first.safe, true); assert.equal(first.throttlePercent, 0);
  assert.equal(first.steeringDegrees, 0); assert.equal(first.referenceOffsetNE, null);
  // Continued and reselected world holds also stay stopped even as the swimmer moves.
  const followed = step(c, 10100, { ...d, event: 'continue' }, telemetry(10100, { range: 5.4 }));
  assert.equal(followed.executedMode, 'stop'); assert.equal(followed.throttlePercent, 0);
  assert.equal(followed.steeringDegrees, 0); assert.equal(followed.referenceOffsetNE, null);
  const renewed = step(c, 10200, { ...d, intentId: 1 }, telemetry(10200, { range: 5.4 }));
  assert.equal(renewed.executedMode, 'stop'); assert.equal(renewed.throttlePercent, 0);
});

test('gimbal headroom pivots without propelling the hull and releases hysteretically', () => {
  const c = new CinematographyExecutor(config), d = decision();
  step(c, 10000, d);
  const side = step(c, 10100, d, telemetry(10100), 125);
  assert.equal(side.reason, 'gimbal_headroom'); assert.ok(side.steeringDegrees > 0);
  assert.equal(side.throttlePercent, 0);
  assert.equal(step(c, 10200, d, telemetry(10200), 113).reason, 'gimbal_headroom');
  assert.equal(step(c, 10300, d, telemetry(10300), 109).reason, 'relative_hold');
});

test('legacy measurement clocks, integrity and calibrated bearing agree with board follow semantics', () => {
  const c = new CinematographyExecutor({ ...config, bearing_sign: -1, bearing_scale: 0.8, bearing_offset_deg: -5 });
  const t = telemetry(10000, { azimuth: 10 }); t.uwb.updatedAt = 10000; delete t.uwb.measurementUpdatedAt;
  const first = step(c, 10000, decision(), t);
  assert.equal(first.bearingDeg, -13);
  const reissued = telemetry(10100, { yaw: 10 }); reissued.uwb.measurementUpdatedAt = 10000;
  assert.deepEqual(step(c, 10100, decision(), reissued).actualOffsetNE, first.actualOffsetNE);
  const missing = { ...t, uwb: { ...t.uwb, measurementUpdatedAt: null, updatedAt: 10100 } };
  assert.equal(step(c, 10100, decision(), missing).reason, 'uwb_stale');
  t.uwb.updatedAt = 9950;
  assert.equal(step(c, 10100, decision(), t).reason, 'uwb_clock_reversed');
});

test('live supervision vetoes raw near range, invalid range, stale measurements or policy, identity change and FCU loss', () => {
  for (const [reason, change] of [
    ['uwb_stale', t => { t.uwb.measurementUpdatedAt -= 1000; }],
    ['uwb_stale', t => { t.uwb.distanceM = null; }],
    ['uwb_untrusted', t => { t.uwb.sensors[0].occlusionDiagnostics = { state: 'recovering' }; }],
    ['holding_distance', t => { Object.assign(t.uwb.sensors[0], { rawDistanceM: 2.9, rawDistanceUpdatedAt: 10200 }); }],
    ['holding_distance', t => { t.uwb.distanceM = 3.1; }],
    ['imu_stale', t => { t.attitude.updatedAt -= 1000; }],
    ['target_identity_changed', t => { t.uwb.sensors[0].tagId = 8; }],
    ['armed_required', t => { t.armed = false; }],
    ['manual_required', t => { t.flightMode = 'AUTO'; }],
    ['pilot_steering_not_ready', t => { t.pilotSteering.ready = false; }]
  ]) {
    const c = new CinematographyExecutor(config);
    const d = decision({ mode: 'move', radialMps: -0.8 });
    step(c, 10000, d); assert.ok(step(c, 10100, d).throttlePercent > 0);
    const t = telemetry(10200);
    change(t);
    const output = step(c, 10200, d, t);
    assert.equal(output.reason, reason); assert.equal(output.safe, false);
    assert.equal(output.throttlePercent, 0); assert.equal(output.steeringDegrees, 0);
  }
  const c = new CinematographyExecutor(config);
  assert.equal(c.step({ now: 12000, decisionAt: 10000, decision: decision(), connected: true,
    telemetry: telemetry(12000) }).reason, 'decision_unavailable');
  assert.equal(step(c, 10000, decision({ yawDps: NaN })).reason, 'decision_unavailable');
});

test('recovery takes precedence before crossing far limit and never changes the policy decision', () => {
  const c = new CinematographyExecutor(config);
  const d = Object.freeze(decision({ mode: 'relative_hold' }));
  step(c, 10000, d, telemetry(10000, { range: 8.5 }));
  const result = step(c, 10100, d, telemetry(10100, { range: 8.91 }));
  assert.equal(result.reason, 'recovering_range'); assert.ok(result.throttlePercent > 0);
  assert.equal(result.gimbalPitchResidualDegS, d.pitchDps);
});

test('image-servo plus policy honors absolute and rate paths, bounded axes, feedback age and dry-run', () => {
  const feedback = { updatedAt: 10000, checksumValid: true, yawDeg: 20, pitchDeg: 5 };
  const execution = { safe: true, gimbalYawResidualDegS: 1.5, gimbalPitchResidualDegS: 1 };
  const limits = { yawMinDeg: -135, yawMaxDeg: 135, pitchMinDeg: 0, pitchMaxDeg: 90 };
  const compose = (base, f = feedback, e = execution) => composeCinemaGimbalRate({ now: 10000, base,
    feedback: f, execution: e, axis: { max_rate_dps: 30 }, beacon: { yaw_gain: 2, pitch_gain: 3 }, limits });
  const image = compose({ x: 4, y: 2, gated: false, stale: false });
  assert.equal(image.x, 5.5); assert.equal(image.y, 1);
  const centered = compose({ x: 0, y: 0, gated: true, stale: false });
  assert.equal(centered.x, 1.5); assert.equal(centered.y, -1);
  const beacon = compose({ absoluteAngle: true, commandYawDeg: 25, commandPitchDeg: 10 });
  assert.equal(beacon.x, 11.5); assert.equal(beacon.y, 14);
  assert.equal(compose({ x: 3, y: 0 }, { ...feedback, yawDeg: 135, pitchDeg: 0 }).x, 0);
  assert.equal(compose({ x: 3, y: 0 }, { ...feedback, yawDeg: 135, pitchDeg: 0 }).y, 0);
  assert.equal(compose({ x: 3, y: 0, dryRun: true }).x, 0);
  assert.equal(compose({ x: 3, y: 0, stale: true }).y, 0);
  assert.equal(compose({ x: 3, y: 0 }, { ...feedback, updatedAt: 9800, checksumValid: false }).x, 0);
  assert.equal(compose({ x: 3, y: 0 }, { ...feedback, updatedAt: 9500 }).reason, 'gimbal_feedback_stale');
});
