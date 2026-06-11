import { expect, test } from '@playwright/test';

test('/api/health returns ok=true with uptime', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { ok: boolean; uptime: number };
  expect(body.ok).toBe(true);
  expect(typeof body.uptime).toBe('number');
});
