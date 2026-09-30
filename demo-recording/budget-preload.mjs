// Imported only into the disposable demo app server, after install/build.
// It forwards genuine provider responses unchanged. Never logs headers/bodies.
import fs from 'node:fs';
import path from 'node:path';
import { boundedRequest, LIMITS, TARGETS } from './budget-policy.mjs';
import { sessionDeadline, assertWindow } from './session-window.mjs';
const live = process.env.DEMO_MODE === 'live';
const deadline = sessionDeadline(process.env.DEMO_MODE, process.env.DEMO_EXPIRES_AT);
const ledger = process.env.DEMO_BUDGET_DIR;
if (!ledger || !path.isAbsolute(ledger)) throw Error('demo_budget_directory_required');
fs.mkdirSync(ledger, { recursive: true, mode: 0o700 });
const originalFetch = globalThis.fetch;
globalThis.fetch = async function demoFetch(input, init) {
  const url = String(input instanceof Request ? input.url : input);
  const parsed = new URL(url);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
    return originalFetch(input, { ...init, redirect: 'error' });
  if (!live || !TARGETS[url]) throw Error('demo_external_request_refused');
  assertWindow(deadline);
  const bounded = boundedRequest(url, init);
  const halted = path.join(ledger, `${bounded.provider}-halted`);
  if (fs.existsSync(halted)) throw Error('demo_provider_halted');
  // Atomic slots across processes. Reservation is consumed even on HTTP failure,
  // cancellation, crash, or rerun. No resetting until a new authorized session.
  let reserved = false;
  for (let i = 0; i < LIMITS.calls; i++) {
    try {
      fs.closeSync(fs.openSync(path.join(ledger, `${bounded.provider}-${i}`), 'wx', 0o600));
      reserved = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw Error('demo_budget_ledger_unavailable');
    }
  }
  if (!reserved) throw Error('demo_provider_call_limit');
  let response;
  try {
    response = await originalFetch(input, { ...init, body: bounded.body, redirect: 'error' });
  } catch {
    fs.writeFileSync(halted, 'provider_transport_failure', { mode: 0o600 });
    throw Error('demo_provider_transport_failure');
  }
  if (response.ok) {
    let usage;
    try {
      usage = (await response.clone().json()).usage;
    } catch {
      /* fail closed below */
    }
    const incoming = bounded.provider === 'openai' ? usage?.prompt_tokens : usage?.input_tokens;
    const outgoing =
      bounded.provider === 'openai' ? usage?.completion_tokens : usage?.output_tokens;
    if (
      !Number.isSafeInteger(incoming) ||
      incoming < 0 ||
      incoming > 2 * LIMITS.bodyBytes + 1024 ||
      !Number.isSafeInteger(outgoing) ||
      outgoing < 0 ||
      outgoing > JSON.parse(bounded.body).max_tokens
    ) {
      fs.writeFileSync(halted, 'usage_unverified', { mode: 0o600 });
      throw Error('demo_usage_unverified');
    }
  } else {
    fs.writeFileSync(halted, 'provider_http_failure', { mode: 0o600 });
  }
  return response;
};
