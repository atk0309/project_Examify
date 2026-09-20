/**
 * S8 layout contract: Anthropic Save / Rotate / Clear stay reachable above
 * the sticky Back/Next footer. Shared by unit fixtures and the 1100×800 e2e
 * so proofs compare real boxes, not CSS source strings.
 *
 * Token values match `src/app/globals.css` `@theme` + `.wizard-shell`
 * (`--tap-min` 48, `--sp-4` 16, `--sp-5` 20, `--sp-6` 24, `--sp-8` 32).
 */

export type LayoutBox = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

export type ViewportBox = {
  width: number;
  height: number;
};

/** Subpixel slack for getBoundingClientRect rounding. */
export const LAYOUT_EPSILON_PX = 0.5;

/** Desktop (≥900px) `--wizard-footer-clearance`: tap-min + sp-4 + sp-6. */
export const DESKTOP_FOOTER_CLEARANCE_PX = 48 + 16 + 24;

/** Default / tablet (<900px) `--wizard-footer-clearance`: tap-min + sp-4 + sp-5. */
export const TABLET_FOOTER_CLEARANCE_PX = 48 + 16 + 20;

/** `.app-frame` vertical margin at 540–899px (`--sp-8`). */
export const TABLET_FRAME_MARGIN_Y_PX = 32;

/** `.app-frame-wizard` vertical margin at ≥900px (`--sp-6`). */
export const DESKTOP_FRAME_MARGIN_Y_PX = 24;

export const DESKTOP_AI_VIEWPORT = { width: 1100, height: 800 } as const;
export const TABLET_AI_VIEWPORT = { width: 720, height: 800 } as const;

export function isEmptyLayoutBox(box: LayoutBox): boolean {
  return box.width === 0 && box.height === 0 && box.top === 0 && box.left === 0;
}

export function boxesOverlap(a: LayoutBox, b: LayoutBox, epsilon = LAYOUT_EPSILON_PX): boolean {
  return !(
    a.right <= b.left + epsilon ||
    a.left >= b.right - epsilon ||
    a.bottom <= b.top + epsilon ||
    a.top >= b.bottom - epsilon
  );
}

/** Control sits entirely above the footer (the S8 “reachable above sticky chrome” rule). */
export function boxIsAbove(
  control: LayoutBox,
  footer: LayoutBox,
  epsilon = LAYOUT_EPSILON_PX,
): boolean {
  return control.bottom <= footer.top + epsilon;
}

export function boxIntersectsViewport(
  box: LayoutBox,
  viewport: ViewportBox,
  epsilon = LAYOUT_EPSILON_PX,
): boolean {
  return (
    box.width > epsilon &&
    box.height > epsilon &&
    box.bottom > epsilon &&
    box.top < viewport.height - epsilon &&
    box.right > epsilon &&
    box.left < viewport.width - epsilon
  );
}

export type SecretActionClearance = {
  ok: boolean;
  overlap: boolean;
  aboveFooter: boolean;
  inViewport: boolean;
  hitControl: boolean;
};

export function evaluateSecretActionClearance(args: {
  control: LayoutBox;
  footer: LayoutBox;
  viewport: ViewportBox;
  hitIsControl: boolean;
}): SecretActionClearance {
  const overlap = boxesOverlap(args.control, args.footer);
  const aboveFooter = boxIsAbove(args.control, args.footer);
  const inViewport = boxIntersectsViewport(args.control, args.viewport);
  return {
    ok: !overlap && aboveFooter && inViewport && args.hitIsControl,
    overlap,
    aboveFooter,
    inViewport,
    hitControl: args.hitIsControl,
  };
}

/** Locked wizard frame + inherited vertical margins must fit the first viewport. */
export function wizardFrameFitsViewport(args: {
  frameHeight: number;
  marginTop: number;
  marginBottom: number;
  viewportHeight: number;
}): boolean {
  return (
    args.marginTop + args.frameHeight + args.marginBottom <= args.viewportHeight + LAYOUT_EPSILON_PX
  );
}

export function desktopWizardMaxFrameHeight(viewportHeight: number): number {
  return viewportHeight - 2 * DESKTOP_FRAME_MARGIN_Y_PX;
}

export function tabletWizardMaxFrameHeight(viewportHeight: number): number {
  return viewportHeight - 2 * TABLET_FRAME_MARGIN_Y_PX;
}
