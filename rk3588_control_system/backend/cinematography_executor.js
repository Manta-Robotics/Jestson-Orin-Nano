// UWB provides a vessel-to-tag range and bearing. Keep only the swimmer-to-boat
// offset in north/east axes; neither motion control nor the policy needs a GNSS fix.
import { UwbFollowController, normalizeAngleDeg } from './uwb_follow.js';
import { uwbObservationQuarantined } from './uwb_quality.js';

const RAD = Math.PI / 180;
const MIN_RANGE_M = 3;
const MAX_RANGE_M = 9;
export const CINEMA_DECISION_TIMEOUT_MS = 1000;
const modes = new Set(['move', 'relative_hold', 'world_hold']);
const clamp = (v, low, high) => Math.min(high, Math.max(low, v));
const fresh = (at, now, limit) => Number.isFinite(at) && at > 0 && at <= now && now - at <= limit;
const approach = (v, target, step) => v + clamp(target - v, -step, step);

function validDecision(d) {
  return d && modes.has(d.mode) && Number.isSafeInteger(d.intentId) && d.intentId >= 0
    && ['continue', 'reselect'].includes(d.event)
    && [d.radialMps, d.tangentialMps].every(v => Number.isFinite(v) && Math.abs(v) <= 1.20001)
    && [d.yawDps, d.pitchDps].every(v => Number.isFinite(v) && Math.abs(v) <= 2.00001)
    && (d.mode === 'move' || (d.radialMps === 0 && d.tangentialMps === 0));
}

export class CinematographyExecutor {
  constructor(followConfig = {}) {
    this.follow = new UwbFollowController({ ...followConfig, execution_mode: 'relative_imu' });
    this.config = this.follow.config;
    this.reset();
  }

  reset() {
    this.reference = null;
    this.intentId = null;
    this.mode = null;
    this.tagId = null;
    this.lastRange = null;
    this.lastMeasurement = null;
    this.lastTick = null;
    this.throttle = 0;
    this.steering = 0;
    this.panSide = 0;
  }

  preflight({ now = Date.now(), telemetry = {}, connected = false } = {}) {
    const c = this.config;
    const u = telemetry.uwb || {};
    // Older bridges used updatedAt for acquisition. On modern bridges a missing
    // measurement time must never fall back to the heartbeat.
    const legacyClock = !Object.hasOwn(u, 'measurementUpdatedAt');
    const measurementAt = legacyClock ? u.updatedAt : u.measurementUpdatedAt;
    if (!connected) return { safe: false, reason: 'pixhawk_offline' };
    if (!fresh(measurementAt, now, c.uwbTimeoutMs) || u.online !== true || u.fresh !== true
      || !Number.isFinite(u.distanceM) || u.distanceM <= 0 || !Number.isFinite(u.azimuthDeg)
      || Math.abs(u.azimuthDeg) > 180) return { safe: false, reason: 'uwb_stale' };
    if (this.lastMeasurement && measurementAt < this.lastMeasurement.at) return { safe: false, reason: 'uwb_clock_reversed' };
    const sensors = u.sensors || [];
    const selected = sensors.filter(s => !u.activeReceiverIds?.length || u.activeReceiverIds.includes(s.receiverId));
    if (u.measurementStatus !== undefined && !['trusted', 'legacy'].includes(u.measurementStatus)
      || selected.some(s => s.valid === false || uwbObservationQuarantined(s))) {
      return { safe: false, reason: 'uwb_untrusted' };
    }
    const tagIds = [...new Set(selected.map(s => s.tagId).filter(id => id != null))];
    if (tagIds.length > 1 || (this.tagId !== null && tagIds.length && tagIds[0] !== this.tagId)) {
      return { safe: false, reason: 'target_identity_changed' };
    }
    const t = telemetry.attitude;
    if (!fresh(t?.updatedAt, now, c.navigationTimeoutMs) || !Number.isFinite(t.yaw)
      || !Number.isFinite(t.yawRateDegS)) return { safe: false, reason: 'imu_stale' };
    if (telemetry.pilotSteering?.ready !== true || ![0, 1, 2, 3].includes(telemetry.pilotSteering.type))
      return { safe: false, reason: 'pilot_steering_not_ready' };
    const minRange = Math.max(MIN_RANGE_M, c.safetyDistanceM);
    const uncertainty = Math.max(c.prediction.measurement_noise_m ?? 0.12,
      ...selected.map(s => Number.isFinite(s.filterUncertaintyM) ? s.filterUncertaintyM : 0));
    const rawAt = u.rawDistanceUpdatedAt ?? (legacyClock ? u.updatedAt : null);
    if (u.distanceM <= minRange + uncertainty
      || (Number.isFinite(u.rawDistanceM) && u.rawDistanceM >= 0 && u.rawDistanceM <= minRange && fresh(rawAt, now, c.uwbTimeoutMs))
      || sensors.some(s => Number.isFinite(s.rawDistanceM)
      && s.rawDistanceM >= 0 && s.rawDistanceM <= minRange && fresh(s.rawDistanceUpdatedAt, now, c.uwbTimeoutMs))) {
      return { safe: false, reason: 'holding_distance' };
    }
    const bearingDeg = normalizeAngleDeg(u.azimuthDeg * c.bearingSign * c.bearingScale + c.bearingOffsetDeg);
    const acquisitionYawDeg = t.yaw + t.yawRateDegS * (measurementAt - t.updatedAt) / 1000;
    const angle = (acquisitionYawDeg + bearingDeg) * RAD;
    return { safe: true, reason: 'ready', distanceM: u.distanceM, minRange, uncertainty,
      bearingDeg, tagId: tagIds[0] ?? null, measurementAt,
      offset: this.lastMeasurement?.at === measurementAt ? this.lastMeasurement.offset
        : { north: -u.distanceM * Math.cos(angle), east: -u.distanceM * Math.sin(angle) } };
  }

