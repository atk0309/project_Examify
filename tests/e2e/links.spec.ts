import { expect, test } from '@playwright/test';

const STARTS = ['/signin'];

test('all internal links from key pages resolve to 2xx', async ({ page, baseURL }) => {
  const checked = new Set<string>();

  for (const start of STARTS) {
    await page.goto(start);
    const hrefs = await page.$$eval('a[href]', (els) =>
      els
        .map((el) => (el as HTMLAnchorElement).getAttribute('href'))
        .filter((h): h is string => !!h),
    );
    for (const href of hrefs) {
      // Only check internal links; skip mailto, tel, external http(s), and hash-only.
      if (
        href.startsWith('mailto:') ||
        href.startsWith('tel:') ||
        href.startsWith('http://') ||
        href.startsWith('https://') ||
        href.startsWith('#')
      )
        continue;
      const url = new URL(href, baseURL).pathname;
      if (checked.has(url)) continue;
      checked.add(url);
      const res = await page.request.get(url);
      expect(res.status(), `internal link ${url} should be 2xx`).toBeGreaterThanOrEqual(200);
      expect(res.status(), `internal link ${url} should be <400`).toBeLessThan(400);
    }
  }
});
