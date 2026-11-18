import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {existsSync} from 'node:fs';

export function openCinemaPolicy(root, callbacks) {
  const python = process.env.MANTA_PPO_PYTHON || process.env.SWIMMER_PYTHON_EXEC || process.env.PYTHON_EXEC ||
    ['.venv-gpu/bin/python3','.venv/bin/python'].map(p=>path.join(root,p)).find(p=>existsSync(p)) || 'python3';
  const env = {...process.env, PYTHONUNBUFFERED:'1'};
  if (process.env.SWIMMER_LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.SWIMMER_LD_LIBRARY_PATH;
  const child = spawn(python, ['-u', path.join(root,'scripts','cinematography_policy.py')], {cwd:root, env, stdio:['pipe','pipe','pipe']});
  let closed = false, diagnostic = '';
  const failed = message => { if (!closed) callbacks.error(message); };
  child.on('error', e => failed(e.message));
  child.stdin.on('error', e => failed(e.message));
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-512); });
  const lines = createInterface({input:child.stdout});
  lines.on('line', line => {
    if (closed) return;
    try {
      const packet = JSON.parse(line);
      if (packet.type === 'ready') callbacks.ready(packet.policyVersion);
      else if (packet.type === 'sample') callbacks.sample(packet);
      else failed(packet.reason || '策略进程返回未知消息');
    } catch (error) { failed(error.message); }
  });
  child.once('close', code => failed('策略进程退出 ('+code+') '+diagnostic.trim()));
  return {
    send(frame) { if (!closed) child.stdin.write(JSON.stringify(frame)+'\n'); },
    close() { closed = true; lines.close(); child.stdin.end(); child.kill(); }
  };
}

export async function readCinemaFrame(broker, id) {
  const url = new URL('/_cinema-frame.jpg',broker);
  if (id) url.searchParams.set('id',id);
  const response = await fetch(url,{signal:AbortSignal.timeout(900)});
  if (response.status === 404 || response.status === 503) { await response.body?.cancel(); return null; }
  if (!response.ok) throw new Error('相机取帧失败 HTTP '+response.status);
  const header = name => response.headers.get('x-manta-'+name);
  const sequence = Number(header('source-sequence'));
  const timeMs = Number(header('obs-ns'))/1e6;
  const epoch = header('stream-epoch'), frameId = header('frame-id');
  if (!epoch || !frameId?.startsWith(epoch+'/') || header('time-kind') !== 'host_decode'
    || !Number.isSafeInteger(sequence) || sequence <= 0 || !Number.isFinite(timeMs) || timeMs <= 0) {
    await response.body?.cancel();
    throw new Error('画面缺少有效帧号或采集时间');
  }
  const jpeg = Buffer.from(await response.arrayBuffer()).toString('base64');
  return {epoch,id:frameId,sequence,timeMs,jpeg};
}
