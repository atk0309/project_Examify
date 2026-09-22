import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampScore, gradeFreeText, gradingStubAllowed } from '@/lib/grading';
import { env } from '@/lib/env';

describe('clampScore', () => {
  it('rounds and clamps into [0, max]', () => {
    expect(clampScore(2.4, 3)).toBe(2);
    expect(clampScore(2.6, 3)).toBe(3);
    expect(clampScore(-5, 3)).toBe(0);
    expect(clampScore(99, 3)).toBe(3);
  });

  it('treats a non-finite score as 0', () => {
    expect(clampScore(NaN, 3)).toBe(0);
    expect(clampScore(Infinity, 3)).toBe(0);
  });
});

describe('gradeFreeText (test sentinel)', () => {
  const args = {
    question: 'What is a metaphor?',
    rubric: 'Award up to 3 marks…',
    maxScore: 3,
    studentAnswer: 'A comparison that says one thing is another.',
  };

  it('returns a full-score graded verdict with no network', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test';
    try {
      const res = await gradeFreeText(args);
      expect(res.status).toBe('graded');
      if (res.status !== 'graded') return;
      expect(res.verdict.score).toBe(3);
      expect(res.verdict.verdict).toBe('Looks good.');
      expect(Array.isArray(res.verdict.gotRight)).toBe(true);
      expect(Array.isArray(res.verdict.toReview)).toBe(true);
      expect(Array.isArray(res.verdict.spelling)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('fail-closes on missing, empty, or whitespace keys — never stubs a blank as test', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const live of [undefined, '', '   '] as const) {
        if (live === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = live;
        const res = await gradeFreeText(args);
        expect(res).toEqual({ status: 'needs_review' });
        expect(res).not.toMatchObject({
          status: 'graded',
          verdict: { verdict: 'Looks good.' },
        });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

describe('gradingStubAllowed', () => {
  it('allows the stub outside production', () => {
    expect(gradingStubAllowed({ NODE_ENV: 'test' })).toBe(true);
    expect(gradingStubAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(gradingStubAllowed({})).toBe(true);
  });

  it('refuses the stub in production unless GRADING_STUB=1', () => {
    expect(gradingStubAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(gradingStubAllowed({ NODE_ENV: 'production', GRADING_STUB: '' })).toBe(false);
    expect(gradingStubAllowed({ NODE_ENV: 'production', GRADING_STUB: '0' })).toBe(false);
    expect(gradingStubAllowed({ NODE_ENV: 'production', GRADING_STUB: 'true' })).toBe(false);
    expect(gradingStubAllowed({ NODE_ENV: 'production', GRADING_STUB: '1' })).toBe(true);
  });
});

describe('gradeFreeText (test sentinel gate by NODE_ENV / GRADING_STUB)', () => {
  const args = {
    question: 'What is a metaphor?',
    rubric: 'Award up to 3 marks…',
    maxScore: 3,
    studentAnswer: 'A comparison that says one thing is another.',
  };
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    GRADING_STUB: process.env.GRADING_STUB,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };

  function restore(key: keyof typeof saved): void {
    const value = saved[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else Reflect.set(process.env, key, value);
  }

  beforeEach(() => {
    Reflect.set(process.env, 'ANTHROPIC_API_KEY', 'test');
    Reflect.deleteProperty(process.env, 'GRADING_STUB');
  });

  afterEach(() => {
    restore('NODE_ENV');
    restore('GRADING_STUB');
    restore('ANTHROPIC_API_KEY');
    vi.restoreAllMocks();
  });

  it('production without GRADING_STUB never stubs: needs_review, no network, logged', async () => {
    Reflect.set(process.env, 'NODE_ENV', 'production');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await gradeFreeText(args);
    expect(res).toEqual({ status: 'needs_review' });
    expect(res).not.toMatchObject({ status: 'graded', verdict: { verdict: 'Looks good.' } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[grading] free-text answer not marked', {
      reason: 'stub_disabled_in_production',
    });
  });

  it('production with GRADING_STUB=1 keeps the deterministic stub (Playwright)', async () => {
    Reflect.set(process.env, 'NODE_ENV', 'production');
    Reflect.set(process.env, 'GRADING_STUB', '1');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await gradeFreeText(args);
    expect(res).toMatchObject({ status: 'graded', verdict: { score: 3, verdict: 'Looks good.' } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('non-production keeps the stub without the flag', async () => {
    for (const nodeEnv of ['test', 'development'] as const) {
      Reflect.set(process.env, 'NODE_ENV', nodeEnv);
      const res = await gradeFreeText(args);
      expect(res).toMatchObject({
        status: 'graded',
        verdict: { score: 3, verdict: 'Looks good.' },
      });
    }
  });

  it('GRADING_STUB=1 never turns a blank key into the stub', async () => {
    Reflect.set(process.env, 'NODE_ENV', 'production');
    Reflect.set(process.env, 'GRADING_STUB', '1');
    Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(gradeFreeText(args)).resolves.toEqual({ status: 'needs_review' });
    expect(warn).toHaveBeenCalledWith('[grading] free-text answer not marked', {
      reason: 'no_key',
    });
  });
});

describe('gradeFreeText (needs_review logging)', () => {
  const originalProcessKey = process.env.ANTHROPIC_API_KEY;
  const key = 'sk-anth-log-test-never-echo';
  const args = {
    question: 'Explain photosynthesis QUESTION-MARKER',
    rubric: 'RUBRIC-MARKER: award 1 mark per stage.',
    maxScore: 3,
    studentAnswer: 'ANSWER-MARKER plants make food from light',
  };

  function textResponse(text: string, status = 200): Response {
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status });
  }

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = key;
  });

  afterEach(() => {
    if (originalProcessKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalProcessKey;
    vi.restoreAllMocks();
  });

  const cases: Array<{ reason: string; fetch: () => Promise<Response> }> = [
    {
      reason: 'http_529',
      fetch: async () => new Response(`overloaded ${args.studentAnswer}`, { status: 529 }),
    },
    {
      reason: 'timeout',
      fetch: async () => {
        throw new DOMException(`deadline ${args.studentAnswer}`, 'TimeoutError');
      },
    },
    {
      reason: 'network_error',
      fetch: async () => {
        throw new TypeError(`fetch failed ${args.studentAnswer}`);
      },
    },
    {
      // The model echoed the answer back as prose; JSON.parse's message would
      // quote it — the log must carry the reason code only.
      reason: 'bad_json',
      fetch: async () => textResponse(`Sure! ${args.studentAnswer} ${args.rubric}`),
    },
    {
      reason: 'bad_json',
      fetch: async () => new Response(`<html>${args.studentAnswer}</html>`, { status: 200 }),
    },
    {
      reason: 'bad_shape',
      fetch: async () => textResponse(JSON.stringify({ score: 2, gotRight: [args.studentAnswer] })),
    },
    {
      reason: 'bad_shape',
      fetch: async () => new Response(JSON.stringify({ content: [] }), { status: 200 }),
    },
  ];

  for (const { reason, fetch } of cases) {
    it(`logs reason ${reason} without the answer, question, rubric, or key`, async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(fetch);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(gradeFreeText(args)).resolves.toEqual({ status: 'needs_review' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[grading] free-text answer not marked', { reason });
      const logged = JSON.stringify(warn.mock.calls);
      for (const secret of ['ANSWER-MARKER', 'RUBRIC-MARKER', 'QUESTION-MARKER', key]) {
        expect(logged).not.toContain(secret);
      }
    });
  }

  it('logs no_key when the key is missing, and nothing on a graded answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.ANTHROPIC_API_KEY;
    await expect(gradeFreeText(args)).resolves.toEqual({ status: 'needs_review' });
    expect(warn).toHaveBeenCalledWith('[grading] free-text answer not marked', {
      reason: 'no_key',
    });

    warn.mockClear();
    process.env.ANTHROPIC_API_KEY = key;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      textResponse(JSON.stringify({ score: 3, verdict: 'Well explained.' })),
    );
    await expect(gradeFreeText(args)).resolves.toMatchObject({ status: 'graded' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('gradeFreeText (live API path)', () => {
  const originalProcessKey = process.env.ANTHROPIC_API_KEY;
  const args = {
    question: 'What is a metaphor?',
    rubric: 'Award up to 3 marks.',
    maxScore: 3,
    studentAnswer: 'A comparison that says one thing is another.',
  };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'live-test-key';
  });

  afterEach(() => {
    if (originalProcessKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalProcessKey;
    vi.restoreAllMocks();
  });

  it('sends a bounded request and returns only the validated verdict', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                score: 2,
                verdict: 'A sound answer.',
                gotRight: ['Identifies a comparison'],
                toReview: [],
                spelling: [],
              }),
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await gradeFreeText(args);
    expect(result).toEqual({
      status: 'graded',
      verdict: {
        score: 2,
        verdict: 'A sound answer.',
        gotRight: ['Identifies a comparison'],
        toReview: [],
        spelling: [],
      },
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
  });

  it('falls back to needs_review when the request fails or the response is malformed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('timeout'));
    await expect(gradeFreeText(args)).resolves.toEqual({ status: 'needs_review' });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'not-json' }] }), {
        status: 200,
      }),
    );
    await expect(gradeFreeText(args)).resolves.toEqual({ status: 'needs_review' });
  });
});

describe('gradeFreeText (wizard write, no restart)', () => {
  const args = {
    question: 'What is a metaphor?',
    rubric: 'Award up to 3 marks.',
    maxScore: 3,
    studentAnswer: 'A comparison that says one thing is another.',
  };
  const stubVerdict = 'Looks good.';
  const liveVerdict = 'Live path, not stub.';

  function anthropicOkBody(score: number, verdict: string): string {
    return JSON.stringify({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            score,
            verdict,
            gotRight: [],
            toReview: [],
            spelling: [],
          }),
        },
      ],
    });
  }

  afterEach(async () => {
    const { setEnvStoreRootForTests } = await import('@/lib/env-store');
    setEnvStoreRootForTests(null);
    vi.restoreAllMocks();
  });

  it('boot ANTHROPIC_API_KEY=test then wizard set uses the live key, not the stub', async () => {
    expect(env.ANTHROPIC_API_KEY).toBe('test');
    const { setEnvStoreRootForTests, setEnvStoreSecret, envStoreSecretConfigured } =
      await import('@/lib/env-store');
    const root = mkdtempSync(path.join(tmpdir(), 'examify-grade-boot-set-'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    setEnvStoreRootForTests(root);
    const secret = 'sk-anth-boot-test-then-set-never-echo';
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(anthropicOkBody(1, liveVerdict), { status: 200 }),
      );
    try {
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(false);
      const stubbed = await gradeFreeText(args);
      expect(stubbed).toEqual({
        status: 'graded',
        verdict: {
          score: 3,
          verdict: stubVerdict,
          gotRight: [],
          toReview: [],
          spelling: [],
        },
      });
      expect(fetchSpy).not.toHaveBeenCalled();

      expect(setEnvStoreSecret('ANTHROPIC_API_KEY', secret, root)).toEqual({ ok: true });
      expect(env.ANTHROPIC_API_KEY).toBe('test');
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(true);

      const written = await gradeFreeText(args);
      expect(written).toEqual({
        status: 'graded',
        verdict: {
          score: 1,
          verdict: liveVerdict,
          gotRight: [],
          toReview: [],
          spelling: [],
        },
      });
      expect(written.status === 'graded' && written.verdict.verdict).not.toBe(stubVerdict);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
        'x-api-key': secret,
      });
      expect(JSON.stringify(written)).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('set / rotate / clear stay twins with the Configured badge; clear fails closed', async () => {
    expect(env.ANTHROPIC_API_KEY).toBe('test');
    const {
      setEnvStoreRootForTests,
      setEnvStoreSecret,
      clearEnvStoreSecret,
      envStoreSecretConfigured,
    } = await import('@/lib/env-store');
    const root = mkdtempSync(path.join(tmpdir(), 'examify-grade-live-'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    setEnvStoreRootForTests(root);
    const secret = 'sk-anth-post-write-live-never-echo';
    const rotated = 'sk-anth-post-rotate-live-never-echo';
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(anthropicOkBody(1, liveVerdict), { status: 200 }),
      );
    try {
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(false);
      const stubbed = await gradeFreeText(args);
      expect(stubbed).toMatchObject({
        status: 'graded',
        verdict: { score: 3, verdict: stubVerdict },
      });
      expect(fetchSpy).not.toHaveBeenCalled();

      expect(setEnvStoreSecret('ANTHROPIC_API_KEY', secret, root)).toEqual({ ok: true });
      expect(env.ANTHROPIC_API_KEY).toBe('test');
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(true);
      const written = await gradeFreeText(args);
      expect(written).toMatchObject({
        status: 'graded',
        verdict: { score: 1, verdict: liveVerdict },
      });
      expect(written.status === 'graded' && written.verdict.verdict).not.toBe(stubVerdict);
      expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
        'x-api-key': secret,
      });

      expect(setEnvStoreSecret('ANTHROPIC_API_KEY', rotated, root)).toEqual({ ok: true });
      expect(env.ANTHROPIC_API_KEY).toBe('test');
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(true);
      const rotatedResult = await gradeFreeText(args);
      expect(rotatedResult).toMatchObject({
        status: 'graded',
        verdict: { score: 1, verdict: liveVerdict },
      });
      expect(rotatedResult.status === 'graded' && rotatedResult.verdict.verdict).not.toBe(
        stubVerdict,
      );
      expect((fetchSpy.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
        'x-api-key': rotated,
      });

      expect(clearEnvStoreSecret('ANTHROPIC_API_KEY', root)).toEqual({ ok: true });
      expect(env.ANTHROPIC_API_KEY).toBe('test');
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(false);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      const cleared = await gradeFreeText(args);
      expect(cleared).toEqual({ status: 'needs_review' });
      expect(cleared).not.toMatchObject({
        status: 'graded',
        verdict: { verdict: stubVerdict },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(written)).not.toContain(secret);
      expect(JSON.stringify(rotatedResult)).not.toContain(rotated);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});
