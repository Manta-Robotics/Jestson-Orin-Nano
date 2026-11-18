import assert from 'node:assert/strict';
import test from 'node:test';
import {CinematographySession,selectedSwimmer} from '../backend/cinematography_session.js';

const sampleBox = {id:'tagged',x:0.1,y:0.2,w:0.2,h:0.3,confidence:0.8};
const another = {...sampleBox, id:'other', x:0.6};
test('only the measured box of the selected swimmer is used', () => {
  const result = {state:'detected',targets:[another,sampleBox],selected_id:'tagged'};
  assert.deepEqual(selectedSwimmer(result), {x1:0.1,y1:0.2,x2:0.1+0.2,y2:0.5,confidence:0.8});
  assert.equal(selectedSwimmer({...result,selected_id:'missing'}),null);
  assert.equal(selectedSwimmer({...result,state:'predicted'}),null);
  assert.equal(selectedSwimmer({...result,selected_id:null}),null);
});

test('mode switches release outputs and ignore the previous camera and actor responses', async t => {
  let now=1000, sequence=0, callback;
  const camera=[], frames=[], commands=[], events=[];
  const board = {clock:()=>now,leaseMs:350,blocker:()=>null, camera:enabled=>camera.push(enabled),
    releaseCamera:()=>camera.push('stop'),neutral:reason=>commands.push(reason),reset(){},
    openPolicy(c) { callback=c; return {send:frame=>frames.push(frame),close(){}}; },
    event:(name,detail)=>events.push({name,detail}),
    frame:async id=>({id:id||'s/'+sequence,sequence,timeMs:now,epoch:'s',jpeg:'sample'}),
    execute(decision,age) {commands.push([decision.mode,age]); return {safe:true,executedMode:'relative_hold'};}};
  const session = new CinematographySession(board);
  t.after(()=>session.stop());
  session.start();
  callback.ready('u57');
  const frame = async (n, visual=true) => {
    sequence=n; now=1000+200*n;
    if (visual) session.vision({detector:'swimmer',frame_id:'s/'+n,state:'detected',targets:[sampleBox],selected_id:'tagged'});
    await session.pollFrame(session.generation);
  };
  const receive=(id,timeMs,decision=null)=>callback.sample({frameId:id,timeMs,decision});
  const decision=(id,time)=>({mode:'world_hold',intentId:0,observationFrameId:id,observationTimeMs:time});
  await frame(1); receive(1,1200,decision(1,1200));
  await frame(2); receive(2,1400);
  await frame(3); receive(3,1600,decision(2,1400));
  session.tick();
  assert.deepEqual(commands.at(-1),['world_hold',200]);
  assert.equal(events.findLast(e=>e.name==='decision').detail.frame_id,'s/2');
  assert.equal(session.state().executed_mode,'RELATIVE_HOLD');
  const retired=callback;
  session.setVision(false);
  assert.deepEqual(camera,[true,'stop',false]);
  retired.error('old tracker exited');
  retired.sample({frameId:3,timeMs:1600,decision:decision(3,1600)});
  assert.equal(session.state().state,'starting');
  callback.ready('u57');
  await frame(4,false);
  assert.equal(frames.at(-1).target,null);
  assert.equal(frames.at(-1).visualEnabled,false);
  receive(4,1800,decision(4,1800));
  assert.equal(session.state().state,'running');
  session.tick();
  now+=1100;
  session.tick();
  assert.equal(session.active,false);
  assert.equal(camera.at(-1),'stop');
  assert.equal(typeof commands.at(-1),'string');
});
