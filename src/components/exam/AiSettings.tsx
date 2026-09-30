'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  refreshAiSettingsAction,
  saveAiModeAction,
  setAiConfigAction,
  setAiKeyAction,
} from '@/actions/ai-settings';
import {
  type AiConfigKey,
  type AiSettingsResult,
  type AiSettingsSnapshot,
} from '@/lib/ai-settings-types';
import {
  ONBOARDING_AI_MODES,
  onboardingMarkingCopy,
  onboardingAgentCliSetupNote,
  type OnboardingAiMode,
} from '@/lib/onboarding-types';
import { EnvKeyPanel } from './EnvKeyPanel';

const LABELS: Record<OnboardingAiMode, string> = {
  cloud: 'Anthropic API',
  'cloud-openai': 'OpenAI API',
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex',
  'local-agent': 'Local endpoint',
  'local-cli': 'Local command',
  'skip-stub': 'Test stub (generation only)',
};
const MODEL_KEY: Partial<Record<OnboardingAiMode, AiConfigKey>> = {
  cloud: 'EXAMIFY_ANTHROPIC_MODEL',
  'cloud-openai': 'EXAMIFY_OPENAI_MODEL',
  'claude-cli': 'EXAMIFY_CLAUDE_MODEL',
  'codex-cli': 'EXAMIFY_CODEX_MODEL',
  'local-agent': 'EXAMIFY_LLM_MODEL',
};
const ERRORS = {
  forbidden:
    'Only the household administrator can change AI settings. Sign in again if your access changed.',
  invalid:
    'Check the value. Models need a simple model identifier; endpoints need an http(s) URL without credentials, query parameters or fragments.',
  rate_limited: 'Too many settings requests. Wait a little, then try again.',
  host_managed:
    'This setting is managed by the host environment. Change it there, then restart Examify.',
  disk: 'The host could not confirm this change. Check its .env file permissions, then reload to check what was saved.',
};

