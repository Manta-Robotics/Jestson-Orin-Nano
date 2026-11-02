import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RadiusArcGuidance, ARC_FOLLOW_DEFAULTS } from '../backend/uwb_arc_follow.js';
import { UwbFollowController } from '../backend/uwb_follow.js';
import { validateSystemConfig } from '../scripts/validate_config.mjs';

const obs = (now, extra = {}) => ({ now, measurementUpdatedAt: now, measuredYawRateDegS: 0, ...extra });
const plan = (g, now, bearing, distance = 6, extra = {}) => g.plan(distance, bearing, 2.5, obs(now, extra));

test('a turn stays locked through changing targets and advantages above the old 0.6m margin', () => {
  const g = new RadiusArcGuidance();
  let p = plan(g, 1000, 179);
  assert.equal(p.state, 'right_arc');
  const tangent = p.tangent;
  for (let now = 1100; now <= 8000; now += 100) {
    p = plan(g, now, now % 200 ? -170 : 175, now % 200 ? 7 : 6);
    assert.equal(p.lockedSide, 'right');
    assert.equal(p.state, 'right_arc');
    assert.ok(p.curvatureMInv >= 0);
  }
  assert.notDeepEqual(p.tangent, tangent, 'the live tangent continues to update inside the lock');
});

test('switching requires minimum lock time, sustained advantage and distinct observations', () => {
  const g = new RadiusArcGuidance();
  plan(g, 1000, 170);
  for (let now = 1100; now < 3000; now += 100) assert.equal(plan(g, now, -140).lockedSide, 'right');
  let p = plan(g, 3000, -140);
  assert.equal(p.transitionPending.samples, 1);
  for (let now = 3010; now <= 3500; now += 10) {
    p = plan(g, now, -140, 6, { measurementUpdatedAt: 3000 });
    assert.equal(p.lockedSide, 'right');
    assert.equal(p.transitionPending.samples, 1);
  }
  for (let now = 3600; now < 4500; now += 100) assert.equal(plan(g, now, -140).lockedSide, 'right');
  p = plan(g, 4500, -140);
  assert.equal(p.lockedSide, 'left');
  assert.equal(p.transitionReason, 'sustained_side_advantage');
  for (let now = 4600; now < 6500; now += 100) assert.equal(plan(g, now, 140).lockedSide, 'left');
});

test('both sample count and elapsed measurement time are required for a switch', () => {
  const slow = new RadiusArcGuidance();
  plan(slow, 1000, 170);
  for (const now of [3000, 3600, 4200, 4800, 5400, 6000, 6600]) {
    assert.equal(plan(slow, now, -140).lockedSide, 'right');
  }
  assert.equal(plan(slow, 7200, -140).lockedSide, 'left');
  const fast = new RadiusArcGuidance();
  plan(fast, 1000, 170);
  for (let now = 3000; now <= 3100; now++) assert.equal(plan(fast, now, -140).lockedSide, 'right');
});

test('interrupted advantage, prediction, old samples and measurement gaps break confirmation', () => {
  for (const interrupt of [
    g => plan(g, 3600, 170),
    g => plan(g, 3600, -140, 6, { observed: false }),
    g => plan(g, 3600, -140, 6, { measurementUpdatedAt: 3400 }),
    g => plan(g, 4300, -140),
    g => plan(g, 3600, -140, 6, { measurementUpdatedAt: 3700 }),
    g => plan(g, 4300, -140, 6, { measurementUpdatedAt: 3500 })
  ]) {
    const g = new RadiusArcGuidance();
    plan(g, 1000, 170);
    for (let now = 3000; now <= 3500; now += 100) plan(g, now, -140);
    interrupt(g);
    for (let now = 4400; now <= 5700; now += 100) assert.equal(plan(g, now, -140).lockedSide, 'right');
  }
});

