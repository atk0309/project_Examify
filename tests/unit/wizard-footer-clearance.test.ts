import { describe, expect, it } from 'vitest';
import {
  DESKTOP_AI_VIEWPORT,
  DESKTOP_FOOTER_CLEARANCE_PX,
  DESKTOP_FRAME_MARGIN_Y_PX,
  TABLET_AI_VIEWPORT,
  TABLET_FOOTER_CLEARANCE_PX,
  TABLET_FRAME_MARGIN_Y_PX,
  boxIsAbove,
  boxesOverlap,
  desktopWizardMaxFrameHeight,
  evaluateSecretActionClearance,
  isEmptyLayoutBox,
  tabletWizardMaxFrameHeight,
  wizardFrameFitsViewport,
  type LayoutBox,
} from '../helpers/wizard-footer-clearance';

function box(top: number, left: number, width: number, height: number): LayoutBox {
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

describe('S8 wizard footer clearance contract', () => {
  it('keeps desktop clearance at tap-min + footer padding (88px)', () => {
    expect(DESKTOP_FOOTER_CLEARANCE_PX).toBe(88);
    expect(TABLET_FOOTER_CLEARANCE_PX).toBe(84);
    expect(DESKTOP_FRAME_MARGIN_Y_PX).toBe(24);
    expect(TABLET_FRAME_MARGIN_Y_PX).toBe(32);
  });

  it('locks the 1100×800 frame below the viewport after 2× --sp-6 margins', () => {
    expect(desktopWizardMaxFrameHeight(DESKTOP_AI_VIEWPORT.height)).toBe(752);
    expect(
      wizardFrameFitsViewport({
        frameHeight: 752,
        marginTop: DESKTOP_FRAME_MARGIN_Y_PX,
        marginBottom: DESKTOP_FRAME_MARGIN_Y_PX,
        viewportHeight: DESKTOP_AI_VIEWPORT.height,
      }),
    ).toBe(true);
    expect(
      wizardFrameFitsViewport({
        frameHeight: 800,
        marginTop: DESKTOP_FRAME_MARGIN_Y_PX,
        marginBottom: DESKTOP_FRAME_MARGIN_Y_PX,
        viewportHeight: DESKTOP_AI_VIEWPORT.height,
      }),
    ).toBe(false);
  });

  it('locks the 540–899 tablet frame below the viewport after 2× --sp-8 margins', () => {
    expect(tabletWizardMaxFrameHeight(TABLET_AI_VIEWPORT.height)).toBe(736);
    expect(
      wizardFrameFitsViewport({
        frameHeight: 736,
        marginTop: TABLET_FRAME_MARGIN_Y_PX,
        marginBottom: TABLET_FRAME_MARGIN_Y_PX,
        viewportHeight: TABLET_AI_VIEWPORT.height,
      }),
    ).toBe(true);
    expect(
      wizardFrameFitsViewport({
        frameHeight: 800,
        marginTop: TABLET_FRAME_MARGIN_Y_PX,
        marginBottom: TABLET_FRAME_MARGIN_Y_PX,
        viewportHeight: TABLET_AI_VIEWPORT.height,
      }),
    ).toBe(false);
  });

  it('accepts a 1100×800 Clear/Rotate/Save stack that sits above the sticky footer', () => {
    const footer = box(712, 260, 580, 88);
    const save = box(656, 280, 120, 48);
    const rotate = box(656, 408, 96, 48);
    const clear = box(656, 512, 88, 48);

    for (const control of [save, rotate, clear]) {
      expect(boxesOverlap(control, footer)).toBe(false);
      expect(boxIsAbove(control, footer)).toBe(true);
      expect(
        evaluateSecretActionClearance({
          control,
          footer,
          viewport: DESKTOP_AI_VIEWPORT,
          hitIsControl: true,
        }),
      ).toEqual({
        ok: true,
        overlap: false,
        aboveFooter: true,
        inViewport: true,
        hitControl: true,
      });
    }
  });

  it('rejects a mashy toBeVisible case where Clear is covered by the footer', () => {
    const footer = box(712, 260, 580, 88);
    const clearUnderFooter = box(740, 512, 88, 48);

    expect(boxesOverlap(clearUnderFooter, footer)).toBe(true);
    expect(boxIsAbove(clearUnderFooter, footer)).toBe(false);
    expect(
      evaluateSecretActionClearance({
        control: clearUnderFooter,
        footer,
        viewport: DESKTOP_AI_VIEWPORT,
        hitIsControl: false,
      }),
    ).toEqual({
      ok: false,
      overlap: true,
      aboveFooter: false,
      inViewport: true,
      hitControl: false,
    });
  });

  it('treats jsdom empty rects as unproven layout, not a pass', () => {
    const empty = box(0, 0, 0, 0);
    expect(isEmptyLayoutBox(empty)).toBe(true);
    expect(
      evaluateSecretActionClearance({
        control: empty,
        footer: empty,
        viewport: DESKTOP_AI_VIEWPORT,
        hitIsControl: true,
      }).ok,
    ).toBe(false);
  });
});
