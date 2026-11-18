import { UwbGpsSpeedLoop } from './uwb_gps_speed.js';
import { minimumTurnThrottle, turnModelThrottle } from './uwb_turn_propulsion.js';

const RAD = Math.PI / 180;
const TAU = 2 * Math.PI;
const clamp = (x, low, high) => Math.max(low, Math.min(high, x));
const wrap = x => ((x + 180) % 360 + 360) % 360 - 180;
const positive = x => ((x % TAU) + TAU) % TAU;
const finite = x => typeof x === 'number' && Number.isFinite(x);

export const ARC_FOLLOW_DEFAULTS = Object.freeze({
  enabled: false, radius_m: 1.5, max_speed_mps: 0.3, lookahead_m: 0.4,
  side_switch_margin_m: 0.6, yaw_rate_kp: 0.5, yaw_rate_ki: 0.1,
  arc_exit_distance_m: 0.2, arc_exit_bearing_deg: 6, arc_exit_yaw_rate_deg_s: 3,
  straight_reentry_bearing_deg: 12, transition_confirm_ms: 500, transition_confirm_samples: 5,
  side_switch_min_advantage_m: 1.5, side_switch_confirm_ms: 1500,
  side_switch_confirm_samples: 8, side_min_lock_ms: 2000
});
export const ARC_FOLLOW_BOUNDS = Object.freeze({
  radius_m: [0.5, 20], max_speed_mps: [0.05, 2], lookahead_m: [0.1, 3],
  side_switch_margin_m: [0, 5], yaw_rate_kp: [0, 5], yaw_rate_ki: [0, 2],
  arc_exit_distance_m: [0.02, 1], arc_exit_bearing_deg: [1, 20], arc_exit_yaw_rate_deg_s: [0.5, 20],
  straight_reentry_bearing_deg: [2, 45], transition_confirm_ms: [100, 5000], transition_confirm_samples: [2, 100],
  side_switch_min_advantage_m: [0.1, 10], side_switch_confirm_ms: [500, 10000],
  side_switch_confirm_samples: [3, 100], side_min_lock_ms: [500, 10000]
});

export function arcFollowOptions(supplied = {}) {
  const options = { ...ARC_FOLLOW_DEFAULTS, enabled: supplied.enabled === true };
  for (const [key, [low, high]] of Object.entries(ARC_FOLLOW_BOUNDS)) {
    if (finite(supplied[key])) options[key] = clamp(supplied[key], low, high);
  }
  for (const key of ['transition_confirm_samples', 'side_switch_confirm_samples']) options[key] = Math.ceil(options[key]);
  options.straight_reentry_bearing_deg = Math.max(options.straight_reentry_bearing_deg, options.arc_exit_bearing_deg + 1);
  return options;
}

// Body coordinates: x forward, y right. A positive sign is a right turn.
// Reach the stand-off circle, rather than planning to drive into the tag.
export function circleTangentCandidate(goal, radius, sign, standOff = 0) {
  if (![goal?.x, goal?.y, radius, standOff].every(finite) || radius <= 0 || standOff < 0
      || ![-1, 1].includes(sign)) return null;
  const center = { x: 0, y: sign * radius };
  const dx = goal.x, dy = goal.y - center.y;
  const d = Math.hypot(dx, dy);
  if (d < radius - 1e-9) return null;
  const alpha = Math.atan2(dy, dx);
  const offset = Math.acos(clamp(radius / d, -1, 1));
  const start = -sign * Math.PI / 2;
  const candidates = [];
  for (const end of [alpha - offset, alpha + offset]) {
    let angle = positive(sign * (end - start));
    if (TAU - angle < 1e-8) angle = 0;
    let tangent = { x: radius * Math.cos(end), y: center.y + radius * Math.sin(end) };
    const tx = -sign * Math.sin(end), ty = sign * Math.cos(end);
    if (tx * (goal.x - tangent.x) + ty * (goal.y - tangent.y) < -1e-8) continue;
    let straight = Math.max(0, Math.hypot(goal.x - tangent.x, goal.y - tangent.y) - standOff);
    // The arc can enter the arrival circle before the tangent is reached.
    // Truncate at its FIRST intersection, so the path never passes the tag.
    const cosine = (radius * radius + d * d - standOff * standOff) / (2 * radius * d);
    if (standOff > 0 && cosine >= -1 && cosine <= 1) {
      const half = Math.acos(cosine);
      for (const phi of [alpha - half, alpha + half]) {
        const entry = positive(sign * (phi - start));
        if (entry < angle - 1e-8) {
          angle = entry; straight = 0;
          const stop = start + sign * angle;
          tangent = { x: radius * Math.cos(stop), y: center.y + radius * Math.sin(stop) };
        }
      }
    }
    candidates.push({ sign, center, radiusM: radius, angleRad: angle, arcLengthM: radius * angle,
      tangent, straightLengthM: straight, remainingM: radius * angle + straight });
  }
  return candidates.sort((a, b) => a.remainingM - b.remainingM)[0] || null;
}

