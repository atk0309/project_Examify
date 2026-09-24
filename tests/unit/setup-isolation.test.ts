import { describe, expect, it } from 'vitest';
import { agentCliHome, resolveAgentCliBinary } from '../../tools/examify-ingest/src/generate-api';
import { insideExamifyCheckout } from '../../tools/examify-ingest/src/temp-root';

describe('the unit test environment', () => {
  it('finds no real Claude Code / Codex and passes no headless sign-in token', () => {
    // tests/unit/setup.ts: no suite may ask a developer's own CLI whether it is signed in.
    expect(resolveAgentCliBinary('claude', process.env)).toBeNull();
    expect(resolveAgentCliBinary('codex', process.env)).toBeNull();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(process.env.CODEX_API_KEY).toBeUndefined();
    // Their folders are never the developer's, and never inside the checkout
    // (a check against a fake would be refused there).
    for (const cli of ['claude', 'codex'] as const) {
      const home = agentCliHome(cli, process.env);
      expect(home).toContain('examify-unit-no-agent-cli-home');
      expect(insideExamifyCheckout(home)).toBe(false);
    }
  });
});
