import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../frontend/mobile-preview-kimi-k26.html',import.meta.url),'utf8');
function ui(initial, { gimbalMode = 'beacon', profile = 'horizontal9', captureResult } = {}) {
  const nodes=new Map();const $=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{value:selector==='#beaconCalibrationProfile'?profile:'',hidden:selector==='#beaconCalibrationModal',style:{},querySelector:()=>null});
    return nodes.get(selector);
  };
  const calls=[];
  let reads=0;
  const transport={
    getBeaconCalibration:async()=>{reads++;return {calibration:initial};},
    captureBeaconCalibration:async()=>{calls.push('capture');return {calibration:captureResult||{...initial,index:initial.index+1}};},
    startBeaconCalibration:async options=>{
      calls.push({...options});
      return {calibration:{active:true,profile:options.profile,total:options.profile==='precision25'?25:9,index:0,status:'awaiting_center',point:{yawDeg:0,pitchDeg:0}}};
    },
    applyBeaconCalibration:async()=>{calls.push('apply');return {calibration:{...captureResult||initial,active:false,status:'complete'}};},
    cancelBeaconCalibration:async()=>{calls.push('cancel');}
  };
  const context={$,beaconCalibration:null,beaconCalibrationBusy:false,beaconCalibrationPollTimer:0,
    state:{gimbalMode,gimbalOutputAvailable:false},localize:a=>a,showToast:(...x)=>calls.push(x),
    pageCanControl:()=>true,ensureTransport:()=>transport,setModal:(id,value)=>{$('#'+id).hidden=!value;},
    startBeaconCalibrationPreview:()=>{},stopBeaconCalibrationPreview:()=>{},setInterval:()=>1,clearInterval:()=>{},
    Promise,Number,Boolean};
  vm.createContext(context);
  const render=html.slice(html.indexOf('function renderBeaconCalibration(){'),html.indexOf('\nvar beaconCalibrationPreviewFrame'));
  const actions=html.slice(html.indexOf('function stopBeaconCalibrationPolling(){'),html.indexOf('\nfunction gimbalControlAvailable()'));
  vm.runInContext(render+'\n'+actions,context);return {context,$,calls,reads:()=>reads};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('click mode cannot open the Beacon calibration workflow',async()=>{
  const app=ui({active:false,status:'idle',available:true},{gimbalMode:'click'});
  app.context.openBeaconCalibration();await flush();
  assert.equal(app.$('#beaconCalibrationModal').hidden,true);
  assert.equal(app.reads(),0);
});
test('opening from Beacon mode resumes active backend calibration instead of starting a duplicate',async()=>{
  const app=ui({active:true,status:'awaiting_center',index:3,total:9,profile:'quick9',available:true,point:{yawDeg:32,pitchDeg:10}});
  app.context.openBeaconCalibration();await flush();
  assert.equal(app.context.beaconCalibration.index,3);assert.equal(app.$('#beaconCalibrationCounter').textContent,'3 / 9');
  assert.equal(app.$('#beaconCalibrationProfile').disabled,true);assert.deepEqual(app.calls,[]);
  app.context.advanceBeaconCalibration();await flush();assert.equal(app.calls[0],'capture');
});
test('idle backend state starts selected precision profile rather than capturing a nonexistent session',async()=>{
  const app=ui({active:false,status:'idle',available:true},{profile:'precision25'});app.context.openBeaconCalibration();await flush();
  assert.equal(app.$('#beaconCalibrationCounter').textContent,'0 / 25');app.context.advanceBeaconCalibration();await flush();
  assert.equal(app.calls[0].profile,'precision25');
});
test('horizontal calibration requires an explicit collection range and sends the selected range',async()=>{
  const app=ui({active:false,status:'idle',available:true});
  app.context.openBeaconCalibration();await flush();
  assert.equal(app.$('#beaconCalibrationCounter').textContent,'0 / 9');
  assert.equal(app.$('#beaconCalibrationNext').disabled,true);
  app.$('#beaconCalibrationYawExtent').value='32';
  app.context.renderBeaconCalibration();
  assert.equal(app.$('#beaconCalibrationNext').disabled,false);
  app.context.advanceBeaconCalibration();await flush();
  assert.deepEqual(app.calls,[{profile:'horizontal9',yawExtentDeg:32}]);
});
test('unavailable inputs explain the reason and disable the start button without hiding the workflow',async()=>{
  const app=ui({active:false,status:'idle',available:false,unavailableReason:'等待实时云台姿态反馈'});
  app.context.openBeaconCalibration();await flush();
  assert.equal(app.$('#beaconCalibrationModal').hidden,false);assert.equal(app.$('#beaconCalibrationNext').disabled,true);
  assert.equal(app.$('#beaconCalibrationInstruction').textContent,'等待实时云台姿态反馈');
});

const REVIEW = {
  active:true,status:'review',index:9,total:9,profile:'horizontal9',
  result:{planar_yaw_calibration:{gain:1,azimuth_reference_deg:0,yaw_reference_deg:2},
    metrics:{angularRmsErrorDeg:1,validationPointCount:4,validationAngularRmsErrorDeg:1.5,validationAngularMaxErrorDeg:2}}
};
test('capturing the last point leaves the result pending explicit confirmation',async()=>{
  const app=ui({active:true,status:'awaiting_center',index:8,total:9,profile:'horizontal9'},{captureResult:REVIEW});
  app.context.openBeaconCalibration();await flush();
  app.context.advanceBeaconCalibration();await flush();
  assert.deepEqual(app.calls,['capture']);
  assert.equal(app.$('#beaconCalibrationProgressText').textContent,'待确认参数，尚未保存');
  assert.equal(app.$('#beaconCalibrationNext').textContent,'确认参数并应用');
  app.context.advanceBeaconCalibration();await flush();
  assert.deepEqual(app.calls,['capture','apply']);
  assert.equal(app.$('#beaconCalibrationProgressText').textContent,'校准已保存');
});
test('cancelling a review discards the pending result instead of applying it',async()=>{
  const app=ui(REVIEW);
  app.context.openBeaconCalibration();await flush();
  app.context.cancelBeaconCalibration();await flush();
  assert.deepEqual(app.calls,['cancel']);
  assert.equal(app.$('#beaconCalibrationModal').hidden,true);
});
