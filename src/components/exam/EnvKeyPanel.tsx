'use client';

import { useState } from 'react';

export function EnvKeyPanel({
  testId,
  label,
  hostName,
  configured,
  liveTest,
  writeBlocked,
  pending,
  onSave,
  onClear,
}: {
  testId: string;
  label: string;
  hostName: string;
  configured: boolean;
  liveTest: boolean;
  writeBlocked: boolean;
  pending: boolean;
  onSave: (key: string) => Promise<boolean>;
  onClear: () => void;
}) {
  const [rotating, setRotating] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = pending || saving;
  const sentinel = liveTest;
  const locked = writeBlocked;
  const canMutate = !writeBlocked;
  const showField = canMutate && (!configured || rotating);
  const inputId = `${testId}-input`;

  return (
    <div className="wizard-secret" data-testid={testId}>
      <p className="login-fine">
        {locked
          ? `${hostName} is set by the host environment (Docker, systemd, or a parent process). Rotate or clear it there — a .env write will not survive restart.`
          : sentinel
            ? 'A test sentinel is present (not a usable key). Clear it, or save a real key. The value is never shown.'
            : 'Saved on this host in the same .env store as install.sh. The value is never shown again.'}
      </p>
      {locked ? null : showField ? (
        <form
          className="wizard-secret-form"
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              setSaving(true);
              try {
                const ok = await onSave(value);
                if (ok) {
                  setValue('');
                  setRotating(false);
                }
              } finally {
                setSaving(false);
              }
            })();
          }}
        >
          <label className="field-label" htmlFor={inputId}>
            {label}
          </label>
          <input
            id={inputId}
            className="text-input"
            type="password"
            autoComplete="off"
            value={value}
            disabled={busy}
            data-testid={`${testId}-input`}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="wizard-secret-actions" data-testid={`${testId}-actions`}>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy || value.trim().length < 1}
              data-testid={`${testId}-save`}
            >
              Save key
            </button>
            {rotating ? (
              <button
                className="btn btn-ghost"
                type="button"
                disabled={busy}
                data-testid={`${testId}-cancel`}
                onClick={() => {
                  setRotating(false);
                  setValue('');
                }}
              >
                Cancel
              </button>
            ) : null}
            {sentinel ? (
              <button
                className="btn btn-ghost"
                type="button"
                disabled={busy}
                data-testid={`${testId}-rotate`}
                onClick={() => setRotating(true)}
              >
                Rotate
              </button>
            ) : null}
            {sentinel ? (
              <button
                className="btn btn-ghost"
                type="button"
                disabled={busy}
                data-testid={`${testId}-clear`}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Clear the ${label} from this host’s .env store? Generate and grading that need this key fail closed until you set a new one. A restart will not brick the app.`,
                    )
                  ) {
                    return;
                  }
                  onClear();
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="wizard-secret-actions" data-testid={`${testId}-actions`}>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={busy}
            data-testid={`${testId}-rotate`}
            onClick={() => setRotating(true)}
          >
            Rotate
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={busy}
            data-testid={`${testId}-clear`}
            onClick={() => {
              if (
                !window.confirm(
                  `Clear the ${label} from this host’s .env store? Generate and grading that need this key fail closed until you set a new one. A restart will not brick the app.`,
                )
              ) {
                return;
              }
              onClear();
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
