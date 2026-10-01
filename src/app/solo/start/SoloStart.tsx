'use client';

import { useEffect, useRef, useState } from 'react';

export function SoloStart({ active = false }: { active?: boolean }) {
  const started = useRef(false);
  const [message, setMessage] = useState('Opening your learning space…');

  useEffect(() => {
    // StrictMode/re-renders must not consume the same one-use capability twice.
    if (started.current) return;
    started.current = true;
    const token = window.location.hash.slice(1);
    window.history.replaceState(null, '', window.location.pathname);
    if (active) {
      window.location.replace('/');
      return;
    }
    if (!/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- URL capability is read only in the browser
      setMessage(
        'Open Examify from its launcher to continue. Your saved work stays on this computer.',
      );
      return;
    }
    void fetch('/api/solo/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        if (response.ok) {
          window.location.replace('/');
          return;
        }
        const body = (await response.json().catch(() => null)) as { reason?: string } | null;
        setMessage(
          body?.reason === 'existing_data'
            ? 'This data folder already contains household data. Choose a separate solo installation; your existing data has not been adopted.'
            : 'This launch link has expired or could not be used. Close Examify and open its launcher again.',
        );
      })
      .catch(() => {
        setMessage('Could not reach the local app. Open the Examify launcher again to continue.');
      });
  }, [active]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-6">
      <h1 className="text-3xl font-semibold">Examify</h1>
      <p role="status">{message}</p>
    </main>
  );
}
