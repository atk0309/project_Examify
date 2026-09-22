'use client';

/**
 * App-level error boundary: anything that still throws on the client (a render
 * bug, a rejected Server Action no screen handles) lands on this calm page
 * instead of Next's bare built-in one. Finished exams and autosaved drafts live
 * on the server, so reloading picks up from the last save. The root layout
 * renders around this, so the usual fonts and theme tokens apply.
 */
export default function AppError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="stage">
      <div className="app-frame">
        <div className="login" role="alert" data-testid="app-error">
          <div className="sent-state">
            <h1 className="sent-title">Something went wrong</h1>
            <p className="sent-note">
              This screen hit a snag — often a dropped connection or the app restarting. Anything
              already saved is kept.
            </p>
            <div className="mt-6 flex flex-col gap-[var(--sp-2)]">
              <button className="btn btn-primary" type="button" onClick={() => retry()}>
                Try again
              </button>
              {/* A full page load (not a client navigation) starts from a clean slate. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- intentional hard reload */}
              <a className="btn btn-quiet" href="/">
                Back to the start
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
