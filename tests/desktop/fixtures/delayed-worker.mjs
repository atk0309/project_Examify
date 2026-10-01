import fs from 'node:fs';
import path from 'node:path';

const [runner, target] = process.argv.slice(2);
const root = process.env.EXAMIFY_INSTALL_ROOT;
process.on('exit', (code) => fs.writeFileSync(path.join(root, 'child-exit'), String(code)));
const timer = setInterval(() => {
  if (fs.existsSync(path.join(root, 'gate'))) {
    clearInterval(timer);
    process.argv = [process.execPath, runner, target];
    import('../../../scripts/desktop/worker-runner.mjs').catch(() => process.exit(1));
  }
}, 20);
// Confirm the delayed process has actually started before killing its launcher.
process.send({ type: 'waiting' });
