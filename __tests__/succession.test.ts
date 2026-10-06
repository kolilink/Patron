// Delete & leave flows, client side (the SQL matrix itself is proven in
// __tests__/integration/leave-delete-matrix.integration.test.ts against a real Postgres).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  planLeave, successionBlockers, successionBody, SUCCESSION_TITLE, ACCOUNT_DELETION_CANCELLED_TOAST,
} from '@/src/utils/succession';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('planLeave mirrors the server matrix', () => {
  it('non-admin roles just leave', () => {
    for (const r of ['manager', 'vendeur', 'investisseur']) {
      expect(planLeave(r, [])).toBe('leave');
      expect(planLeave(r, [{ role: 'vendeur' }])).toBe('leave');
    }
  });
  it('administrateur alone → quitting deletes the business', () => {
    expect(planLeave('administrateur', [])).toBe('delete_business');
  });
  it('administrateur + team + another administrateur → plain leave', () => {
    expect(planLeave('administrateur', [{ role: 'vendeur' }, { role: 'administrateur' }])).toBe('leave');
  });
  it('last administrateur + team → succession (a manager is not an administrateur)', () => {
    expect(planLeave('administrateur', [{ role: 'vendeur' }])).toBe('succession');
    expect(planLeave('administrateur', [{ role: 'manager' }, { role: 'investisseur' }])).toBe('succession');
  });
});

describe('account deletion blockers', () => {
  const admin = [{ business_id: 'a', name: 'Alpha' }, { business_id: 'b', name: 'Bêta' }, { business_id: 'c', name: 'Gamma' }];
  it('only sole-admin-with-a-team businesses block; solo and co-admin ones do not', () => {
    const blockers = successionBlockers(admin, {
      a: [{ role: 'vendeur' }],                             // blocks
      b: [{ role: 'administrateur' }, { role: 'vendeur' }], // co-admin: fine
      // c: nobody else: fine
    });
    expect(blockers.map(b => b.name)).toEqual(['Alpha']);
  });
});

describe('copy', () => {
  it('title and body are exactly the approved sentences', () => {
    expect(SUCCESSION_TITLE).toBe('Désignez un successeur');
    expect(successionBody('Chez Awa')).toBe(
      'Vous êtes le seul gérant de Chez Awa. Choisissez qui reprend le commerce avant de quitter — vos vendeurs garderont leur accès.');
  });
  it('the login-cancel toast is the approved sentence and is the one auth.ts shows', () => {
    expect(ACCOUNT_DELETION_CANCELLED_TOAST).toBe('Bon retour — la suppression de votre compte a été annulée.');
    expect(read('stores/auth.ts')).toMatch(/toast\.success\(ACCOUNT_DELETION_CANCELLED_TOAST\)/);
  });
});

describe('settings screen wiring', () => {
  const src = read('app/(app)/parametres/index.tsx');
  it('no longer tells an admin to remove their team', () => {
    expect(src).not.toMatch(/Retirez-les avant de quitter/);
    expect(src).not.toMatch(/Retirez tous les autres membres/);
  });
  it('asks the plan first, and opens the succession sheet for the last gérant', () => {
    expect(src).toMatch(/planLeave\('administrateur'/);
    expect(src).toMatch(/successionBlockers\(/);
    expect(src).toMatch(/<SuccessionSheet/);
  });
  it('after promotion it carries on to the leave confirmation / the account-deletion confirmation', () => {
    expect(src).toMatch(/next\?\.then === 'leave'\) setTimeout\(\(\) => handleLeave\(\)/);
    expect(src).toMatch(/next\?\.then === 'account'\) \{ resetDeleteFlow\(\); setDeleteTarget\('account'\)/);
  });
  it('account deletion signs out and wipes local data immediately, before any alert', () => {
    const iLogout = src.indexOf('await useAuthStore.getState().logout();');
    const iWipe = src.indexOf('await wipeAccountLocalData()');
    const iAlert = src.indexOf("'Compte programmé pour suppression'");
    expect(iLogout).toBeGreaterThan(-1);
    expect(iLogout).toBeLessThan(iWipe);
    expect(iWipe).toBeLessThan(iAlert);
  });
});

describe('zero businesses → a real choice, same account', () => {
  const src = read('app/(app)/onboarding/index.tsx');
  it('offers both "Ajouter mon commerce" and "Rejoindre un commerce" and never redirects away to a create-only form', () => {
    expect(src).toMatch(/label="Ajouter mon commerce"/);
    expect(src).toMatch(/label="Rejoindre un commerce"/);
    expect(src).toMatch(/\/\(app\)\/onboarding\/creer/);
    expect(src).toMatch(/\/\(app\)\/onboarding\/rejoindre/);
    expect(src).not.toMatch(/router\.replace\('\/\(app\)\/onboarding\/creer'\)/);
  });
});

describe('wipeAccountLocalData SQL (run against a real sqlite3)', () => {
  const dbSrc = read('lib/db.ts');
  const sqlite = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
  (sqlite.status === 0 ? it : it.skip)('empties every cache/outbox table and every kv row except device-level settings', () => {
    // the statements must be exactly what the function runs
    expect(dbSrc).toMatch(/name NOT LIKE 'sqlite_%' AND name NOT IN \('_migrations', 'kv_store'\)/);
    expect(dbSrc).toMatch(/DELETE FROM kv_store WHERE key NOT IN \(\$\{marks\}\)/);
    const { DEVICE_LEVEL_KV_KEYS } = jest.requireActual('@/lib/db') as { DEVICE_LEVEL_KV_KEYS: string[] };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wipe-')), 't.db');
    const q = (sql: string) => spawnSync('sqlite3', [file, sql], { encoding: 'utf8' }).stdout.trim();
    q(`CREATE TABLE _migrations (version INTEGER); INSERT INTO _migrations VALUES (19);
       CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       CREATE TABLE ventes_cache (id TEXT); INSERT INTO ventes_cache VALUES ('x');
       CREATE TABLE sync_queue (id INTEGER); INSERT INTO sync_queue VALUES (1);
       CREATE TABLE dead_ops (id INTEGER); INSERT INTO dead_ops VALUES (1);
       INSERT INTO kv_store VALUES ('patron_last_phone','+224'), ('last_login_phone','+224'), ('app_theme_preference','dark'),
                                   ('analytics_device_id','abc'), ('draft_x','hello');`);
    const keys = DEVICE_LEVEL_KV_KEYS.map(k => `'${k}'`).join(',');
    q(`DELETE FROM ventes_cache; DELETE FROM sync_queue; DELETE FROM dead_ops; DELETE FROM kv_store WHERE key NOT IN (${keys});`);
    expect(q('SELECT count(*) FROM ventes_cache') + q('SELECT count(*) FROM sync_queue') + q('SELECT count(*) FROM dead_ops')).toBe('000');
    expect(q('SELECT count(*) FROM _migrations')).toBe('1');
    expect(q('SELECT key FROM kv_store ORDER BY key').split('\n')).toEqual(['analytics_device_id', 'app_theme_preference']);
  });
});
