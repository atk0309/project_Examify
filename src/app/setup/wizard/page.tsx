import { redirect } from 'next/navigation';

/** Leftover PR #56 path — content onboarding lives at /onboarding. */
export default function LegacySetupWizardRedirect() {
  redirect('/onboarding');
}
