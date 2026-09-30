import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { processRecord, stopOwned } from './process-records.mjs';
async function child(code) {
  const p = spawn(process.execPath, ['-e', code], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await once(p.stdout, 'data');
  return p;
}
const timing = { graceMs: 30, termMs: 30, pollMs: 10 };
test('tracked process ignoring graceful signals is escalated and verified stopped', async () => {
  const p = await child(
    "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)",
  );
  try {
    const result = await stopOwned([processRecord(p.pid)], timing);
    assert.equal(result.stopped, 1);
    const r = processRecord(p.pid);
    assert.ok(!r || r.state === 'Z');
  } finally {
    try {
      process.kill(-p.pid, 'SIGKILL');
    } catch {}
  }
});
test('stale PID start-time identity is never signalled', async () => {
  const p = await child("console.log('ready');setInterval(()=>{},1000)");
  try {
    const record = processRecord(p.pid);
    assert.deepEqual(await stopOwned([{ ...record, start: '0' }], timing), { stopped: 0 });
    assert.equal(processRecord(p.pid).start, record.start);
  } finally {
    try {
      process.kill(-p.pid, 'SIGKILL');
    } catch {}
  }
});
test('separately detached app process is still stopped by its recorded identity', async () => {
  const owner = await child("console.log('ready');setInterval(()=>{},1000)");
  const app = await child(
    "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)",
  );
  try {
    assert.notEqual(processRecord(owner.pid).group, processRecord(app.pid).group);
    const result = await stopOwned([processRecord(owner.pid), processRecord(app.pid)], timing);
    assert.equal(result.stopped, 2);
    const r = processRecord(app.pid);
    assert.ok(!r || r.state === 'Z');
  } finally {
    for (const p of [owner, app])
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {}
  }
});
