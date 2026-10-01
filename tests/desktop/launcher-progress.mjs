const phases = new Set([
  'lock',
  'lock-wait',
  'existing',
  'reuse',
  'preflight',
  'permissions',
  'migration',
  'server',
  'health',
  'browser',
]);
const codes = new Set(['EXAMIFY_UNSAFE_DATA', 'ENOENT', 'EACCES', 'EPERM', 'ERR_SQLITE_ERROR']);

/** Do not expose child output, exception messages, capabilities or fixture paths. */
export function observeLauncher(child, { id, timeout = 90000, report = () => {} }) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid launcher fixture ID.');
  let phase = 'spawn';
  let settled = false;
  let stderrBytes = 0;
  let finish;
  const started = Date.now();
  const onStderr = (chunk) => {
    stderrBytes = Math.min(4096, stderrBytes + chunk.length);
  };
  const diagnostic = () =>
    `launcher-${id} phase=${phase} elapsedMs=${Date.now() - started} stderrBytes=${stderrBytes}`;
  const fail = (reason, code) =>
    finish(Object.assign(new Error(`${diagnostic()}: ${reason}.`), { code }));
  const onMessage = (message) => {
    if (message?.kind === 'phase' && phases.has(message.phase) && message.phase !== phase) {
      phase = message.phase;
      report(`Packaged launcher-${id}: ${phase}.`);
    } else if (message?.kind === 'ready') {
      finish(undefined, message);
    } else if (message?.kind === 'error') {
      const code = codes.has(message.code) ? message.code : 'UNKNOWN';
      fail(`startup failed code=${code}`, code);
    }
  };
  const onError = (error) =>
    fail(`spawn failed code=${codes.has(error.code) ? error.code : 'UNKNOWN'}`);
  const onExit = (code, signal) =>
    fail(
      `exited before ready code=${Number.isSafeInteger(code) ? code : 'none'} signal=${['SIGTERM', 'SIGKILL', 'SIGINT'].includes(signal) ? signal : 'none'}`,
    );
  const onDisconnect = () => fail('IPC disconnected before ready');
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail('startup timed out'), timeout);
    finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('disconnect', onDisconnect);
      child.stderr?.off('data', onStderr);
      if (error) reject(error);
      else resolve(value);
    };
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
    child.on('disconnect', onDisconnect);
    child.stderr?.on('data', onStderr);
  });
  void ready.catch(() => {});
  return { ready, diagnostic, dispose: () => fail('fixture stopped before ready') };
}