export function AiSettings({ snapshot: initial }: { snapshot: AiSettingsSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [mode, setMode] = useState<OnboardingAiMode | ''>(initial.aiMode ?? '');
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function run(
    action: () => Promise<AiSettingsResult>,
    success = 'Settings saved.',
  ): Promise<boolean> {
    setError('');
    setMessage('');
    try {
      const result = await action();
      if (!result.ok) {
        setError(ERRORS[result.reason]);
        return false;
      }
      setSnapshot(result.snapshot);
      setMode(result.snapshot.aiMode ?? '');
      setMessage(success);
      return true;
    } catch {
      setError('Could not confirm the change. Recheck readiness or reload before trying again.');
      return false;
    }
  }
  const selected = snapshot.aiMode;
  const modelKey = selected ? MODEL_KEY[selected] : undefined;
  const provider =
    selected === 'cloud' ? 'anthropic' : selected === 'cloud-openai' ? 'openai' : null;
  return (
    <section className="wizard-panel" data-testid="ai-settings">
      <Link href="/" className="btn btn-ghost">
        Back to dashboard
      </Link>
      <h1 className="display-title">AI settings</h1>
      <p className="subtitle">
        Choose who generates content and marks written answers. Changes apply to future requests,
        including retries of pending marking. Existing results stay unchanged.
      </p>
      <p className="login-fine">
        Cloud modes send study material or written answers and rubrics to the selected provider.
        Local endpoint sends them to the server you configure. CLI modes use the host’s own sign-in.
        Keys and saved connection values are never displayed.
      </p>
      <form
        method="post"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData();
          data.set('aiMode', mode);
          startTransition(async () => {
            await run(() => saveAiModeAction(data));
          });
        }}
      >
        <label className="field-label" htmlFor="ai-settings-mode">
          AI provider
        </label>
        <select
          id="ai-settings-mode"
          className="text-input"
          data-testid="ai-settings-mode"
          value={mode}
          disabled={pending}
          onChange={(event) => setMode(event.target.value as OnboardingAiMode)}
        >
          <option value="" disabled>
            Choose a provider
          </option>
          {ONBOARDING_AI_MODES.map((value) => (
            <option key={value} value={value}>
              {LABELS[value]}
            </option>
          ))}
        </select>
        <button
          className="btn btn-primary"
          data-testid="ai-settings-save"
          type="submit"
          disabled={pending || !mode}
        >
          Save provider
        </button>
      </form>
      <div className="wizard-callout" data-testid="ai-settings-status">
        <p>Saved provider: {selected ? LABELS[selected] : 'Not selected'}</p>
        <p>
          Anthropic {snapshot.anthropicConfigured ? 'configured' : 'not configured'} · OpenAI{' '}
          {snapshot.openaiConfigured ? 'configured' : 'not configured'}
        </p>
        <p>{onboardingMarkingCopy(selected, snapshot)}</p>
      </div>
      <p className="login-fine">
        Readiness checks saved configuration and CLI sign-in only. It does not verify API keys,
        endpoint availability or model access, and makes no paid AI request. A provider failure
        preserves answers as awaiting marking.
      </p>
      <button
        className="btn btn-ghost"
        type="button"
        data-testid="ai-settings-refresh"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await run(refreshAiSettingsAction, 'Readiness rechecked. No paid AI request was made.');
          })
        }
      >
        Recheck readiness
      </button>
      {provider ? (
        <EnvKeyPanel
          key={provider}
          testId={`ai-settings-${provider}-key`}
          label={`${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key`}
          hostName={provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}
          configured={
            provider === 'anthropic' ? snapshot.anthropicConfigured : snapshot.openaiConfigured
          }
          liveTest={provider === 'anthropic' ? snapshot.anthropicLiveTest : snapshot.openaiLiveTest}
          writeBlocked={
            provider === 'anthropic' ? snapshot.anthropicWriteBlocked : snapshot.openaiWriteBlocked
          }
          pending={pending}
          onSave={(value) =>
            new Promise<boolean>((resolve) =>
              startTransition(async () => {
                const data = new FormData();
                data.set('provider', provider);
                data.set('intent', 'set');
                data.set('apiKey', value);
                resolve(await run(() => setAiKeyAction(data)));
              }),
            )
          }
          onClear={() =>
            startTransition(async () => {
              const data = new FormData();
              data.set('provider', provider);
              data.set('intent', 'clear');
              await run(() => setAiKeyAction(data));
            })
          }
        />
      ) : null}
      {modelKey ? (
        <ConfigField
          key={modelKey}
          name={modelKey}
          label="Model"
          snapshot={snapshot}
          pending={pending}
          onSave={(data) =>
            new Promise<boolean>((resolve) =>
              startTransition(async () => {
                resolve(await run(() => setAiConfigAction(data)));
              }),
            )
          }
        />
      ) : null}
      {selected === 'local-agent' ? (
        <>
          <ConfigField
            name="EXAMIFY_LLM_BASE_URL"
            label="Local endpoint URL"
            snapshot={snapshot}
            pending={pending}
            onSave={(data) =>
              new Promise<boolean>((resolve) =>
                startTransition(async () => {
                  resolve(await run(() => setAiConfigAction(data)));
                }),
              )
            }
          />
          <p className="login-fine">
            Use an OpenAI-compatible endpoint, for example http://127.0.0.1:11434/v1. Study data
            leaves this machine when the configured server is remote. Both URL and model are
            required.
          </p>
        </>
      ) : null}
      {selected === 'claude-cli' || selected === 'codex-cli' ? (
        <p className="wizard-callout">
          {onboardingAgentCliSetupNote(
            selected,
            selected === 'claude-cli' ? snapshot.claudeCliFound : snapshot.codexCliFound,
            selected === 'claude-cli' ? snapshot.claudeCliSignIn : snapshot.codexCliSignIn,
          )}
        </p>
      ) : null}
      {selected === 'local-cli' ? (
        <p className="wizard-callout">
          Local command {snapshot.localCmdConfigured ? 'configured' : 'not configured'}. Configure
          EXAMIFY_INGEST_LOCAL_CMD on the host. Commands and executable paths cannot be edited here.
          This mode uses Anthropic for marking.
        </p>
      ) : null}
      <p role="status" data-testid="ai-settings-message">
        {message}
      </p>
      {error ? (
        <p role="alert" data-testid="ai-settings-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ConfigField({
  name,
  label,
  snapshot,
  pending,
  onSave,
}: {
  name: AiConfigKey;
  label: string;
  snapshot: AiSettingsSnapshot;
  pending: boolean;
  onSave: (data: FormData) => Promise<boolean>;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const info = snapshot.config[name];
  async function submit(intent: 'set' | 'clear') {
    setSaving(true);
    try {
      const data = new FormData();
      data.set('key', name);
      data.set('value', value);
      data.set('intent', intent);
      if (await onSave(data)) setValue('');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="wizard-secret" data-testid={`ai-settings-config-${name}`}>
      <p>
        {label}:{' '}
        {info.configured
          ? 'Configured (value hidden)'
          : name === 'EXAMIFY_LLM_MODEL' || name === 'EXAMIFY_LLM_BASE_URL'
            ? 'Not configured'
            : 'Provider default'}
      </p>
      {info.writeBlocked ? (
        <p className="login-fine">Managed by the host environment. Change it there and restart.</p>
      ) : (
        <form
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            void submit('set');
          }}
        >
          <label className="field-label" htmlFor={`ai-${name}`}>
            New {label.toLowerCase()}
          </label>
          <input
            id={`ai-${name}`}
            className="text-input"
            value={value}
            autoComplete="off"
            disabled={pending || saving}
            onChange={(event) => setValue(event.target.value)}
          />
          <button className="btn btn-primary" disabled={pending || saving || !value.trim()}>
            Save {label.toLowerCase()}
          </button>
          {info.configured ? (
            <button
              className="btn btn-ghost"
              type="button"
              disabled={pending || saving}
              onClick={() => {
                if (
                  window.confirm(
                    `Clear ${label.toLowerCase()}? Cloud/CLI models return to their defaults; local endpoint marking requires both URL and model.`,
                  )
                )
                  void submit('clear');
              }}
            >
              Clear {label.toLowerCase()}
            </button>
          ) : null}
        </form>
      )}
    </div>
  );
}
