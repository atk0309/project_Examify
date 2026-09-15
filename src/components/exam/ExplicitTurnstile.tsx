'use client';

import { useEffect, useRef } from 'react';

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: { sitekey: string; theme?: 'auto' | 'light' | 'dark' },
  ) => string;
  remove: (widgetId: string) => void;
};

/**
 * Explicit widget for screens that mount after the Turnstile script has
 * already scanned the document (OTP step after a `sent` state). Implicit
 * `.cf-turnstile` widgets on first paint stay implicit.
 */
export function ExplicitTurnstile({ siteKey }: { siteKey: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let cancelled = false;
    let widgetId: string | undefined;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const api = (): TurnstileApi | undefined =>
      (window as unknown as { turnstile?: TurnstileApi }).turnstile;

    const tryRender = () => {
      if (cancelled || !el) return;
      const turnstile = api();
      if (!turnstile) {
        if (attempts++ < 50) timer = setTimeout(tryRender, 100);
        return;
      }
      widgetId = turnstile.render(el, { sitekey: siteKey, theme: 'auto' });
    };

    timer = setTimeout(tryRender, 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (widgetId) api()?.remove(widgetId);
    };
  }, [siteKey]);

  return <div ref={ref} data-testid="turnstile" />;
}
