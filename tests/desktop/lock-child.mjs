import { privateDirectory, privateFile } from '../../scripts/launcher.mjs';
import { acquireOperationLock } from '../../scripts/desktop/operation-lock.mjs';

let phase = 'starting';
const report = (value) => {
  phase = value;
  process.send({ phase });
};
try {
  const release = await acquireOperationLock({
    root: process.argv[2],
    secureDirectory: (directory) => {
      report('securing-directory');
      const result = privateDirectory(directory);
      report('secured-directory');
      return result;
    },
    secureFile: (file) => {
      report('securing-file');
      privateFile(file);
      report('secured-file');
    },
    onContended: () => report('contended'),
  });
  report('acquired');
  process.on('message', () => {
    release();
    process.disconnect();
  });
} catch (error) {
  // This fixture never sends raw exception text, stack traces, or file contents.
  process.send({
    failure: true,
    phase,
    code: /^[A-Z_0-9]{1,48}$/.test(error.code || '') ? error.code : 'UNKNOWN',
    sqlite: Number.isSafeInteger(error.errcode) ? error.errcode : null,
  });
  process.exitCode = 1;
  process.disconnect();
}
