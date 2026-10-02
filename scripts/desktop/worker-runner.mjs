// A fresh worker must prove its launcher still owns startup before opening data.
// A connected flag alone cannot detect a disconnect still queued by Node.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const guard = require('./worker-guard.cjs');
const target = process.argv[2];
if (
  !target ||
  !path.isAbsolute(target) ||
  process.argv.slice(3).some((arg) => arg !== '--settings')
)
  throw new Error('Invalid solo worker target.');
await new Promise((resolve, reject) => {
  const onDisconnect = () => reject(new Error('The solo launcher disconnected before startup.'));
  const onMessage = (message) => {
    if (message?.type !== 'examify-worker-go') return;
    process.off('message', onMessage);
    process.off('disconnect', onDisconnect);
    resolve();
  };
  process.on('message', onMessage);
  process.once('disconnect', onDisconnect);
  guard.requireSupervisor();
  process.send({ type: 'examify-worker-ready' }, (error) => {
    if (error) reject(new Error('The solo launcher could not authorize startup.'));
  });
});
guard.requireSupervisor();
// Keep IPC cleanup active without preventing a finished migration from exiting.
process.channel?.unref();
if (process.argv.includes('--settings')) require('./settings-loader.cjs');
await import(pathToFileURL(target).href);