test('arc exit requires near tangent, forward alignment, settled yaw and stable measurements', () => {
  const g = new RadiusArcGuidance();
  plan(g, 1000, 90);
  for (let now = 1100; now <= 2000; now += 100) {
    assert.equal(plan(g, now, 2, 6, { measuredYawRateDegS: 8 }).state, 'right_arc');
  }
  plan(g, 2100, 2);
  for (let now = 2110; now <= 2500; now += 10) {
    assert.equal(plan(g, now, 2, 6, { measurementUpdatedAt: 2100 }).state, 'right_arc');
  }
  assert.equal(plan(g, 2600, 2).state, 'right_arc', 'two observations cannot complete exit');
  for (let now = 2700; now <= 2900; now += 100) plan(g, now, 2);
  const p = plan(g, 3000, 2);
  assert.equal(p.state, 'straight');
  assert.equal(p.lockedSide, null);
  assert.equal(p.curvatureMInv, 0);
});

test('tangent overshoot does not request a new revolution or reverse the locked turn', () => {
  for (const sign of [-1, 1]) {
    const g = new RadiusArcGuidance();
    plan(g, 1000, sign * 90);
    for (let now = 1100; now < 1600; now += 100) {
      const p = plan(g, now, -sign * 2);
      assert.equal(p.state, sign > 0 ? 'right_arc' : 'left_arc');
      assert.equal(p.curvatureMInv, 0);
      assert.equal(p.arcLengthM, 0);
      assert.equal(p.angleRad, 0);
    }
    assert.equal(plan(g, 1600, -sign * 2).state, 'straight');
  }
});

test('straight approach filters bearing noise and confirms the side of the next arc', () => {
  const g = new RadiusArcGuidance();
  assert.equal(plan(g, 1000, 0).state, 'straight');
  for (let now = 1100; now <= 3000; now += 100) {
    const p = plan(g, now, now % 200 ? -10 : 10);
    assert.equal(p.state, 'straight');
    assert.equal(p.curvatureMInv, 0);
  }
  for (let now = 3100; now < 3600; now += 100) assert.equal(plan(g, now, -40).state, 'straight');
  assert.equal(plan(g, 3600, -40).state, 'left_arc');
});

test('invalid locked routes stop and require a settled, confirmed replan', () => {
  const g = new RadiusArcGuidance();
  g.plan(6, 90, 0.2, obs(1000));
  for (let now = 1100; now <= 1500; now += 100) {
    const p = g.plan(1, 90, 0.2, obs(now, { canReplan: false }));
    assert.equal(p.state, 'replan'); assert.equal(p.active, false);
    assert.equal(p.lockedSide, 'right'); assert.equal(p.curvatureMInv, 0);
  }
  for (let now = 1600; now < 2100; now += 100) assert.equal(g.plan(1, 90, 0.2, obs(now)).active, false);
  const p = g.plan(1, 90, 0.2, obs(2100));
  assert.equal(p.state, 'left_arc'); assert.equal(p.active, true);
  assert.equal(p.transitionReason, 'locked_route_invalid');
});

test('a transient invalid route cannot flip sides or immediately resume propulsion', () => {
  const g = new RadiusArcGuidance();
  g.plan(6, 90, 0.2, obs(1000));
  g.plan(1, 90, 0.2, obs(1100));
  for (let now = 1200; now < 1700; now += 100) assert.equal(g.plan(6, 90, 0.2, obs(now)).active, false);
  const p = g.plan(6, 90, 0.2, obs(1700));
  assert.equal(p.state, 'right_arc');
  assert.equal(p.transitionReason, 'locked_route_recovered');
});

test('hold, explicit reset and clock regression discard the previous turn lock', () => {
  const g = new RadiusArcGuidance();
  plan(g, 1000, 90);
  assert.equal(plan(g, 1100, 90, 2.4).state, 'holding');
  assert.equal(plan(g, 1200, -90).lockedSide, 'left');
  g.reset();
  assert.equal(plan(g, 1300, 90).lockedSide, 'right');
  assert.equal(plan(g, 500, -90).lockedSide, 'left');
});

