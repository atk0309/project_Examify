import Script from 'next/script';
import { env } from '@/lib/env';

const DEFAULT_SRC = 'https://plausible.io/js/script.js';

export function Plausible() {
  if (!env.PLAUSIBLE_DOMAIN) return null;
  const src = env.PLAUSIBLE_SRC ?? DEFAULT_SRC;
  return (
    <Script
      defer
      strategy="afterInteractive"
      src={src}
      data-domain={env.PLAUSIBLE_DOMAIN}
      data-testid="analytics-script"
    />
  );
}
