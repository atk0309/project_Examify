// Linux runner lifecycle metadata only. Never reads process environments/secrets.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export function processRecord(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return {
      pid,
      parent: Number(fields[1]),
      group: Number(fields[2]),
      start: fields[19],
      state: fields[0],
    };
  } catch {
    return null;
  }
}
export function recordProcess(file, pid = process.pid) {
  const record = processRecord(pid);
  if (!record || !/^\d+$/.test(record.start)) throw Error('demo_process_identity_unavailable');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
}
function same(record) {
  const current = processRecord(record.pid);
  return current && current.start === record.start && current.state !== 'Z' ? current : null;
}
function descendants(roots) {
  const records = fs
    .readdirSync('/proc')
    .filter((p) => /^\d+$/.test(p))
    .map((p) => processRecord(Number(p)))
    .filter(Boolean);
  const owned = new Map(roots.filter(same).map((r) => [r.pid, r]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of records)
      if (!owned.has(r.pid) && owned.has(r.parent)) {
        owned.set(r.pid, r);
        changed = true;
      }
  }
  return [...owned.values()];
}
function signal(record, value) {
  if (same(record))
    try {
      process.kill(record.pid, value);
    } catch (e) {
      if (e.code !== 'ESRCH') throw Error('demo_process_stop_failed');
    }
}
export async function stopOwned(roots, { graceMs = 10000, termMs = 3000, pollMs = 100 } = {}) {
  const valid = roots.filter(
    (r) => r && Number.isSafeInteger(r.pid) && typeof r.start === 'string' && same(r),
  );
  const owned = descendants(valid);
  // Graceful recorder interruption first, allowing Playwright to close contexts
  // and finalize video. The app's separate group is tracked independently.
  const recorder = valid[0];
  if (recorder) {
    const current = same(recorder);
    try {
      if (current)
        process.kill(current.group === current.pid ? -current.pid : current.pid, 'SIGINT');
    } catch (e) {
      if (e.code !== 'ESRCH') throw Error('demo_process_interrupt_failed');
    }
  }
  async function wait(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && owned.some(same)) await delay(pollMs);
  }
  await wait(graceMs);
  for (const record of owned) signal(record, 'SIGTERM');
  await wait(termMs);
  for (const record of owned) signal(record, 'SIGKILL');
  await wait(1000);
  if (owned.some(same)) throw Error('demo_process_still_running');
  return { stopped: owned.length };
}
