import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Sign-in link invalid',
  robots: { index: false, follow: false },
};

type Search = { reason?: string | string[] };

type Copy = { title: string; detail: string };

function copyFor(reason: string | undefined): Copy {
  switch (reason) {
    case 'missing':
      return { title: 'Missing token', detail: 'The sign-in link is incomplete.' };
    case 'expired':
      return {
        title: 'Sign-in link invalid',
        detail: 'That link has expired. Request a fresh one.',
      };
    case 'used':
      return { title: 'Sign-in link invalid', detail: 'That link has already been used.' };
    default:
      return { title: 'Sign-in link invalid', detail: 'We don’t recognise that link.' };
  }
}

function pickReason(search: Search): string | undefined {
  const raw = search.reason;
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

export default async function VerifyErrorPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const { title, detail } = copyFor(pickReason(search));

  return (
    <div className="stage">
      <div className="app-frame">
        <div className="login">
          <div className="sent-state">
            <h1 className="sent-title">{title}</h1>
            <p className="sent-note">{detail}</p>
            <div className="mt-6 flex flex-col gap-[var(--sp-2)]">
              <Link className="btn btn-primary" href="/signin">
                Request a new link
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
