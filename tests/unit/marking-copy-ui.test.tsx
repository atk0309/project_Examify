/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/actions/toggleStudentMode', () => ({ setStudentMode: vi.fn() }));
vi.mock('@/actions/signOut', () => ({ signOut: vi.fn() }));
vi.mock('@/actions/createInvite', () => ({ createInvite: vi.fn() }));
vi.mock('@/actions/removeMember', () => ({ removeMember: vi.fn() }));
vi.mock('@/actions/revokeInvite', () => ({ revokeInvite: vi.fn() }));

const { ParentDashboard } = await import('@/components/exam/ParentDashboard');
const { parentMarkingLine } = await import('@/lib/onboarding-types');

afterEach(() => cleanup());

const empty = { attempts: [], subjects: [] };

describe('parent dashboard marking line', () => {
  it('says who marks written answers, and what is missing when nothing can', () => {
    const { rerender } = render(
      <ParentDashboard
        students={[]}
        ownProgress={empty}
        ownHistory={[]}
        authMode="password"
        markingLine={parentMarkingLine('claude-cli', 'ready')}
      />,
    );
    expect(screen.getByTestId('parent-marking')).toHaveTextContent(
      'Written answers are marked by Claude Code while it is signed in on this server. Signed out, they count as not correct.',
    );

    rerender(
      <ParentDashboard
        students={[]}
        ownProgress={empty}
        ownHistory={[]}
        authMode="password"
        markingLine={parentMarkingLine('local-endpoint', 'not_ready')}
      />,
    );
    expect(screen.getByTestId('parent-marking')).toHaveTextContent(
      'this server needs EXAMIFY_LLM_BASE_URL (an http or https address) and EXAMIFY_LLM_MODEL set',
    );
    expect(screen.getByTestId('parent-marking')).not.toHaveTextContent(/later|shortly/i);
    expect(screen.getByTestId('parent-marking')).toHaveTextContent(
      'Until then, exams leave written questions out (a bank with only written questions keeps them), and any written answer counts as not correct.',
    );

    // Claude Code found but signed out: the line names the sign-in command.
    rerender(
      <ParentDashboard
        students={[]}
        ownProgress={empty}
        ownHistory={[]}
        authMode="password"
        markingLine={parentMarkingLine('claude-cli', 'not_ready', true)}
      />,
    );
    expect(screen.getByTestId('parent-marking')).toHaveTextContent(
      'Written answers are not marked: Claude Code is not signed in on this server. As the user that runs Examify, run `claude auth login`.',
    );

    rerender(
      <ParentDashboard students={[]} ownProgress={empty} ownHistory={[]} authMode="password" />,
    );
    expect(screen.queryByTestId('parent-marking')).toBeNull();
  });
});
