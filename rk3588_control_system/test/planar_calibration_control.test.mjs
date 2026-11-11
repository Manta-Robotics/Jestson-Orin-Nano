import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { generatePlanarCalibrationPoints, fitPlanarCalibration, predictPlanarCalibratedYaw } from '../backend/gimbal_planar_calibration.js';
import { calibrationUwbObservation } from '../backend/beacon_calibration_input.js';
import { summarizeBeaconCalibrationReadings } from '../backend/beacon_calibration_sampling.js';
import { computeBeaconControl } from '../backend/gimbal_beacon.js';
const limits={yawMinDeg:-135,yawMaxDeg:135,pitchMinDeg:-90,pitchMaxDeg:25};
const wrap=x=>((x+180)%360+360)%360-180;
const samples=(extent=60,reference=0)=>generatePlanarCalibrationPoints({yawExtentDeg:extent,limits}).map(p=>({
  ...p,gimbalYawDeg:p.yawDeg,uwbAzimuthDeg:wrap(reference+(p.yawDeg-4)/-.9),feedbackVerified:true,
  gimbalPitchDeg:0,distanceM:2.5,uwbElevationDeg:null }));

test('horizontal capture accepts genuine smoothed bearing without inventing an elevation',()=>{
 const packet={coordinateSource:'smoothed',smoothing:{ready:true},online:true,fresh:true,measurementStatus:'trusted',
   measurementUpdatedAt:1000,distanceM:2.5,azimuthDeg:10,elevationValid:false,elevationDeg:null,streamId:'test',activeReceiverIds:[1],sensors:[{receiverId:1,tagId:5565}]};
 assert.equal(calibrationUwbObservation(packet,1000),null);
 const observed=calibrationUwbObservation(packet,1000,null,'planar_yaw');
 assert.equal(observed.uwbAzimuthDeg,10);assert.equal(observed.uwbElevationDeg,null);
 assert.equal(calibrationUwbObservation({...packet,measurementUpdatedAt:100},1000,null,'planar_yaw'),null);
 const readings=Array.from({length:32},(_,i)=>({...observed,at:1000+i*40,gimbalYawDeg:9+i%2*.01,gimbalPitchDeg:0,feedbackVerified:true}));
 const summary=summarizeBeaconCalibrationReadings(readings,{mode:'planar_yaw'});
 assert.equal(summary.uwbElevationDeg,null);assert.equal(summary.quality.pitchRmsDeg,null);
 assert.equal(summary.sampleCount,32);
});

for(const extent of [32,60]) test(`${extent}-degree horizontal grid and independent validation recover the measured bearing map`,()=>{
 const points=generatePlanarCalibrationPoints({yawExtentDeg:extent,limits});
 assert.equal(points.length,9);assert.equal(points.filter(p=>p.role==='fit').length,5);
 assert.ok(points.every(p=>p.pitchDeg===0));
 const result=fitPlanarCalibration(samples(extent));
 assert.ok(Math.abs(result.planar_yaw_calibration.gain+.9)<1e-10);
 assert.ok(result.metrics.validationAngularMaxErrorDeg<1e-9);
 for(const s of samples(extent)) assert.ok(Math.abs(wrap(predictPlanarCalibratedYaw(s.uwbAzimuthDeg,result.planar_yaw_calibration)-s.gimbalYawDeg))<1e-9);
});

test('horizontal fit handles source angle wrapping and rejects bad held-out observations',()=>{
 assert.ok(fitPlanarCalibration(samples(60,179)).metrics.validationAngularRmsErrorDeg<1e-9);
 const noisy=samples();noisy.find(s=>s.role==='validation').gimbalYawDeg+=20;
 assert.throws(()=>fitPlanarCalibration(noisy),/validation rejected/);
 assert.throws(()=>generatePlanarCalibrationPoints({yawExtentDeg:150,limits}),/range exceeds/);
});

test('confirmed horizontal calibration takes precedence over mount geometry and keeps pitch level',()=>{
 const result=fitPlanarCalibration(samples()),calibration=result.planar_yaw_calibration;
 const control=computeBeaconControl({now:1000,uwb:{online:true,fresh:true,updatedAt:1000,azimuthDeg:20,distanceM:2.5,elevationValid:false},
  feedback:{checksumValid:true,attitudeValid:true,updatedAt:1000,pitchDeg:0,yawDeg:0},limits,
  config:{control_mode:'absolute_angle',use_pitch:false,hold_pitch_deg:0,planar_yaw_calibration:calibration,
    extrinsic_3d:{enabled:true,matrix:[1,0,0,0,-1,0,0,0,-1],translation_m:[0,0,.04]}}});
 assert.equal(control.calibrationModel,'planar_yaw_calibrated');assert.equal(control.targetPitchDeg,0);
 assert.ok(Math.abs(control.targetYawDeg-predictPlanarCalibratedYaw(20,calibration))<1e-9);
});

