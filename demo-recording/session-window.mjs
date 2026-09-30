export function sessionDeadline(mode, raw, now = Date.now()) {
  if (mode !== 'live') return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw))
    throw Error('demo_expiry_required');
  const deadline = Date.parse(raw);
  if (!Number.isFinite(deadline) || deadline <= now || deadline - now > 5 * 60 * 60 * 1000)
    throw Error('demo_expiry_refused');
  return deadline;
}
export function assertWindow(deadline, now = Date.now()) {
  if (deadline === null || now >= deadline) throw Error('demo_session_expired');
}