export class RadiusArcGuidance {
  constructor(options = {}) { this.options = arcFollowOptions(options); this.reset(); }
  reset() {
    this.side = 0; this.state = 'idle'; this.lockedAt = null;
    this.lastNow = null; this.lastMeasurementAt = null; this.pending = null;
  }
  begin(plan, now) {
    this.side = plan.sign; this.state = plan.sign > 0 ? 'right_arc' : 'left_arc';
    this.lockedAt = finite(now) ? now : null; this.pending = null;
  }
  confirm(kind, fresh, stamp, durationMs, samples) {
    if (this.pending?.kind !== kind) this.pending = null;
    if (!fresh) return false;
    if (!this.pending) this.pending = { kind, sinceMeasurementAt: stamp, samples: 0 };
    this.pending.samples++;
    return this.pending.samples >= samples && stamp - this.pending.sinceMeasurementAt >= durationMs;
  }
  // Geometry is refreshed on every call. Only distinct, live measurements may
  // confirm a transition; predicted points and repeated control ticks cannot.
  plan(distanceM, bearingDeg, standOffM = 0, observation = {}) {
    if (![distanceM, bearingDeg, standOffM].every(finite) || distanceM <= 0 || standOffM < 0) {
      this.pending = null; return null;
    }
    const o = this.options, { now, measurementUpdatedAt: stamp } = observation;
    if (finite(now) && this.lastNow !== null && now < this.lastNow) this.reset();
    if (finite(now)) this.lastNow = now;
    const maxGap = observation.maxMeasurementGapMs ?? 700;
    const live = observation.observed !== false && finite(now) && finite(stamp)
      && stamp <= now && now - stamp <= maxGap;
    const fresh = live && (this.lastMeasurementAt === null || stamp > this.lastMeasurementAt);
    if (!live || this.lastMeasurementAt !== null && (stamp < this.lastMeasurementAt
      || fresh && stamp - this.lastMeasurementAt > maxGap)) this.pending = null;
    if (fresh) this.lastMeasurementAt = stamp;
    bearingDeg = wrap(bearingDeg);
    const goal = { x: distanceM * Math.cos(bearingDeg * RAD), y: distanceM * Math.sin(bearingDeg * RAD) };
    const result = (plan, curvatureMInv, active = true, transitionReason = null) => ({
      ...plan, active, goal, curvatureMInv, state: this.state,
      lockedSide: this.side > 0 ? 'right' : this.side < 0 ? 'left' : null,
      side: this.state === 'straight' ? 'straight' : this.side > 0 ? 'right' : this.side < 0 ? 'left' : 'holding',
      transitionReason, transitionPending: this.pending ? { ...this.pending } : null
    });
    const stationary = { remainingM: 0, angleRad: 0, arcLengthM: 0, straightLengthM: 0, center: null, tangent: null };
    if (distanceM <= standOffM || observation.hold === true) {
      this.side = 0; this.state = 'holding'; this.lockedAt = null; this.pending = null;
      return result(stationary, 0, false);
    }
    const straight = () => result({ ...stationary, remainingM: distanceM - standOffM,
      straightLengthM: distanceM - standOffM }, 0);
    const candidates = [-1, 1].map(sign => circleTangentCandidate(goal, o.radius_m, sign, standOffM)).filter(Boolean);
    candidates.sort((a, b) => a.remainingM - b.remainingM);
    const best = candidates[0];
    if (!best) { this.pending = null; return null; }
    const aligned = goal.x > 0 && Math.abs(bearingDeg) <= o.arc_exit_bearing_deg;
    const settled = Math.abs(observation.measuredYawRateDegS ?? 0) <= o.arc_exit_yaw_rate_deg_s;
    if (this.state === 'idle' || this.state === 'holding') {
      if (aligned) { this.state = 'straight'; return straight(); }
      this.begin(best, now);
    }
    if (this.state === 'straight') {
      if (Math.abs(bearingDeg) <= o.straight_reentry_bearing_deg) this.pending = null;
      else if (this.confirm(`enter_${best.sign}`, fresh, stamp, o.transition_confirm_ms, o.transition_confirm_samples)) {
        this.begin(best, now);
      }
      if (this.state === 'straight') return straight();
    }
    let plan = candidates.find(candidate => candidate.sign === this.side);
    if (!plan || this.state === 'replan') {
      this.state = 'replan';
      const next = plan || best;
      if (settled && observation.canReplan !== false) {
        if (this.confirm(`replan_${next.sign}`, fresh, stamp, o.transition_confirm_ms, o.transition_confirm_samples)) {
          const reason = next.sign === this.side ? 'locked_route_recovered' : 'locked_route_invalid';
          this.begin(next, now);
          return result(next, next.sign / next.radiusM * clamp(next.arcLengthM / o.lookahead_m, 0, 1), true, reason);
        }
      } else this.pending = null;
      return result(stationary, 0, false, 'locked_route_invalid');
    }
    // A tiny overshoot of the tangent wraps its candidate to almost 2*pi.
    // Settle at zero curvature instead of commanding another full revolution.
    const passedTangent = aligned && plan.angleRad > Math.PI && plan.sign * bearingDeg <= 0;
    const nearTangent = aligned && (plan.arcLengthM <= o.arc_exit_distance_m || passedTangent);
    if (passedTangent) plan = { ...plan, angleRad: 0, arcLengthM: 0, tangent: { x: 0, y: 0 },
      straightLengthM: distanceM - standOffM, remainingM: distanceM - standOffM };
    if (nearTangent && settled) {
      if (this.confirm('exit_arc', fresh, stamp, o.transition_confirm_ms, o.transition_confirm_samples)) {
        this.state = 'straight'; this.side = 0; this.lockedAt = null; this.pending = null;
        return straight();
      }
    } else if (!aligned && best.sign !== this.side && finite(now) && this.lockedAt !== null
      && now - this.lockedAt >= o.side_min_lock_ms
      && plan.remainingM - best.remainingM > Math.max(o.side_switch_margin_m, o.side_switch_min_advantage_m)) {
      if (this.confirm(`switch_${best.sign}`, fresh, stamp, o.side_switch_confirm_ms, o.side_switch_confirm_samples)) {
        this.begin(best, now); plan = best;
        return result(plan, plan.sign / plan.radiusM * clamp(plan.arcLengthM / o.lookahead_m, 0, 1), true, 'sustained_side_advantage');
      }
    } else this.pending = null;
    // Blend the final short arc into its tangent without exceeding 1/R.
    const curvatureMInv = passedTangent ? 0 : plan.sign / plan.radiusM * clamp(plan.arcLengthM / o.lookahead_m, 0, 1);
    return result(plan, curvatureMInv);
  }
}

