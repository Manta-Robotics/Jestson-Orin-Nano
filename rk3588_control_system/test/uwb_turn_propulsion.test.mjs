import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { UwbFollowController } from '../backend/uwb_follow.js';
import { TraditionalManualPropulsion } from '../backend/traditional_manual_propulsion.js';
import { IntermittentUwbFollow } from '../backend/uwb_target_prediction.js';

const config = { execution_mode: 'relative_imu', bearing_sign: 1, bearing_scale: 1, bearing_offset_deg: 0,
  following_distance_m: 0.5, safety_distance_m: 0.3, relative_throttle_limit_percent: 70,
  relative_min_effective_throttle_percent: 35, minimum_throttle_range_error_m: 0.4,
  relative_throttle_accel_percent_s: 30, relative_throttle_decel_percent_s: 45,
  relative_steering_limit_deg: 18, max_yaw_rate_deg_s: 14, max_speed_mps: 2,
  prediction: { measurement_noise_m: 0.12, braking_deceleration_mps2: 0.3 },
  arc_follow: { enabled: true, max_speed_mps: 0.3 } };
const telemetry = (now, bearing, distance = 3.3, gpsSpeed = null) => ({
  armed: true, flightMode: 'MANUAL', pilotSteering: { ready: true, type: 3 },
  attitude: { yaw: 0, yawRateDegS: 0, updatedAt: now },
  gps: { fixType: gpsSpeed === null ? 0 : 3, updatedAt: now },
  position: { updatedAt: now }, ekf: { healthy: true, updatedAt: now },
  velocity: { vx: gpsSpeed, vy: gpsSpeed === null ? null : 0 },
  uwb: { online: true, fresh: true, controlSource: 'raw', distanceM: distance, azimuthDeg: bearing,
    measurementStatus: 'trusted', measurementUpdatedAt: now, streamId: 'turn', activeReceiverIds: [1],
    sensors: [{ receiverId: 1, tagId: 5565 }] }
});

// Exercise the production sender through its real normalization, intermittent
// governor, motor limiter and ROVER_DRIVE packet construction, without hardware.
function sender(controller) {
  const source = fs.readFileSync(new URL('../backend/server.js', import.meta.url), 'utf8');
  const functions = [
    source.slice(source.indexOf('function normalizeRoverControl('), source.indexOf('let lastRoverCommandAt')),
    source.slice(source.indexOf('function sendManualRoverOutput('), source.indexOf('function applyRoverControl(')),
    source.slice(source.indexOf('function sendUwbRelativeDrive('), source.indexOf('function holdOutputsAreNeutral('))
  ].join('\n');
  let now = 1000;
  const calls = [];
  const propulsion = new TraditionalManualPropulsion({ steering_slew_deg_s: 9,
    throttle_accel_percent_s: 30, throttle_decel_percent_s: 45 });
  propulsion.reset(900);
  const box = { traditionalManualPropulsion: propulsion, intermittentUwbFollow: new IntermittentUwbFollow(),
    uwbFollowController: controller, lastRoverCommandAt: 0, manualRoverSource: 'WEB',
    PWM_CENTER: 1500, PWM_MIN: 1000, PWM_MAX: 2000, ROVER_THROTTLE_MIN: -100, ROVER_THROTTLE_MAX: 100,
    ROVER_MANUAL_THROTTLE_LIMIT: 100, ROVER_STEERING_MIN: -45, ROVER_STEERING_MAX: 45,
    ROVER_MANUAL_STEERING_LIMIT: 45, ROVER_CONTROL_PROTOCOL: 'manual_control', ROVER_LEFT_CHANNEL: 1, ROVER_RIGHT_CHANNEL: 3,
    Date: class extends Date { static now() { return now; } },
    systemState: { isConnected: true, telemetry: {}, motorStatus: {} }, io: { emit() {} }, emitDashboardState() {},
    forceNeutralRoverControl() {}, asFiniteNumber: (v, f) => Number.isFinite(Number(v)) ? Number(v) : f,
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)), toPwm: v => Math.round(Math.max(1000, Math.min(2000, v))),
    sendMavlinkCommand: (command, params) => calls.push({ command, params }) };
  const context = vm.createContext(box);
  vm.runInContext(functions, context);
  return { calls, drive(result, t, at) {
    now = at; box.input = result; box.systemState.telemetry = t;
    return vm.runInContext('sendUwbRelativeDrive(input)', context);
  } };
}

function settle(bearing, distance = 3.3, extraConfig = {}, gpsSpeed = null, source = 'raw') {
  const c = new UwbFollowController({ ...config, ...extraConfig });
  const wire = sender(c);
  let result, output;
  for (let now = 1000; now <= 5000; now += 100) {
    const t = telemetry(now, bearing, distance, gpsSpeed);
    t.uwb.controlSource = source;
    if (source !== 'raw') t.uwb.directControl = true;
    result = c.update({ now, telemetry: t, connected: true });
    output = wire.drive(result, t, now);
  }
  return { c, result, output, wire };
}

test('55 through 90 degrees on either side produce bounded forward motor demands with the original forward follower', () => {
  for (const sign of [-1, 1]) for (const magnitude of [55, 60, 80.7, 85, 89.99, 90]) {
    const { result: r, output, wire } = settle(sign * magnitude);
    assert.notEqual(r.planner, 'radius_arc');
    assert.equal(r.frontTurn.active, true);
    assert.ok(r.frontTurn.speedReferenceMps <= 0.3);
    assert.equal(r.frontTurn.minimumThrottlePercent, 35);
    assert.equal(output.throttle, 35);
    assert.ok(output.leftPwm > 1500 && output.rightPwm > 1500, `${sign * magnitude}: ${JSON.stringify(output)}`);
    assert.equal(Math.sign(output.steering), sign);
    assert.ok(Math.abs(output.steering) <= output.throttle * 0.45 * 0.8 + 1e-9);
    assert.equal(wire.calls.at(-1).command, 'ROVER_DRIVE');
    assert.equal(wire.calls.at(-1).params.motorTargetSemantics, true);
  }
});