  neutral(reason) {
    this.lastTick = null;
    this.lastRange = null;
    this.throttle = 0;
    this.steering = 0;
    return { safe: false, reason, throttlePercent: 0, steeringDegrees: 0, forwardSpeedMps: 0, yawRateDegS: 0,
      gimbalYawResidualDegS: 0, gimbalPitchResidualDegS: 0 };
  }

  step({ now = Date.now(), telemetry = {}, connected = false, decision, decisionAt, gimbalYawDeg } = {}) {
    const state = this.preflight({ now, telemetry, connected });
    if (!state.safe) return this.neutral(state.reason);
    if (telemetry.armed !== true || String(telemetry.flightMode || '').toUpperCase() !== 'MANUAL') {
      return this.neutral(telemetry.armed === true ? 'manual_required' : 'armed_required');
    }
    if (!fresh(decisionAt, now, CINEMA_DECISION_TIMEOUT_MS) || !validDecision(decision)) {
      return this.neutral('decision_unavailable');
    }
    if (this.intentId !== null && (decision.intentId < this.intentId
      || (decision.intentId === this.intentId && decision.mode !== this.mode))) return this.neutral('intent_invalid');
    this.tagId ??= state.tagId;
    const c = this.config;
    const dt = this.lastTick === null ? 0 : clamp((now - this.lastTick) / 1000, 0, 0.2);
    this.lastTick = now;
    const newIntent = decision.intentId !== this.intentId;
    this.lastMeasurement = { at: state.measurementAt, offset: state.offset };
    // Only the two motion intents keep a reference. world_hold stops the boat in
    // place on this GNSS-free board instead of latching a relative station.
    const executedMode = decision.mode === 'world_hold' ? 'stop' : decision.mode;
    if (decision.mode !== 'world_hold' && (!this.reference || (newIntent && executedMode === 'relative_hold'))) {
      this.reference = { ...state.offset };
    }
    this.intentId = decision.intentId;
    this.mode = decision.mode;
    if (decision.mode === 'world_hold') {
      this.throttle = 0;
      this.steering = 0;
      this.panSide = 0;
      return { safe: true, reason: 'stop', throttlePercent: 0, steeringDegrees: 0,
        forwardSpeedMps: 0, yawRateDegS: 0, gimbalYawResidualDegS: decision.yawDps,
        gimbalPitchResidualDegS: decision.pitchDps, distanceM: state.distanceM,
        bearingDeg: state.bearingDeg, originalMode: decision.mode, executedMode,
        referenceOffsetNE: null, actualOffsetNE: state.offset, intentId: decision.intentId,
        headingErrorDeg: 0, rangeRateMps: this.lastRange?.rate ?? 0 };
    }

    let reason = executedMode;
    let rangeRate = this.lastRange?.rate ?? 0;
    if (this.lastRange && state.measurementAt > this.lastRange.at) {
      const elapsed = (state.measurementAt - this.lastRange.at) / 1000;
      const observedRate = (state.distanceM - this.lastRange.m) / elapsed;
      rangeRate = elapsed * 1000 <= c.uwbTimeoutMs
        ? rangeRate + c.targetSpeedAlpha * (clamp(observedRate, -c.maxSpeedMps, c.maxSpeedMps) - rangeRate) : 0;
    }
    this.lastRange = { m: state.distanceM, at: state.measurementAt, rate: rangeRate };
    const stopAccel = Math.max(0.05, c.prediction.braking_deceleration_mps2 ?? 0.3);
    const latencyS = (now - state.measurementAt) / 1000 + c.uwbTimeoutMs / 1000;
    const outwardRate = Math.max(0, rangeRate);
    const recovering = state.distanceM + state.uncertainty + outwardRate * latencyS
      + outwardRate ** 2 / (2 * stopAccel) >= MAX_RANGE_M;

    let north = 0;
    let east = 0;
    let referenceErrorM = 0;
    if (recovering) {
      reason = 'recovering_range';
      // Override the executed reference alone. Keep original policy requests in history.
      const scale = (Math.min(state.distanceM, MAX_RANGE_M) - 1) / state.distanceM;
      referenceErrorM = state.distanceM * (1 - scale);
      north = c.rangeGain * (state.offset.north * scale - state.offset.north);
      east = c.rangeGain * (state.offset.east * scale - state.offset.east);
    } else {
      let requestN = 0;
      let requestE = 0;
      if (decision.mode === 'move') {
        const r = this.reference;
        // N/E azimuth increases clockwise. The learned tangential axis increases CCW.
        const radius = Math.hypot(r.north, r.east);
        const oldAngle = Math.atan2(r.east, r.north);
        const lag = Math.hypot(r.north - state.offset.north, r.east - state.offset.east);
        const advance = clamp(1 - lag / c.lookaheadMaxM, 0, 1);
        const dtRef = dt * advance;
        const minimum = Math.min(MAX_RANGE_M, state.minRange + state.uncertainty);
        const newRadius = clamp(radius + decision.radialMps * dtRef, minimum, MAX_RANGE_M);
        const angle = oldAngle - decision.tangentialMps * dtRef / Math.max(radius, minimum);
        this.reference = { north: newRadius * Math.cos(angle), east: newRadius * Math.sin(angle) };
        if (dt > 0) {
          requestN = (this.reference.north - r.north) / dt;
          requestE = (this.reference.east - r.east) / dt;
        }
      }
      const dn = this.reference.north - state.offset.north;
      const de = this.reference.east - state.offset.east;
      referenceErrorM = Math.hypot(dn, de);
      const gain = c.rangeGain * Math.max(0, 1 - c.rangeDeadbandM / Math.max(referenceErrorM, 1e-6));
      north = gain * dn + requestN;
      east = gain * de + requestE;
    }
    const velocity = Math.hypot(north, east);
    let headingError = velocity > 1e-6
      ? normalizeAngleDeg(Math.atan2(east, north) / RAD - telemetry.attitude.yaw) : 0;
    if (Number.isFinite(gimbalYawDeg)) {
      if (Math.abs(gimbalYawDeg) >= 120) this.panSide = Math.sign(gimbalYawDeg);
      else if (this.panSide * gimbalYawDeg <= 110) this.panSide = 0;
    } else this.panSide = 0;
    // A bounded A8 pan axis can recover by rotating the hull toward its view.
    if (this.panSide) {
      headingError = this.panSide * Math.max(c.bearingSlowdownDeg, Math.abs(gimbalYawDeg) - 100);
      reason = 'gimbal_headroom';
    }
    const maxSpeed = c.commissioningMode ? Math.min(c.commissioningSpeedMps, c.maxSpeedMps) : c.maxSpeedMps;
    const closure = Math.max(0, -rangeRate);
    const freeRange = state.distanceM - state.minRange - state.uncertainty - closure * latencyS
      - closure ** 2 / (2 * stopAccel);
    const brakingSpeed = Math.sqrt(2 * stopAccel * Math.max(0, freeRange));
    const guide = this.follow.traditionalFastGuidance.command({ headingErrorDeg: headingError,
      forwardSpeedMps: Math.min(velocity, maxSpeed, brakingSpeed), maximumYawRateDegS: c.maxYawRateDegS,
      measuredYawRateDegS: telemetry.attitude.yawRateDegS });
    const pivot = Math.abs(headingError) >= c.bearingStopDeg || this.panSide !== 0;
    const forward = pivot ? 0 : guide.forwardSpeedMps;
    const yaw = Math.abs(headingError) <= c.bearingDeadbandDeg ? 0 : guide.desiredYawRateDegS;
    const proportionalThrottle = forward / maxSpeed * c.relativeThrottleLimitPercent;
    const targetThrottle = proportionalThrottle > 0.01 && referenceErrorM >= c.minimumThrottleRangeErrorM
      ? Math.max(proportionalThrottle, c.minimumEffectiveThrottlePercent) : proportionalThrottle;
    const targetSteering = yaw / c.maxYawRateDegS * c.relativeSteeringLimitDeg;
    if (targetThrottle === 0) this.throttle = 0;
    else this.throttle = Math.min(brakingSpeed / maxSpeed * c.relativeThrottleLimitPercent,
      approach(this.throttle, targetThrottle, (targetThrottle >= this.throttle ? c.throttleAccelPercentS : c.throttleDecelPercentS) * dt));
    this.steering = velocity <= 1e-6 && !this.panSide ? 0 : approach(this.steering, targetSteering, c.steeringSlewDegS * dt);
    return { safe: true, reason, throttlePercent: this.throttle, steeringDegrees: this.steering,
      forwardSpeedMps: forward, yawRateDegS: yaw, gimbalYawResidualDegS: decision.yawDps,
      gimbalPitchResidualDegS: decision.pitchDps, distanceM: state.distanceM, bearingDeg: state.bearingDeg,
      originalMode: decision.mode, executedMode, referenceOffsetNE: { ...this.reference },
      actualOffsetNE: state.offset, intentId: decision.intentId, headingErrorDeg: headingError, rangeRateMps: rangeRate };
  }
}