// Reference-only controller: it never arms, changes modes or sends MAVLink.
// The production sender remains the final same-direction motor authority.
export class UwbArcFollowControl {
  constructor(config) { this.c = config; this.options = arcFollowOptions(config.arcFollow); this.reset(); }
  reset() {
    this.at = null; this.stamp = null; this.distance = null; this.rangeRate = 0;
    this.throttle = 0; this.steering = 0; this.speed = 0; this.yawIntegral = 0;
    this.identity = null; this.holding = false;
    this.guidance = new RadiusArcGuidance(this.options);
    this.gps = new UwbGpsSpeedLoop(this.c);
  }
  trackApplied(throttle, steering) {
    this.throttle = finite(throttle) ? Math.max(0, throttle) : 0;
    this.steering = finite(steering) ? steering : 0;
  }
  update({ now, preflight, telemetry, estimate, handover }) {
    const c = this.c, o = this.options, u = telemetry.uwb || {};
    const identity = JSON.stringify([u.streamId, u.activeReceiverIds, (u.sensors || []).map(s => [s.receiverId, s.tagId])]);
    if (identity !== this.identity || this.at !== null && (now < this.at || now - this.at > c.navigationTimeoutMs)) {
      this.reset(); this.identity = identity;
    }
    if (handover) {
      this.trackApplied(handover.throttle, handover.steering);
      this.rangeRate = finite(handover.rangeRate) ? handover.rangeRate : 0;
    }
    const dt = this.at === null ? 0.1 : clamp((now - this.at) / 1000, 0.001, 0.25);
    this.at = now;
    const d = preflight.distanceM;
    const bearing = wrap(preflight.azimuthDeg * c.bearingSign * c.bearingScale + c.bearingOffsetDeg);
    if (finite(u.measurementUpdatedAt) && (this.stamp === null || u.measurementUpdatedAt > this.stamp)) {
      if (this.stamp !== null && u.measurementUpdatedAt - this.stamp <= c.uwbTimeoutMs) {
        const elapsed = (u.measurementUpdatedAt - this.stamp) / 1000;
        const rate = clamp((d - this.distance) / elapsed, -3, 3);
        this.rangeRate += (1 - Math.exp(-elapsed / 0.25)) * (rate - this.rangeRate);
      }
      this.stamp = u.measurementUpdatedAt; this.distance = d;
    }
    const standOff = Math.max(c.safetyDistanceM, c.followingDistanceM);
    if (d <= standOff) this.holding = true;
    else if (d > standOff + c.rangeDeadbandM) this.holding = false;
    const previousSide = this.guidance.side;
    const plan = this.guidance.plan(d, bearing, standOff, { now, measurementUpdatedAt: u.measurementUpdatedAt,
      observed: !estimate || ['measured', 'recovering'].includes(estimate.source),
      maxMeasurementGapMs: c.uwbTimeoutMs, measuredYawRateDegS: preflight.measuredYawRateDegS,
      hold: this.holding, canReplan: this.throttle === 0 && this.steering === 0 });
    if (this.guidance.side !== previousSide) this.yawIntegral = 0;
    const holding = this.holding || !plan?.active;
    const a = Math.max(0.05, c.prediction?.braking_deceleration_mps2 ?? 0.3);
    const margin = Math.max(0.02, c.prediction?.measurement_noise_m ?? 0.12);
    const clearance = Math.max(0, d - standOff - margin);
    const reaction = 0.6 + clamp((now - u.measurementUpdatedAt) / 1000, 0, c.uwbTimeoutMs / 1000);
    const brakeCap = Math.sqrt((a * reaction) ** 2 + 2 * a * clearance) - a * reaction;
    const curvature = plan?.curvatureMInv || 0;
    const yawSpeedCap = Math.abs(curvature) > 1e-6 ? c.maxYawRateDegS * RAD / Math.abs(curvature) : Infinity;
    const desiredSpeed = holding ? 0 : Math.min(o.max_speed_mps, c.maxSpeedMps,
      c.commissioningMode ? c.commissioningSpeedMps : c.maxSpeedMps, yawSpeedCap, brakeCap);
    const model = c.relativeNmpc || {};
    const cruiseSpeed = model.model_cruise_speed_mps ?? 0.8;
    const exponent = model.surge_map_exponent ?? 0.5;
    const modelSpeed = cruiseSpeed * Math.pow(this.throttle / c.relativeThrottleLimitPercent, exponent);
    this.speed += (1 - Math.exp(-dt / (model.surge_time_constant_s ?? 1))) * (modelSpeed - this.speed);
    const gps = this.gps.update({ now, telemetry, bearingDeg: bearing, rangeRateMps: this.rangeRate,
      desiredClosingMps: 0, appliedThrottle: this.throttle, policySpeedMps: desiredSpeed, stop: holding });
    let requested = gps.active ? gps.throttlePercent : turnModelThrottle(c, desiredSpeed);
    requested = clamp(requested, 0, c.relativeThrottleLimitPercent);
    const braking = -this.rangeRate > brakeCap + 0.02;
    const minimumThrottle = minimumTurnThrottle(c, { distanceM: d, desiredSpeedMps: desiredSpeed,
      braking, stopped: holding, gpsActive: gps.active,
      observed: !estimate || ['measured', 'recovering'].includes(estimate.source) });
    requested = Math.max(requested, minimumThrottle);
    if (braking) requested = Math.min(requested, Math.max(0, this.throttle - c.throttleDecelPercentS * dt));
    if (holding || desiredSpeed === 0) requested = 0;
    const step = (requested < this.throttle ? c.throttleDecelPercentS : c.throttleAccelPercentS) * dt;
    this.throttle += clamp(requested - this.throttle, -step, step);
    if (holding || braking || desiredSpeed === 0) this.throttle = Math.min(this.throttle, requested);
    const measuredSpeed = gps.active ? Math.max(0, gps.measuredForwardSpeedMps) : this.speed;
    const yawRate = holding ? 0 : clamp(measuredSpeed * curvature / RAD, -c.maxYawRateDegS, c.maxYawRateDegS);
    const error = yawRate - preflight.measuredYawRateDegS;
    const cap = Math.min(c.relativeSteeringLimitDeg, this.throttle * 0.45 * 0.8);
    const feedForward = yawRate / c.maxYawRateDegS * c.relativeSteeringLimitDeg;
    const candidate = clamp(this.yawIntegral + o.yaw_rate_ki * error * dt, -cap, cap);
    const raw = feedForward + o.yaw_rate_kp * error + candidate;
    if (!((raw > cap && error > 0) || (raw < -cap && error < 0))) this.yawIntegral = candidate;
    const steering = clamp(feedForward + o.yaw_rate_kp * error + this.yawIntegral, -cap, cap);
    this.steering += clamp(steering - this.steering, -c.steeringSlewDegS * dt, c.steeringSlewDegS * dt);
    this.steering = clamp(this.steering, -cap, cap);
    if (holding || this.throttle === 0) { this.steering = 0; this.yawIntegral = 0; }
    this.gps.trackApplied(this.throttle, dt);
    const yawLimited = Math.abs(raw) > cap + 1e-6;
    const replanning = plan?.state === 'replan';
    return { safe: true, reason: replanning ? 'arc_replanning' : holding ? 'holding_distance' : 'tracking',
      status: replanning ? 'replanning' : holding ? 'holding' : 'tracking',
      controlMode: 'relative_manual', requiredFlightMode: 'MANUAL', commandFrame: 'BODY_RELATIVE',
      relativeImuControl: true, planner: 'radius_arc', pathFollowActive: false, nmpcActive: false,
      arcFollow: { enabled: true, radiusM: o.radius_m, maxSpeedMps: o.max_speed_mps,
        minimumThrottlePercent: minimumThrottle, speedReferenceMps: desiredSpeed,
        state: plan?.state ?? 'unavailable', lockedSide: plan?.lockedSide ?? null,
        transitionReason: plan?.transitionReason ?? null, transitionPending: plan?.transitionPending ?? null,
        side: plan?.side ?? 'holding', curvatureMInv: curvature, remainingM: plan?.remainingM ?? 0,
        arcAngleDeg: (plan?.angleRad ?? 0) / RAD, center: plan?.center ?? null, tangent: plan?.tangent ?? null,
        yawLimited, radiusEstimated: !gps.active, estimatedForwardSpeedMps: this.speed },
      navigationAvailable: gps.active, navigationReason: gps.active ? null : 'uwb_imu_only',
      gpsSpeedControlActive: gps.active, gpsSpeedControlReason: gps.reason,
      speedControlMode: gps.active ? 'arc_gps_speed' : 'arc_model_speed',
      absoluteSpeedObservable: gps.active, measuredForwardSpeedMps: gps.active ? gps.measuredForwardSpeedMps : null,
      forwardSpeedMps: gps.active ? gps.desiredSpeedMps : null, desiredSpeedMps: desiredSpeed,
      speedFeedForwardSource: gps.active ? 'gps_speed_pi' : 'uncalibrated_thrust_model', velocityNed: null,
      distanceM: d, bearingDeg: bearing, controlBearingDeg: bearing, guidanceBearingDeg: bearing,
      rangeErrorM: d - c.followingDistanceM, rangeRateMps: this.rangeRate, brakingActive: braking,
      holdingDistanceM: standOff, hardStopResumeDistanceM: standOff + c.rangeDeadbandM,
      throttlePercent: this.throttle, desiredThrottlePercent: requested, steeringDegrees: this.steering,
      yawRateDegS: yawRate, yawRateRadS: yawRate * RAD, relativeBodyM: plan?.goal ?? { x: 0, y: 0 } };
  }
}
