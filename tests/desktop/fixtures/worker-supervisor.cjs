const { fork } = require('node:child_process');

const [runner, target, delay] = process.argv.slice(2);
const child = fork(delay || runner, delay ? [runner, target] : [target], {
  env: { ...process.env, EXAMIFY_LAUNCHER_PID: String(process.pid) },
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
child.on('message', (message) => {
  if (message.type === 'examify-worker-ready') child.send({ type: 'examify-worker-go' });
  if (message.type === 'blocked' || message.type === 'waiting')
    process.send({ type: message.type, pid: child.pid });
});
