const numeric = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '')
  && Number.isFinite(Number(value)) ? Number(value) : null;
const fresh = (at, now) => numeric(at) !== null && at > 0 && now >= at && now - at <= 700;
const admitted = status => status === undefined || status === 'trusted' || status === 'legacy';

// Calibration uses the same admitted smoothed output and clock as control.
// An unverified vertical field cannot be used for a three-dimensional fit.
export function calibrationUwbObservation(packet, now, key = null, mode = 'rigid_3d') {
  const planar = mode === 'planar_yaw';
  if (packet?.coordinateSource !== 'smoothed' || packet.smoothing?.ready !== true
    || packet.online !== true || packet.fresh !== true || !admitted(packet.measurementStatus)
    || (!planar && (packet.elevationValid !== true || packet.smoothing.elevationSmoothed !== true))) return null;
  const at = packet.measurementUpdatedAt;
  const sampleKey = JSON.stringify([packet.streamId ?? null, packet.activeReceiverIds || [],
    (packet.sensors || []).map(s => [s.receiverId, s.tagId])]);
  const distance = numeric(packet.distanceM), azimuth = numeric(packet.azimuthDeg), elevation = numeric(packet.elevationDeg);
  if (!fresh(at,now) || key !== null && sampleKey !== key || distance === null || distance <= 0
    || azimuth === null || Math.abs(azimuth) > 180 || (!planar && (elevation === null || Math.abs(elevation) > 90))) return null;
  return {at, key:sampleKey, distanceM:distance, uwbAzimuthDeg:azimuth, uwbElevationDeg:planar?null:elevation};
}

// Horizontal calibration measures the accepted USB observation before the
// control deadband. Public/control positions continue to use their smoother.
export function calibrationUsbObservation(packet, now, key = null, mode = 'planar_yaw') {
  if (mode !== 'planar_yaw' || packet?.source !== 'USB_SERIAL'
    || packet.online !== true || packet.fresh !== true || !admitted(packet.measurementStatus)
    || typeof packet.streamId !== 'string' || !packet.streamId.trim()
    || !Array.isArray(packet.sensors) || packet.sensors.length !== 1) return null;
  const sensor = packet.sensors[0], raw = sensor?.rawObservation;
  const id = value => Number.isInteger(value) && value >= 0 && value <= 65535;
  if (sensor?.valid !== true || sensor.fresh !== true || !admitted(sensor.measurementStatus)
    || sensor.rawRejectedAt != null || !Number.isInteger(sensor.receiverId) || sensor.receiverId < 1
    || !id(sensor.anchorId) || !id(sensor.tagId) || !id(sensor.sequenceId)
    || !Array.isArray(packet.activeReceiverIds) || packet.activeReceiverIds.length !== 1
    || packet.activeReceiverIds[0] !== sensor.receiverId || !raw || raw.tagId !== sensor.tagId) return null;
  const at = numeric(raw.at), distance = numeric(raw.distanceM), azimuth = numeric(raw.azimuthDeg);
  const sampleKey = JSON.stringify([packet.streamId, sensor.receiverId, sensor.anchorId, sensor.tagId]);
  if (at === null || !fresh(at, now) || at !== sensor.receivedMeasurementAt
    || key !== null && key !== sampleKey || distance === null || distance <= 0
    || azimuth === null || Math.abs(azimuth) > 180) return null;
  // Exclude the wall clock from frame identity: retimestamping a duplicate
  // sequence must not make it a new calibration observation.
  return { at, key:sampleKey, distanceM:distance, uwbAzimuthDeg:azimuth, uwbElevationDeg:null,
    frameId:JSON.stringify([packet.streamId,sensor.receiverId,sensor.anchorId,sensor.tagId,sensor.sequenceId]),
    inputSource:'usb_raw' };
}

export function calibrationGimbalPose(feedback, point, now, required = false) {
  const valid = feedback?.checksumValid === true && feedback.attitudeValid !== false && fresh(feedback.updatedAt, now)
    && now - feedback.updatedAt <= 300 && numeric(feedback.yawDeg) !== null && numeric(feedback.pitchDeg) !== null;
  if (!valid) {
    if (required) throw new Error('Fresh gimbal feedback required for calibration');
    return { gimbalYawDeg: point.yawDeg, gimbalPitchDeg: point.pitchDeg, feedbackVerified: false };
  }
  const yaw = Number(feedback.yawDeg), pitch = Number(feedback.pitchDeg);
  // Fit measured angles, not commanded angles. A small static servo offset is
  // allowed; the capture window separately requires a settled measured pose.
  if (Math.abs(yaw - point.yawDeg) > 3 || Math.abs(pitch - point.pitchDeg) > 3) {
    throw new Error('Gimbal has not reached the calibration point');
  }
  return { gimbalYawDeg: yaw, gimbalPitchDeg: pitch, feedbackVerified: true };
}
