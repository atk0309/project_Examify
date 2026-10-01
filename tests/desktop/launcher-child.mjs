// Acceptance-only IPC harness: browser capabilities never enter logs or files.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [appDir, root] = process.argv.slice(2);
const { startLauncher } = await import(
  pathToFileURL(path.join(appDir, 'scripts/launcher.mjs')).href
);
let runtime;
try {
  runtime = await startLauncher({
    appDir,
    root,
    browser: (url) => process.send?.({ kind: 'browser', url }),
  });
  process.send?.({
    kind: 'ready',
    origin: runtime.origin,
    internalPort: runtime.internalPort,
    reused: runtime.reused,
  });
  if (runtime.reused) process.disconnect?.();
  else
    process.on('message', (message) => {
      if (message === 'stop') void runtime.stop().then(() => process.disconnect?.());
    });
} catch (error) {
  process.send?.({ kind: 'error', message: error.message });
  process.exitCode = 1;
  process.disconnect?.();
}
