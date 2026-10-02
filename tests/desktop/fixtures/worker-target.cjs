const fs = require('node:fs');
const path = require('node:path');

if (process.env.EXAMIFY_TEST_WORKER_MODE === 'blocked') {
  process.send({ type: 'blocked' });
  // Model a synchronous data operation that cannot service IPC disconnect.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else {
  fs.writeFileSync(path.join(process.env.EXAMIFY_INSTALL_ROOT, 'opened'), 'yes');
  if (process.env.EXAMIFY_TEST_WORKER_MODE !== 'natural') {
    process.send({ type: 'opened' });
    setInterval(() => {}, 1000);
  }
}
