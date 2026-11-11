export function validateRecordingConfig(config = {}) {
  const errors = [];
  for (const [key, low, high] of [['segment_seconds', 15, 600], ['startup_timeout_ms', 3000, 60000],
    ['stall_timeout_ms', 2000, 60000], ['reserve_mb', 128, 1048576], ['reserve_ratio', 0, 0.5]]) {
    if (config[key] !== undefined && (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < low || config[key] > high)) {
      errors.push(`recordings.${key} must be between ${low} and ${high}`);
    }
  }
  if (config.tf_sync_enabled !== undefined && typeof config.tf_sync_enabled !== 'boolean') errors.push('recordings.tf_sync_enabled must be boolean');
  if (config.tf_encoding !== undefined) {
    const value = config.tf_encoding;
    if (!value || value.codec !== 2 || ![3840, 4096].includes(value.width) || value.height !== 2160
      || !Number.isInteger(value.bitrateKbps) || value.bitrateKbps < 1000 || value.bitrateKbps > 65535) {
      errors.push('recordings.tf_encoding must specify H.265 4K and a valid bitrateKbps');
    }
  }
  return errors;
}
