const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Keep the existing forward follower, but do not multiply its two heading
// slowdowns all the way to zero while the rear-only arc is still inactive.
export function frontTurnReference(config, bearingDeg) {
  const magnitude = Math.abs(bearingDeg);
  if (!config.arcFollow?.enabled || !Number.isFinite(magnitude) || magnitude > 90) return { active: false };
  const alignment = clamp((config.bearingStopDeg - magnitude)
    / (config.bearingStopDeg - config.bearingSlowdownDeg), 0, 1);
  const headingScale = Math.max(config.traditionalMinimumTurnSpeedScale,
    Math.cos(magnitude * Math.PI / 180));
  const floor = clamp(config.traditionalMinimumTurnSpeedScale, 0.1, 0.3);
  return { active: alignment * headingScale < floor, speedScale: floor };
}

export function turnModelThrottle(config, speedMps) {
  const model = config.relativeNmpc || {};
  const cruise = model.model_cruise_speed_mps ?? 0.8;
  const exponent = model.surge_map_exponent ?? 0.5;
  return clamp(config.relativeThrottleLimitPercent * Math.pow(Math.max(0, speedMps) / cruise, 1 / exponent),
    0, config.relativeThrottleLimitPercent);
}

// A low uncalibrated speed-model output is not proof that the ESC can start.
// Use the configured effective-thrust floor only on live, GPS-free turns, and
// fade it out with stopping clearance. It never overrides a stop or braking.
export function minimumTurnThrottle(config, { distanceM, desiredSpeedMps, braking = false,
  stopped = false, gpsActive = false, observed = true }) {
  if (stopped || braking || gpsActive || !observed || !(desiredSpeedMps > 0)) return 0;
  const standOff = Math.max(config.followingDistanceM, config.safetyDistanceM);
  const noise = Math.max(0.02, config.prediction?.measurement_noise_m ?? 0.12);
  const clearance = Math.max(0, distanceM - standOff - noise);
  const distanceScale = clamp(clearance / Math.max(0.05, config.minimumThrottleRangeErrorM ?? 0.35), 0, 1);
  const speedScale = clamp(desiredSpeedMps / config.arcFollow.max_speed_mps, 0, 1);
  return clamp(config.minimumEffectiveThrottlePercent ?? 0, 0, config.relativeThrottleLimitPercent)
    * distanceScale * speedScale;
}