const config = { execution_mode: 'relative_imu', bearing_sign: 1, bearing_scale: 1, bearing_offset_deg: 0,
  following_distance_m: 0.2, safety_distance_m: 0.1, relative_throttle_limit_percent: 70,
  arc_follow: { enabled: true } };
const telemetry = (now, bearing = 120, distance = 6) => ({ armed: true, flightMode: 'MANUAL',
  gps: { fixType: 0 }, attitude: { yaw: 0, yawRateDegS: 0, updatedAt: now }, pilotSteering: { ready: true, type: 0 },
  uwb: { online: true, fresh: true, controlSource: 'raw', distanceM: distance, azimuthDeg: bearing, measurementUpdatedAt: now,
    streamId: 'test', sensors: [{ receiverId: 1, tagId: 5565 }] } });

test('aligned forward following keeps the original method and the wide-angle region stays outside the arc', () => {
  for (const bearing of [-40, -20, 0, 20, 40]) {
    const hybrid = new UwbFollowController(config);
    const original = new UwbFollowController({ ...config, arc_follow: { enabled: false } });
    for (let now = 1000; now <= 2000; now += 100) {
      const input = { now, telemetry: telemetry(now, bearing), connected: true };
      assert.deepEqual(hybrid.update(input), original.update(input), `bearing ${bearing}, time ${now}`);
    }
    assert.equal(hybrid.relativeImuControl.arcActive, false);
  }
});

test('only bearings strictly outside forward +/-90 degrees activate the locked arc', () => {
  for (const bearing of [-180, -120, -90.01, 90.01, 120, 180]) {
    const c = new UwbFollowController(config);
    const r = c.update({ now: 1000, telemetry: telemetry(1000, bearing), connected: true });
    assert.equal(r.planner, 'radius_arc');
    assert.ok(r.arcFollow.lockedSide);
    assert.equal(c.relativeImuControl.arcActive, true);
  }
  const c = new UwbFollowController({ ...config, bearing_sign: -1, bearing_offset_deg: 30 });
  assert.equal(c.update({ now: 1000, telemetry: telemetry(1000, -70), connected: true }).planner, 'radius_arc');
  assert.notEqual(c.update({ now: 1100, telemetry: telemetry(1100, -60), connected: true }).planner, 'radius_arc');
});

test('entering the forward half-plane immediately releases the arc and permits a later new turn', () => {
  const c = new UwbFollowController(config);
  for (let now = 1000; now <= 2000; now += 100) c.update({ now, telemetry: telemetry(now), connected: true });
  let r = c.update({ now: 2100, telemetry: telemetry(2100, 90), connected: true });
  assert.notEqual(r.planner, 'radius_arc');
  assert.equal(r.arcFollow, undefined);
  assert.equal(c.relativeImuControl.arcControl.guidance.side, 0);
  r = c.update({ now: 2200, telemetry: telemetry(2200, 0), connected: true });
  assert.equal(r.yawRateDegS, 0);
  r = c.update({ now: 2300, telemetry: telemetry(2300, -120), connected: true });
  assert.equal(r.arcFollow.lockedSide, 'left');
  r = c.update({ now: 2400, telemetry: telemetry(2400, -90), connected: true });
  assert.notEqual(r.planner, 'radius_arc');
  assert.equal(c.relativeImuControl.arcActive, false);
});

test('handover carries the last outputs into the existing slew limits in both directions', () => {
  const c = new UwbFollowController(config);
  let r;
  for (let now = 1000; now <= 3000; now += 100) r = c.update({ now, telemetry: telemetry(now, 0), connected: true });
  const beforeArc = r.throttlePercent;
  r = c.update({ now: 3100, telemetry: telemetry(3100, 120), connected: true });
  assert.equal(r.planner, 'radius_arc');
  assert.ok(Math.abs(r.throttlePercent - beforeArc) <= c.config.throttleDecelPercentS * 0.1 + 1e-9);
  const beforeFront = r.throttlePercent;
  r = c.update({ now: 3200, telemetry: telemetry(3200, 0), connected: true });
  assert.notEqual(r.planner, 'radius_arc');
  assert.ok(Math.abs(r.throttlePercent - beforeFront) <= c.config.throttleAccelPercentS * 0.1 + 1e-9);
});

