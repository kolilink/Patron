// Dead-code cleanup (demi-fait audit 2026-10-14, §8 + §9) — pins the deletions
// so the two verified-dead surfaces cannot quietly come back:
//
//   §8  src/components/ui/PrivacyWallSheet.tsx — Phase-4 privacy-wall sheet,
//       imported by nothing; ConductBanner never opened it.
//   §9  app/(app)/milestone/phone.tsx — orphaned OTP route, zero navigation
//       references anywhere (its auth-store methods are NOT dead: the
//       (welcome)/creer.tsx signup flow uses the same ones, pinned below).
//
// Hermetic source-level test (fs only), same pattern as
// espaces-publics-no-contact.test.ts.
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function walkSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkSources(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const APP_SOURCES = ['app', 'src', 'stores', 'lib']
  .flatMap(d => walkSources(join(ROOT, d)))
  .map(p => readFileSync(p, 'utf8'));

describe('dead code — demi-fait whites §8/§9 stay deleted', () => {
  it('PrivacyWallSheet file is gone', () => {
    expect(existsSync(join(ROOT, 'src/components/ui/PrivacyWallSheet.tsx'))).toBe(false);
  });

  it('nothing in the app references PrivacyWallSheet', () => {
    for (const src of APP_SOURCES) expect(src).not.toMatch(/PrivacyWallSheet/);
  });

  it('milestone/phone route is gone (whole milestone folder)', () => {
    expect(existsSync(join(ROOT, 'app/(app)/milestone/phone.tsx'))).toBe(false);
    expect(existsSync(join(ROOT, 'app/(app)/milestone'))).toBe(false);
  });

  it('nothing navigates to the milestone route', () => {
    for (const src of APP_SOURCES) expect(src).not.toMatch(/milestone\/phone|MilestonePhoneScreen/);
  });

  it('the shared phone-verification store methods survive (used by (welcome)/creer)', () => {
    const auth = readFileSync(join(ROOT, 'stores/auth.ts'), 'utf8');
    expect(auth).toMatch(/createPhoneVerification/);
    expect(auth).toMatch(/verifyPhoneCode/);
    expect(auth).toMatch(/upgradePhone/);
    const creer = readFileSync(join(ROOT, 'app/(welcome)/creer.tsx'), 'utf8');
    expect(creer).toMatch(/createPhoneVerification/);
    expect(creer).toMatch(/upgradePhone/);
  });
});
