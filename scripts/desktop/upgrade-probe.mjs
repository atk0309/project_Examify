/** Test candidate migration and startup using the real packaged launcher, without opening a browser. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLauncher, childEnvironment } from '../launcher.mjs';
export async function probeRelease({ root, appDir, node }) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      node,
      [path.join(appDir, 'scripts/desktop/upgrade-probe.mjs'), root, appDir],
      {
        cwd: appDir,
        env: childEnvironment(),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      },
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 150000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Upgrade startup verification could not run.'));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            'Upgrade migration or startup verification failed. The previous installation is unchanged.',
          ),
        );
    });
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let runtime;
  let disconnected = !process.connected;
  const onDisconnect = () => {
    disconnected = true;
    if (runtime) void runtime.stop().then(() => process.exit(1));
  };
  process.on('disconnect', onDisconnect);
  try {
    if (disconnected) throw new Error('Installer disconnected.');
    runtime = await startLauncher({
      root: process.argv[2],
      appDir: process.argv[3],
      browser: () => {},
      timeout: 60000,
    });
    await runtime.stop();
    if (disconnected) throw new Error('Installer disconnected.');
    process.off('disconnect', onDisconnect);
    process.disconnect();
  } catch {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}
