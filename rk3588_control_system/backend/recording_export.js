import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// Export without re-encoding; never replace or delete the original segment.
export async function exportRecording(source, { binary = 'ffmpeg', spawnProcess = spawn } = {}) {
  const directory = path.join(path.dirname(source), '.exports');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${randomUUID()}.mp4`);
  const cleanup = () => fs.rmSync(target, { force: true });
  try {
    await new Promise((resolve, reject) => {
      const child = spawnProcess(binary, ['-v', 'error', '-n', '-i', source, '-map', '0:v:0', '-an', '-c:v', 'copy', '-movflags', '+faststart', target], { stdio: ['ignore', 'ignore', 'pipe'] });
      let error = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 120000);
      child.stderr.on('data', data => { error = (error + data.toString()).slice(-2000); });
      child.once('error', problem => { clearTimeout(timer); reject(problem); });
      child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(error || 'Recording export failed')); });
    });
    return { path: target, cleanup };
  } catch (error) { cleanup(); throw error; }
}
