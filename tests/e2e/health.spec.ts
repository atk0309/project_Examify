import { expect, test } from '@playwright/test';

test('/api/health returns ok=true with uptime', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { ok: boolean; uptime: number };
  expect(body.ok).toBe(true);
  expect(typeof body.uptime).toBe('number');
});

test('POST /api/onboarding/cancel-generate without a session is forbidden', async ({
  request,
  baseURL,
}) => {
  const res = await request.post('/api/onboarding/cancel-generate', {
    headers: { origin: baseURL ?? 'http://127.0.0.1:3100' },
    data: { cancelToken: 'cancel-token-01' },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ ok: false, reason: 'forbidden' });
});
