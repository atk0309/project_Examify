'use client';

import { useEffect, useRef, useState } from 'react';
import { openSoloHome } from './navigation';

export function SoloStart({ active = false }: { active?: boolean }) {
  const attempted = useRef(new Set<string>());
  const currentAttempt = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(false);
  const [message, setMessage] = useState('Opening your learning space…');

  useEffect(() => {
    mounted.current = true;
    const consumeFragment = () => {
      const token = window.location.hash.slice(1);
      // Also runs for same-document launcher navigation and duplicate hashes.
      // Never leave a bearer in history while a request is pending or failing.
      window.history.replaceState(null, '', window.location.pathname);
      if (active) {
        currentAttempt.current += 1;
        openSoloHome();
        return;
      }
      if (!/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)) {
        if (!pending.current && attempted.current.size === 0) {
          setMessage(
            'Open Examify from its launcher to continue. Your saved work stays on this computer.',
          );
        }
        return;
      }
      // StrictMode remounts and repeated hash events cannot spend a bearer twice.
      if (attempted.current.has(token)) return;
      attempted.current.add(token);
      const attempt = ++currentAttempt.current;
      pending.current = true;
      setMessage('Opening your learning space…');
      const isCurrent = () => mounted.current && currentAttempt.current === attempt;
      void fetch('/api/solo/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
        .then(async (response) => {
          if (!isCurrent()) return;
          if (response.ok) {
            pending.current = false;
            openSoloHome();
            return;
          }
          const body = (await response.json().catch(() => null)) as { reason?: string } | null;
          if (!isCurrent()) return;
          pending.current = false;
          setMessage(
            body?.reason === 'existing_data'
              ? 'This data folder already contains household data. Choose a separate solo installation; your existing data has not been adopted.'
              : 'This launch link has expired or could not be used. Close Examify and open its launcher again.',
          );
        })
        .catch(() => {
          if (!isCurrent()) return;
          pending.current = false;
          setMessage('Could not reach the local app. Open the Examify launcher again to continue.');
        });
    };
    window.addEventListener('hashchange', consumeFragment);
    consumeFragment();
    return () => {
      mounted.current = false;
      window.removeEventListener('hashchange', consumeFragment);
      // Do not abort/spend the in-flight token again during StrictMode's effect
      // replay. Its result is accepted only by the current mounted attempt.
    };
  }, [active]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-6">
      <h1 className="text-3xl font-semibold">Examify</h1>
      <p role="status">{message}</p>
    </main>
  );
}