// Output is a rate demand to the existing jerk-limited A8 write loop. Full-frame
// pixel axes are right/down, whereas policy pitch is positive up.
export function composeCinemaGimbalRate({ now = Date.now(), base, execution, feedback, axis = {}, beacon = {}, limits = {} } = {}) {
  const zero = { x: 0, y: 0, stale: true, gated: true, dryRun: Boolean(base?.dryRun) };
  if (!execution?.safe || !base || base.dryRun || base.stale) return { ...zero, reason: base?.reason || execution?.reason || 'target_unavailable' };
  if (!fresh(feedback?.updatedAt, now, 300) || feedback.checksumValid !== true || feedback.attitudeValid === false
    || !Number.isFinite(feedback.yawDeg) || !Number.isFinite(feedback.pitchDeg)) return { ...zero, reason: 'gimbal_feedback_stale' };
  let x = base.x;
  let y = base.y;
  let maxX = axis.max_rate_dps ?? 40;
  let maxY = maxX;
  if (base.absoluteAngle) {
    maxX = Math.min(maxX, beacon.max_yaw_rate_dps ?? 25);
    maxY = Math.min(maxY, beacon.max_pitch_rate_dps ?? 20);
    // Keep the calibrated, mechanically bounded angle path. No wrapped shortcut
    // through an endpoint. The existing beacon interpolator limits the command steps.
    x = (base.commandYawDeg - feedback.yawDeg) * (beacon.yaw_gain ?? 2) * Math.sign(beacon.yaw_command_sign ?? 1);
    y = (base.commandPitchDeg - feedback.pitchDeg) * (beacon.pitch_gain ?? 2) * Math.sign(beacon.pitch_command_sign ?? 1);
  }
  if (![x, y, execution.gimbalYawResidualDegS, execution.gimbalPitchResidualDegS].every(Number.isFinite))
    return { ...zero, reason: 'gimbal_rate_invalid' };
  x = clamp(x + Math.sign(axis.yaw_sign ?? 1) * execution.gimbalYawResidualDegS, -maxX, maxX);
  y = clamp(y - Math.sign(axis.pitch_sign ?? 1) * execution.gimbalPitchResidualDegS, -maxY, maxY);
  if ((x < 0 && feedback.yawDeg <= limits.yawMinDeg) || (x > 0 && feedback.yawDeg >= limits.yawMaxDeg)) x = 0;
  if ((y < 0 && feedback.pitchDeg <= limits.pitchMinDeg) || (y > 0 && feedback.pitchDeg >= limits.pitchMaxDeg)) y = 0;
  return { x, y, gated: false, stale: false, dryRun: false, reason: 'tracking' };
}
