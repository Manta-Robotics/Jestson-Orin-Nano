import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RadiusArcGuidance, circleTangentCandidate } from '../backend/uwb_arc_follow.js';
import { UwbFollowController } from '../backend/uwb_follow.js';
import { TraditionalDualMotorLimiter } from '../backend/traditional_dual_motor.js';
import { validateSystemConfig as validateConfig } from '../scripts/validate_config.mjs';

const RAD = Math.PI / 180;
const config = { execution_mode: 'relative_imu', bearing_sign: 1, bearing_scale: 1, bearing_offset_deg: 0,
  following_distance_m: 2.5, safety_distance_m: 0.3, range_deadband_m: 0.12,
  relative_throttle_limit_percent: 70, relative_steering_limit_deg: 18, max_yaw_rate_deg_s: 14,
  max_speed_mps: 2, commissioning_speed_mps: 2,
  prediction: { measurement_noise_m: 0.12, braking_deceleration_mps2: 0.3 },
  arc_follow: { enabled: true, radius_m: 1.5, max_speed_mps: 0.3 } };
const telemetry = (now, bearing = 0, distance = 6) => ({ armed: true, flightMode: 'MANUAL',
  gps: { fixType: 0 }, attitude: { yaw: 0, yawRateDegS: 0, updatedAt: now },
  pilotSteering: { ready: true, type: 0 },
  uwb: { online: true, fresh: true, distanceM: distance, azimuthDeg: bearing,
    measurementStatus: 'trusted', measurementUpdatedAt: now, streamId: 'test', sensors: [{ receiverId: 1, tagId: 5565 }] } });

test('full-circle candidates respect R=1.5m and meet the straight segment tangentially', () => {
  for (const bearing of [-180, -179, -150, -90, -20, 0, 20, 90, 150, 179, 180]) {
    const goal = { x: 6 * Math.cos(bearing * RAD), y: 6 * Math.sin(bearing * RAD) };
    for (const sign of [-1, 1]) {
      const p = circleTangentCandidate(goal, 1.5, sign);
      assert.ok(p);
      const rx = p.tangent.x - p.center.x, ry = p.tangent.y - p.center.y;
      const dx = goal.x - p.tangent.x, dy = goal.y - p.tangent.y;
      assert.ok(Math.abs(Math.hypot(rx, ry) - 1.5) < 1e-9);
      assert.ok(Math.abs(rx * dx + ry * dy) < 1e-8);
      assert.ok(sign * (-ry * dx + rx * dy) >= -1e-8, 'the tangent must point forwards');
      assert.ok(p.angleRad >= 0 && p.angleRad < 2 * Math.PI);
    }
  }
});

test('an inside-circle target rejects that tangent and uses the feasible opposite arc', () => {
  assert.equal(circleTangentCandidate({ x: 0, y: 1 }, 1.5, 1), null);
  const p = new RadiusArcGuidance({ radius_m: 1.5 }).plan(1, 90, 0.2);
  assert.equal(p.side, 'left');
  assert.ok(p.remainingM > 0);
});

test('arrival truncation never routes an arc through the follow-distance circle', () => {
  for (const distance of [2.7, 4, 8]) for (let bearing = -180; bearing <= 180; bearing += 5) {
    const p = new RadiusArcGuidance({ radius_m: 1.5 }).plan(distance, bearing, 2.5);
    assert.ok(p?.active, `${distance},${bearing}`);
    if (p.state === 'straight') {
      assert.equal(p.curvatureMInv, 0);
      assert.equal(p.remainingM, distance - 2.5);
      continue;
    }
    for (let i = 0; i <= 100; i++) {
      const phi = -p.sign * Math.PI / 2 + p.sign * p.angleRad * i / 100;
      const point = { x: 1.5 * Math.cos(phi), y: p.center.y + 1.5 * Math.sin(phi) };
      assert.ok(Math.hypot(point.x - p.goal.x, point.y - p.goal.y) >= 2.5 - 1e-8);
    }
    assert.ok(Math.abs(p.curvatureMInv) <= 1 / 1.5 + 1e-12);
  }
});

test('the rear wrap boundary keeps the selected turn side through small bearing noise', () => {
  const g = new RadiusArcGuidance({ radius_m: 1.5, side_switch_margin_m: 0.6 });
  const side = g.plan(6, 179.5, 2.5).side;
  for (const bearing of [-179.5, 179.8, -179.9, 180]) assert.equal(g.plan(6, bearing, 2.5).side, side);
});

test('continuous replanning reaches front, side and rear targets while obeying the curvature bound', () => {
  for (const bearing of [-180, -120, -60, 0, 60, 120, 180]) {
    const g = new RadiusArcGuidance({ radius_m: 1.5 });
    const goal = { x: 6 * Math.cos(bearing * RAD), y: 6 * Math.sin(bearing * RAD) };
    let x = 0, y = 0, yaw = 0, distance = 6;
    for (let i = 0; i < 2400 && distance > 2.52; i++) {
      const dx = goal.x - x, dy = goal.y - y;
      const body = { x: dx * Math.cos(yaw) + dy * Math.sin(yaw), y: -dx * Math.sin(yaw) + dy * Math.cos(yaw) };
      const p = g.plan(distance, Math.atan2(body.y, body.x) / RAD, 2.5,
        { now: i * 100, measurementUpdatedAt: i * 100 });
      assert.ok(p?.active);
      assert.ok(Math.abs(p.curvatureMInv) <= 1 / 1.5 + 1e-9);
      const delta = 0.3 * 0.1, turn = delta * p.curvatureMInv;
      x += delta * Math.cos(yaw + turn / 2); y += delta * Math.sin(yaw + turn / 2); yaw += turn;
      distance = Math.hypot(goal.x - x, goal.y - y);
    }
    assert.ok(distance <= 2.52, `bearing ${bearing}: distance ${distance}`);
  }
});

