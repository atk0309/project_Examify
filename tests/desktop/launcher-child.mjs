// Acceptance-only IPC harness: browser capabilities never enter logs or files.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [appDir, root] = process.argv.slice(2);
function send(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected) return reject(new Error('Acceptance IPC disconnected.'));
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}
let runtime;
try {
  const { startLauncher } = await import(
    pathToFileURL(path.join(appDir, 'scripts/launcher.mjs')).href
  );
  runtime = await startLauncher({
    appDir,
    root,
    onPhase: (phase) => process.send?.({ kind: 'phase', phase }),
    browser: (url) => send({ kind: 'browser', url }),
  });
  await send({
    kind: 'ready',
    origin: runtime.origin,
    internalPort: runtime.internalPort,
    reused: runtime.reused,
  });
  // Flush the Windows named-pipe write before closing the reused launcher's IPC.
  if (runtime.reused) process.disconnect();
  else
    process.on('message', (message) => {
      if (message === 'stop') void runtime.stop().then(() => process.disconnect?.());
    });
} catch (error) {
  try {
    await send({ kind: 'error', code: error.code });
  } catch {
    /* The observer separately rejects a disconnected/early-exit child. */
  }
  process.exitCode = 1;
  process.disconnect?.();
}
