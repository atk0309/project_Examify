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
      'Written answers are marked by Claude Code.',
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
      'this server needs EXAMIFY_LLM_BASE_URL and EXAMIFY_LLM_MODEL set',
    );
    expect(screen.getByTestId('parent-marking')).not.toHaveTextContent(/later|shortly/i);

    rerender(
      <ParentDashboard students={[]} ownProgress={empty} ownHistory={[]} authMode="password" />,
    );
    expect(screen.queryByTestId('parent-marking')).toBeNull();
  });
});
