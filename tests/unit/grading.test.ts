import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampScore, gradeFreeText } from '@/lib/grading';
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