test('a target returning to the forward half-plane cancels a pending rear replan', () => {
  const c = new UwbFollowController(config);
  c.update({ now: 1000, telemetry: telemetry(1000), connected: true });
  assert.equal(c.update({ now: 1100, telemetry: telemetry(1100, 120, 1), connected: true }).reason, 'arc_replanning');
  const r = c.update({ now: 1200, telemetry: telemetry(1200, 0, 1), connected: true });
  assert.equal(r.reason, 'tracking');
  assert.equal(r.speedControlMode, 'uwb_relative');
  assert.notEqual(r.planner, 'radius_arc');
});

test('production replan stops outputs, ignores predicted confirmations and resumes with a new side', () => {
  const c = new UwbFollowController(config);
  const update = (now, distance = 6, estimate = undefined) => c.update({ now, telemetry: telemetry(now, 120, distance),
    connected: true, targetMotionEstimate: estimate });
  for (let now = 1000; now <= 2000; now += 100) update(now);
  assert.ok(c.relativeImuControl.arcControl.throttle > 0);
  for (let now = 2100; now <= 3000; now += 100) {
    const r = update(now, 1, { source: 'predicted' });
    assert.equal(r.reason, 'arc_replanning'); assert.equal(r.arcFollow.lockedSide, 'right');
    assert.equal(r.throttlePercent, 0); assert.equal(r.steeringDegrees, 0);
    assert.equal(r.arcFollow.transitionPending, null);
  }
  let r;
  for (let now = 3100; now <= 3600; now += 100) r = update(now, 1);
  assert.equal(r.arcFollow.state, 'left_arc');
  assert.equal(r.reason, 'tracking'); assert.ok(r.throttlePercent > 0);
});

test('safety stops and target identity changes reset production arc state', () => {
  for (const fault of [t => { t.armed = false; }, t => { t.flightMode = 'HOLD'; },
    t => { t.uwb.online = false; }, t => { t.attitude.updatedAt = 0; }]) {
    const c = new UwbFollowController(config);
    c.update({ now: 1000, telemetry: telemetry(1000), connected: true });
    const t = telemetry(1100); fault(t);
    assert.equal(c.update({ now: 1100, telemetry: t, connected: true }).safe, false);
    const r = c.update({ now: 1200, telemetry: telemetry(1200, -120), connected: true });
    assert.equal(r.arcFollow.lockedSide, 'left');
  }
  for (const change of [t => { t.uwb.streamId = 'new'; }, t => { t.uwb.sensors[0].tagId = 99; }]) {
    const c = new UwbFollowController(config);
    c.update({ now: 1000, telemetry: telemetry(1000), connected: true });
    const t = telemetry(1100, -120); change(t);
    assert.equal(c.update({ now: 1100, telemetry: t, connected: true }).arcFollow.lockedSide, 'left');
  }
});

test('new transition config rejects invalid thresholds and fractional sample counts', () => {
  const baseline = JSON.parse(fs.readFileSync(new URL('../config/system.config.json', import.meta.url)));
  baseline.uwb_follow.arc_follow = { ...ARC_FOLLOW_DEFAULTS, enabled: true };
  assert.deepEqual(validateSystemConfig(baseline), []);
  for (const [key, value] of [['transition_confirm_samples', 2.5], ['side_switch_confirm_samples', 0],
    ['side_switch_confirm_ms', 0], ['arc_exit_distance_m', -1], ['side_min_lock_ms', NaN],
    ['arc_exit_yaw_rate_deg_s', Infinity], ['straight_reentry_bearing_deg', 6]]) {
    const d = structuredClone(baseline); d.uwb_follow.arc_follow[key] = value;
    assert.ok(validateSystemConfig(d).some(e => e.includes(key)), key);
  }
});