test('last calibration capture only stages parameters; Apply is a separate explicit operation',async()=>{
 const source=fs.readFileSync(new URL('../backend/server.js',import.meta.url),'utf8');
 const all=samples(),session={active:true,index:8,total:9,mode:'planar_yaw',readyAt:0,points:all,samples:all.slice(0,8),resumeBeaconTracking:false};
 let saved=0,handler;
 const box={gimbalBeaconCalibrationState:session,fitPlanarCalibration,Date,Number,Promise,
  assertBeaconCalibrationSession:s=>{assert.equal(s.active,true);},collectBeaconCalibrationReading:async()=>({...all[8]}),
  publicBeaconCalibrationState:()=>session,persistBeaconCalibration:()=>saved++,stopGimbalTracking:()=>{},gimbalState:{},
  app:{post:(_route,fn)=>handler=fn}};
 const ctx=vm.createContext(box);
 const a=source.indexOf('async function captureBeaconCalibrationPoint()'),b=source.indexOf('\nfunction ',a+1);
 vm.runInContext(source.slice(a,b),ctx);await box.captureBeaconCalibrationPoint();
 assert.equal(session.status,'review');assert.equal(saved,0);
 const route=source.indexOf("app.post('/api/gimbal/beacon/calibration/apply'");
 const end=source.indexOf("app.post('/api/gimbal/beacon/calibration/cancel'",route);
 vm.runInContext(source.slice(route,end),ctx);
 let response;handler({}, {json:value=>response=value,status(){return this;}});
 assert.equal(saved,1);assert.equal(session.status,'complete');assert.equal(response.success,true);
});

test('manual Home transport stops tracking and does not suppress the next Beacon start',async()=>{
 const script=fs.readFileSync(new URL('../frontend/js/manta-app-transport.js',import.meta.url),'utf8');
 const requests=[],window={};
 const ctx={window,Date,Number,Math,Uint8Array,Promise,console,performance:{now:()=>0},setTimeout,clearTimeout,
  fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});const active=url.includes('/track/start');return{ok:true,json:async()=>({success:true,state:{trackingActive:active,trackMode:'beacon'}})};}};
 vm.runInNewContext(script,ctx);
 const transport=window.MantaAppTransport.create('live');transport.connected=true;transport.canControl=true;
 transport.gimbalTrackingActive=true;transport.gimbalTrackMode='beacon';
 await transport.gimbal('home');assert.equal(transport.gimbalTrackingActive,false);
 assert.equal(requests[0].body.preserveTracking,false);
 await transport.gimbal('beacon');assert.equal(requests[1].url,'/api/gimbal/track/start');
});

test('centering uses measured attitude and cannot declare arrival from a completed command',()=>{
 const common={now:1000,uwb:{online:true,fresh:true,updatedAt:1000,azimuthDeg:20,distanceM:2.5,elevationValid:false},
  limits,config:{control_mode:'absolute_angle',use_pitch:false,hold_pitch_deg:0,yaw_deadband_deg:1.5}};
 const calculate=yawDeg=>computeBeaconControl({...common,feedback:{checksumValid:true,attitudeValid:true,updatedAt:1000,pitchDeg:0,yawDeg}});
 const moving=calculate(4);assert.equal(moving.centering.horizontalWithinTolerance,false);
 assert.equal(moving.centering.horizontalErrorDeg,16);assert.equal(moving.centering.verticalWithinTolerance,null);
 const arrived=calculate(20);assert.equal(arrived.centering.horizontalWithinTolerance,true);
 assert.equal(arrived.centering.reference,'full_frame_center');assert.equal(arrived.centering.x,.5);
 assert.equal(arrived.centering.y,.5);assert.equal(arrived.centering.imageVerified,false);
 const rear=computeBeaconControl({...common,uwb:{...common.uwb,azimuthDeg:179},feedback:{checksumValid:true,updatedAt:1000,pitchDeg:0,yawDeg:135}});
 assert.equal(rear.centering.horizontalWithinTolerance,false);
});

test('angle trajectory reaches the exact center target inside the existing arrival tolerance',()=>{
 const source=fs.readFileSync(new URL('../backend/server.js',import.meta.url),'utf8');
 const a=source.indexOf('function setBeaconAbsoluteCommand('),b=source.indexOf('function computeGimbalBeaconDesiredRate(',a);
 const ctx={gimbalBeaconAbsoluteCommand:{initialized:true,yawDeg:10,pitchDeg:0,updatedAt:1000},
  clamp:(x,a,b)=>Math.min(b,Math.max(a,x)),normalizeAngleDeg:wrap,GIMBAL_YAW_MIN_DEG:-135,GIMBAL_YAW_MAX_DEG:135,
  GIMBAL_PITCH_MIN_DEG:-90,GIMBAL_PITCH_MAX_DEG:25,Date,Number,Math};
 vm.createContext(ctx);vm.runInContext(source.slice(a,b),ctx);
 const target={targetYawDeg:11,targetPitchDeg:.5,maxYawRateDps:20,maxPitchRateDps:20,yawDeadbandDeg:1.5,pitchDeadbandDeg:1.5};
 let last=10;
 for(let i=1;i<=5;i++){
  const command=ctx.slewBeaconAbsoluteCommand(target,1000+i*20);
  assert.ok(Math.abs(command.yawDeg-last)<=20*.02+1e-9);last=command.yawDeg;
 }
 assert.equal(ctx.gimbalBeaconAbsoluteCommand.yawDeg,11);
 assert.equal(ctx.gimbalBeaconAbsoluteCommand.pitchDeg,.5);
});