test('rear arcs use the configured effective thrust instead of stalling at the old 9.84 percent model request', () => {
  for (const bearing of [-179, -150, -120, -90.01, 90.01, 120, 150, 179]) {
    const { result: r, output } = settle(bearing);
    assert.equal(r.planner, 'radius_arc');
    assert.equal(r.arcFollow.minimumThrottlePercent, 35);
    assert.equal(r.arcFollow.speedReferenceMps, 0.3);
    assert.equal(output.throttle, 35);
    assert.ok(output.leftPwm > 1500 && output.rightPwm > 1500);
    assert.ok(Math.abs(r.yawRateDegS) <= 14);
  }
});

test('the deployed smoothed direct-control path also delivers effective thrust in front and rear', () => {
  for (const bearing of [-140, -80.7, 80.7, 140]) {
    const { result: r, output } = settle(bearing, 3.3, {}, null, 'position_kalman');
    assert.equal(output.throttle, 35);
    assert.ok(output.leftPwm > 1500 && output.rightPwm > 1500);
    assert.equal(r.planner === 'radius_arc', Math.abs(bearing) > 90);
  }
});

test('turn floor fades near the 0.5m stand-off and both turn modes immediately stop at that distance', () => {
  for (const bearing of [-120, -80, 80, 120]) {
    const far = settle(bearing).result;
    const near = settle(bearing, 0.8).result;
    const minimum = r => (r.arcFollow || r.frontTurn).minimumThrottlePercent;
    assert.ok(minimum(near) < minimum(far));
    const { c, wire } = settle(bearing);
    const t = telemetry(5100, bearing, 0.5);
    const stop = c.update({ now: 5100, telemetry: t, connected: true });
    const output = wire.drive(stop, t, 5100);
    assert.equal(stop.reason, 'holding_distance');
    assert.equal(stop.holdingDistanceM, 0.5);
    assert.equal(output.throttle, 0); assert.equal(output.steering, 0);
    assert.equal(output.leftPwm, 1500); assert.equal(output.rightPwm, 1500);
  }
});

test('braking and prediction cannot receive a minimum-thrust boost', () => {
  for (const bearing of [80, 120]) {
    const { c } = settle(bearing);
    c.update({ now: 5100, telemetry: telemetry(5100, bearing, 3.0), connected: true });
    const braking = c.update({ now: 5200, telemetry: telemetry(5200, bearing, 2.7), connected: true });
    assert.equal(braking.brakingActive, true);
    assert.equal((braking.arcFollow || braking.frontTurn).minimumThrottlePercent, 0);
    assert.ok(braking.throttlePercent < 35);
    const predicted = new UwbFollowController(config).update({ now: 1000, telemetry: telemetry(1000, bearing),
      connected: true, targetMotionEstimate: { source: 'predicted' } });
    assert.equal((predicted.arcFollow || predicted.frontTurn).minimumThrottlePercent, 0);
  }
});

test('GPS speed feedback retains its speed cap and never applies the GPS-free thrust floor', () => {
  for (const bearing of [80, 120]) {
    const { result: r, output } = settle(bearing, 3.3, { gps_speed_closed_loop: { enabled: true, acquire_ms: 0 } }, 0.6);
    assert.equal(r.gpsSpeedControlActive, true);
    assert.equal((r.arcFollow || r.frontTurn).minimumThrottlePercent, 0);
    assert.equal(output.throttle, 0);
    assert.equal(output.steering, 0);
  }
});

test('wide-angle changes remain within actuator slew and do not introduce a zero-output gap at 90 degrees', () => {
  const { c, wire } = settle(80);
  let previous = 35;
  for (const [i, bearing] of [85, 89.99, 90, 90.01, 110, 89, -90.01, -89].entries()) {
    const now = 5100 + i * 100, t = telemetry(now, bearing);
    const r = c.update({ now, telemetry: t, connected: true });
    const out = wire.drive(r, t, now);
    assert.ok(out.throttle > 0);
    assert.ok(Math.abs(out.throttle - previous) <= 4.5 + 1e-9);
    assert.equal(r.planner === 'radius_arc', Math.abs(bearing) > 90);
    assert.ok(out.leftPwm >= 1500 && out.rightPwm >= 1500);
    previous = out.throttle;
  }
});

test('aligned original following is unchanged, and disabling rear-arc mode restores its original angle gate', () => {
  for (const bearing of [-30, 0, 30]) {
    const a = new UwbFollowController(config);
    const b = new UwbFollowController({ ...config, arc_follow: { enabled: false } });
    for (let now = 1000; now <= 3000; now += 100) {
      const input = { now, telemetry: telemetry(now, bearing), connected: true };
      assert.deepEqual(a.update(input), b.update(input));
    }
  }
  assert.equal(settle(80, 3.3, { arc_follow: { enabled: false } }).output.throttle, 0);
});

test('sensor, mode and arming faults stop both turn modes even after effective thrust is active', () => {
  for (const bearing of [80, 120]) for (const fault of [t => { t.uwb.online = false; },
    t => { t.attitude.updatedAt = 0; }, t => { t.flightMode = 'HOLD'; }, t => { t.armed = false; }]) {
    const { c } = settle(bearing);
    const t = telemetry(5100, bearing); fault(t);
    const r = c.update({ now: 5100, telemetry: t, connected: true });
    assert.equal(r.safe, false); assert.equal(r.throttlePercent, 0); assert.equal(r.steeringDegrees, 0);
  }
});
