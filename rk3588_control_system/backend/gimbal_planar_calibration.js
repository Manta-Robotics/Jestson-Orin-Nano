import { normalizeGeometryAngleDeg as wrap } from './gimbal_beacon_geometry.js';

export function generatePlanarCalibrationPoints({ yawExtentDeg, pitchDeg = 0, limits }) {
  if (!Number.isFinite(yawExtentDeg) || yawExtentDeg <= 0
    || -yawExtentDeg < limits.yawMinDeg || yawExtentDeg > limits.yawMaxDeg
    || pitchDeg < limits.pitchMinDeg || pitchDeg > limits.pitchMaxDeg) throw new Error('Horizontal calibration range exceeds gimbal limits');
  return Array.from({ length: 9 }, (_, index) => ({
    yawDeg: -yawExtentDeg + index * yawExtentDeg / 4,
    pitchDeg,
    role: index % 2 === 0 ? 'fit' : 'validation'
  }));
}

export function predictPlanarCalibratedYaw(azimuthDeg, calibration) {
  return wrap(calibration.yaw_reference_deg
    + calibration.gain * wrap(azimuthDeg - calibration.azimuth_reference_deg));
}

export function fitPlanarCalibration(samples, { validationRmsMaxDeg = 3, validationMaxDeg = 6 } = {}) {
  if (samples.length !== 9 || samples.filter(s => s.role === 'fit').length !== 5
    || samples.filter(s => s.role === 'validation').length !== 4) throw new Error('Horizontal calibration requires 5 fitting points and 4 independent validation points');
  if (samples.some(s => !Number.isFinite(s.uwbAzimuthDeg) || !Number.isFinite(s.gimbalYawDeg)
    || s.feedbackVerified !== true)) throw new Error('Measured UWB bearing and gimbal feedback are required');
  const fitted = samples.filter(s => s.role === 'fit'), validation = samples.filter(s => s.role === 'validation');
  if (Math.max(...fitted.map(s => s.gimbalYawDeg))-Math.min(...fitted.map(s => s.gimbalYawDeg)) < 40) throw new Error('Calibration needs at least 40 degrees of measured horizontal coverage');
  const reference = Math.atan2(fitted.reduce((n,s) => n + Math.sin(s.uwbAzimuthDeg*Math.PI/180), 0),
    fitted.reduce((n,s) => n + Math.cos(s.uwbAzimuthDeg*Math.PI/180), 0))*180/Math.PI;
  const xs = fitted.map(s => wrap(s.uwbAzimuthDeg-reference)), ys = fitted.map(s => s.gimbalYawDeg);
  const mean = values => values.reduce((a,b) => a+b,0)/values.length;
  const mx = mean(xs), my = mean(ys);
  const variance = xs.reduce((n,x) => n + (x-mx)**2,0);
  if (variance === 0) throw new Error('Calibration bearings must cover different horizontal directions');
  const gain = xs.reduce((n,x,i) => n + (x-mx)*(ys[i]-my),0)/variance;
  const calibration = { enabled: true, model: 'planar_yaw_affine_v1', gain,
    azimuth_reference_deg: reference, yaw_reference_deg: my-gain*mx };
  const evaluate = points => {
    const errors = points.map(s => wrap(predictPlanarCalibratedYaw(s.uwbAzimuthDeg,calibration)-s.gimbalYawDeg));
    const worstIndex = errors.reduce((best, error, index) => Math.abs(error) > Math.abs(errors[best]) ? index : best, 0);
    return { rms: Math.sqrt(mean(errors.map(e => e*e))), max: Math.abs(errors[worstIndex]),
      worstPoint: points[worstIndex].point ?? samples.indexOf(points[worstIndex]) + 1 };
  };
  const fit = evaluate(fitted), check = evaluate(validation);
  if (fit.rms > validationRmsMaxDeg || fit.max > validationMaxDeg
    || check.rms > validationRmsMaxDeg || check.max > validationMaxDeg) {
    throw new Error(`Horizontal calibration rejected (fit RMS ${fit.rms.toFixed(2)}°, max ${fit.max.toFixed(2)}° at point ${fit.worstPoint}; validation RMS ${check.rms.toFixed(2)}°, max ${check.max.toFixed(2)}° at point ${check.worstPoint}); previous calibration retained`);
  }
  return { model: 'planar_yaw', planar_yaw_calibration: calibration,
    metrics: { sampleCount: 9, fitPointCount: 5, validationPointCount: 4,
      angularRmsErrorDeg: fit.rms, angularMaxErrorDeg: fit.max,
      validationAngularRmsErrorDeg: check.rms, validationAngularMaxErrorDeg: check.max } };
}
