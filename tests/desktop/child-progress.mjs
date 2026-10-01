const phases = new Set([
  'starting',
  'securing-directory',
  'secured-directory',
  'securing-file',
  'secured-file',
  'contended',
  'acquired',
]);

/** Bounded diagnostics for disposable test children; never report raw stderr. */
export function observeChildProgress(child, { timeout = 15000 } = {}) {
  const reached = new Set();
  const waiters = new Set();
  let phase = 'starting';
  let failure;
  let stderrBytes = 0;
  const onStderr = (chunk) => {
    stderrBytes = Math.min(4096, stderrBytes + chunk.length);
  };
  const fail = (reason) => {
    failure ||= new Error(`Lock fixture ${reason}; phase=${phase}; stderrBytes=${stderrBytes}.`);
    for (const waiter of [...waiters]) waiter.finish(failure);
  };
  const onMessage = (message) => {
    if (!message || !phases.has(message.phase)) return;
    phase = message.phase;
    if (message.failure) {
      const code = /^[A-Z_0-9]{1,48}$/.test(message.code || '') ? message.code : 'UNKNOWN';
      const sqlite = Number.isSafeInteger(message.sqlite) ? message.sqlite : 'none';
      fail(`failed code=${code} sqlite=${sqlite}`);
      return;
    }
    reached.add(phase);
    for (const waiter of [...waiters]) if (waiter.phase === phase) waiter.finish();
  };
  const onError = (error) => {
    const code = /^[A-Z_0-9]{1,48}$/.test(error.code || '') ? error.code : 'UNKNOWN';
    fail(`spawn failed code=${code}`);
  };
  const onExit = (code, signal) => {
    const safeSignal = /^SIG[A-Z]{1,12}$/.test(signal || '') ? signal : 'none';
    fail(`exited code=${Number.isSafeInteger(code) ? code : 'none'} signal=${safeSignal}`);
  };
  child.on('message', onMessage);
  child.on('error', onError);
  child.on('exit', onExit);
  child.stderr?.on('data', onStderr);
  return {
    reached,
    waitFor(expected) {
      if (!phases.has(expected)) throw new Error('Unknown lock fixture phase.');
      const ready = new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        if (reached.has(expected)) return resolve();
        const waiter = {
          phase: expected,
          finish(error) {
            clearTimeout(timer);
            waiters.delete(waiter);
            if (error) reject(error);
            else resolve();
          },
        };
        const timer = setTimeout(() => fail(`timed out waiting for ${expected}`), timeout);
        waiters.add(waiter);
      });
      // A child can fail while the test is awaiting a different child/checkpoint.
      // Keep the rejection observable by await without an unhandled rejection.
      void ready.catch(() => {});
      return ready;
    },
    dispose() {
      fail('was disposed');
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stderr?.off('data', onStderr);
    },
  };
}
