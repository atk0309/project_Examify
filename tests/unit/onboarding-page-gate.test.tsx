import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  session: { userId: 42, role: 'parent' } as {
    userId?: number;
    role?: string;
    studentMode?: boolean;
  },
  gateCheck: vi.fn(),
  gate: { ok: true, householdId: 7 } as { ok: boolean; householdId?: number; reason?: string },
  snapshot: vi.fn(async (_householdId: number) => ({})),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock('@/components/exam/OnboardingWizard', () => ({ OnboardingWizard: () => null }));
vi.mock('@/lib/auth', () => ({ getSession: async () => fixture.session }));
vi.mock('@/lib/env', () => ({ isSoloMode: () => true, getAuthMode: () => 'password' }));
vi.mock('@/lib/households', () => ({
  hasAnyHousehold: () => true,
  canInvite: () => false,
  canRemoveMember: () => false,
  getMembershipForUser: () => ({ userId: 42, householdId: 7, role: 'admin' }),
  labelFromEmail: () => '',
  listHouseholdMembers: () => [],
  listPendingInvites: () => [],
}));
vi.mock('@/lib/onboarding-admin', () => ({
  requireOnboardingAdmin: async () => {
    fixture.gateCheck();
    return fixture.gate;
  },
}));
vi.mock('@/lib/onboarding', () => ({
  getOnboardingPageSnapshot: (householdId: number) => fixture.snapshot(householdId),
}));
import OnboardingPage from '@/app/onboarding/page';

beforeEach(() => {
  fixture.session = { userId: 42, role: 'parent' };
  fixture.gate = { ok: true, householdId: 7 };
  fixture.snapshot.mockClear();
  fixture.gateCheck.mockClear();
});
describe('onboarding page uses the same verified identity gate as mutations', () => {
  it('loads only the household returned by the verified admin gate', async () => {
    await OnboardingPage();
    expect(fixture.gateCheck).toHaveBeenCalledExactlyOnceWith();
    expect(fixture.snapshot).toHaveBeenCalledExactlyOnceWith(7);
  });
  it.each(['forbidden', 'already_complete'])(
    'does not read content after gate rejection: %s',
    async (reason) => {
      fixture.gate = { ok: false, reason };
      await expect(OnboardingPage()).rejects.toThrow('redirect:/');
      expect(fixture.gateCheck).toHaveBeenCalledExactlyOnceWith();
      expect(fixture.snapshot).not.toHaveBeenCalled();
    },
  );
  it('does not load a content snapshot for an unsigned session', async () => {
    fixture.session = {};
    await expect(OnboardingPage()).rejects.toThrow('redirect:/signin');
    expect(fixture.gateCheck).not.toHaveBeenCalled();
    expect(fixture.snapshot).not.toHaveBeenCalled();
  });
  it('passes no author questions or grading details on the initial page render', async () => {
    const page = await OnboardingPage();
    const wizard = page.props.children.props.children;
    expect(Object.keys(wizard.props).sort()).toEqual([
      'authMode',
      'canInvite',
      'members',
      'pendingInvites',
      'snapshot',
      'solo',
    ]);
    expect(JSON.stringify(wizard.props)).not.toMatch(
      /"(?:answer|rubric|provenance|authorPreview|planned|bankIr)"/,
    );
  });
  it('does not render the wizard after a parent-role Student View is rejected', async () => {
    fixture.session = { userId: 42, role: 'parent', studentMode: true };
    fixture.gate = { ok: false, reason: 'forbidden' };
    await expect(OnboardingPage()).rejects.toThrow('redirect:/');
    expect(fixture.gateCheck).toHaveBeenCalledExactlyOnceWith();
    expect(fixture.snapshot).not.toHaveBeenCalled();
  });
});
