// Client-side mirror of the is_founder() SQL check (db/migration_v126.sql) —
// defense-in-depth only, same posture as the investisseur tab-hiding pattern.
// RLS is the real enforcement; this just keeps the founder-only screens from
// flashing content before a redirect for everyone else.
const FOUNDER_PHONE_DIGITS = '12672421843';

export function isFounderPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  return phone.replace(/\D/g, '') === FOUNDER_PHONE_DIGITS;
}
