// Pure helpers shared by the phone-OTP edge functions. Plain TS (no Deno APIs,
// no URL imports) so Jest can import it.

/**
 * App Store / Google reviewer bypass (see create-phone-verification): the
 * numbers in the DEMO_PHONE / DEMO_PHONES secrets skip the WhatsApp send and
 * receive a fixed code. The numbers themselves live ONLY in the secrets.
 */
export function isDemoPhone(phone: string, demoPhone: string, demoPhones: string): boolean {
  const p = phone.trim();
  const list = demoPhones.split(',').map((x) => x.trim()).filter(Boolean);
  return (demoPhone !== '' && p === demoPhone) || list.includes(p);
}

/**
 * Which profile does a verified phone log in as?
 *  - a profile that owns this phone number (normal returning user);
 *  - ONLY for the reviewer demo number, the profile of the anonymous session
 *    that started the verification (the demo account has no phone on file).
 * Any other number with no owner returns null -> "no account for this number".
 * (create-phone-verification no longer answers that question up front — Phase 9
 * Finding 1 — so this is where a login on an unknown number is refused, after
 * the caller has proven they hold the number. Without the demo-only rule the
 * old "fresh install" fallback would have logged an unknown number into the
 * caller's own empty anonymous profile.)
 */
export function pickRestoreProfileId(opts: {
  profileByPhone: string | null;
  profileByVerifUser: string | null;
  isDemo: boolean;
}): string | null {
  if (opts.profileByPhone) return opts.profileByPhone;
  return opts.isDemo ? opts.profileByVerifUser : null;
}