test('production controller recovers rear targets with same-direction differential thrust and no pivot', () => {
  for (const bearing of [-180, -120, 120, 180]) {
    const controller = new UwbFollowController({ ...config, relative_nmpc: { enabled: true } });
    const limiter = new TraditionalDualMotorLimiter({ throttle_limit: 70, steering_limit: 18 });
    let r;
    for (let now = 1000; now <= 5000; now += 100) {
      r = controller.update({ now, telemetry: telemetry(now, bearing), connected: true });
      assert.equal(r.planner, 'radius_arc');
      assert.equal(r.safe, true);
      assert.ok(r.throttlePercent > 0, `${bearing}: stalled behind the old 55 degree gate`);
      assert.ok(Math.abs(r.steeringDegrees) <= r.throttlePercent * 0.45 * 0.8 + 1e-9);
      limiter.setTarget({ throttle: r.throttlePercent, steering: r.steeringDegrees });
      limiter.step(now);
      assert.ok(limiter.motors.left >= 0 && limiter.motors.right >= 0);
      assert.ok(limiter.motors.left <= 70 && limiter.motors.right <= 70);
      controller.relativeImuControl.trackApplied(r.throttlePercent, r.steeringDegrees);
    }
    assert.equal(r.arcFollow.radiusM, 1.5);
    assert.equal(r.arcFollow.radiusEstimated, true);
    assert.equal(r.absoluteSpeedObservable, false);
    assert.equal(r.forwardSpeedMps, null);
    assert.ok(r.desiredSpeedMps <= 0.3);
    assert.ok(Math.abs(r.yawRateDegS) <= 14);
  }
});

test('range hold, stale UWB, invalid IMU, disarm and wrong mode retain their existing stops', () => {
  const c = new UwbFollowController(config);
  let r;
  for (let now = 1000; now <= 5000; now += 100) r = c.update({ now, telemetry: telemetry(now, 120), connected: true });
  r = c.update({ now: 5100, telemetry: telemetry(5100, 120, 2.4), connected: true });
  assert.equal(r.reason, 'holding_distance');
  assert.equal(r.throttlePercent, 0); assert.equal(r.steeringDegrees, 0);
  for (const [fault, reason] of [
    [t => { t.uwb.online = false; }, 'uwb_stale'],
    [t => { t.attitude.updatedAt = 0; }, 'imu_stale'],
    [t => { t.armed = false; }, 'armed_required'],
    [t => { t.flightMode = 'HOLD'; }, 'manual_required']
  ]) {
    const t = telemetry(6000, 180); fault(t);
    r = c.update({ now: 6000, telemetry: t, connected: true });
    assert.equal(r.safe, false); assert.equal(r.reason, reason);
    assert.equal(r.throttlePercent, 0); assert.equal(r.steeringDegrees, 0);
  }
});

test('GPS speed changes the radius reference to measured speed and drops back on loss', () => {
  const c = new UwbFollowController({ ...config, gps_speed_closed_loop: { enabled: true, acquire_ms: 1000 } });
  let r;
  for (let now = 1000; now <= 2500; now += 100) {
    const t = telemetry(now, 120);
    Object.assign(t, { gps: { fixType: 3, updatedAt: now }, ekf: { healthy: true, updatedAt: now },
      position: { updatedAt: now }, velocity: { vx: 0.2, vy: 0 } });
    r = c.update({ now, telemetry: t, connected: true });
  }
  assert.equal(r.arcFollow.radiusEstimated, false);
  assert.equal(r.absoluteSpeedObservable, true);
  assert.ok(Math.abs(r.yawRateDegS - 0.2 / 1.5 / RAD) < 1e-8);
  r = c.update({ now: 2600, telemetry: telemetry(2600, 120), connected: true });
  assert.equal(r.arcFollow.radiusEstimated, true);
  assert.equal(r.measuredForwardSpeedMps, null);
});

test('arc config rejects invalid radii, non-periodic calibration and incompatible execution', () => {
  const baseline = JSON.parse(fs.readFileSync(new URL('../config/system.config.json', import.meta.url)));
  Object.assign(baseline.uwb_follow, config);
  assert.deepEqual(validateConfig(baseline), []);
  for (const radius of [0, -1, NaN, Infinity, 21]) {
    const d = structuredClone(baseline); d.uwb_follow.arc_follow.radius_m = radius;
    assert.ok(validateConfig(d).some(e => e.includes('arc_follow.radius_m')));
  }
  const scaled = structuredClone(baseline); scaled.uwb_follow.bearing_scale = 0.8148;
  assert.ok(validateConfig(scaled).some(e => e.includes('periodic')));
  const incompatible = structuredClone(baseline); incompatible.uwb_follow.execution_mode = 'acro';
  assert.ok(validateConfig(incompatible).some(e => e.includes('Arc follow requires')));
});
