import { spawn } from 'node:child_process';

export async function prepareBoardShutdown({ stopFollow, stopGimbal, stopRecording }) {
  stopFollow();
  stopGimbal();
  await stopRecording();
}

export function powerOffBoard({ spawnProcess = spawn, log = console.error } = {}) {
  const child = spawnProcess('sudo', ['-n', '/usr/bin/systemctl', 'poweroff'], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', data => log(String(data).trim()));
  child.once('error', error => log(error.message));
  child.once('close', code => { if (code !== 0) log(`Board poweroff failed (code=${code})`); });
  return child;
}
