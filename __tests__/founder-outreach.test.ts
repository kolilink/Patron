import * as fs from 'fs';
import * as path from 'path';
import { OUTREACH_CHANNELS, outreachParams } from '@/src/utils/founderOutreach';
import { DIRECTORY_FILTERS, filterRows, parseFilter, whatsappUrl, whatsappMessage, type DirectoryRow } from '@/src/utils/founderDirectory';

describe('outreach log payload', () => {
  it('blanks become null and text is trimmed', () => {
    expect(outreachParams({ channel: 'appel', name: '  Mariama ', note: '   ' })).toEqual({
      p_channel: 'appel', p_contact_name: 'Mariama', p_note: null,
    });
  });

  it('the channel list matches the SQL CHECK in migration_v238', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db/migration_v238.sql'), 'utf8');
    const m = sql.match(/channel\s+text NOT NULL CHECK \(channel IN \(([^)]*)\)\)/)!;
    const sqlChannels = m[1].split(',').map(s => s.trim().replace(/'/g, ''));
    expect(OUTREACH_CHANNELS.map(c => c.key)).toEqual(sqlChannels);
  });
});

const NOW = new Date('2026-10-06T12:00:00Z').getTime();
const row = (o: Partial<DirectoryRow>): DirectoryRow => ({
  business_id: 'b', business_name: 'Chez Awa', owner_name: 'Awa Diallo', owner_phone: '+224 620 00 00 01',
  created_at: '2026-09-01T00:00:00Z', first_value_at: '2026-09-02T00:00:00Z', last_action_at: '2026-09-20T00:00:00Z',
  actions_7d: 0, lost: false, ...o,
});

describe('vendor directory', () => {
  it('filters: perdus, nouveaux (7 j), tous', () => {
    const rows = [
      row({ business_id: 'lost', lost: true }),
      row({ business_id: 'new', created_at: '2026-10-04T00:00:00Z', first_value_at: null }),
      row({ business_id: 'ok' }),
    ];
    expect(filterRows(rows, 'perdus', NOW).map(r => r.business_id)).toEqual(['lost']);
    expect(filterRows(rows, 'nouveaux', NOW).map(r => r.business_id)).toEqual(['new']);
    expect(filterRows(rows, 'tous', NOW)).toHaveLength(3);
    expect(DIRECTORY_FILTERS.map(f => f.key)).toEqual(['tous', 'perdus', 'nouveaux']);
  });

  it('parseFilter tolerates junk and arrays', () => {
    expect(parseFilter('perdus')).toBe('perdus');
    expect(parseFilter(['nouveaux'])).toBe('nouveaux');
    expect(parseFilter('nope')).toBe('tous');
    expect(parseFilter(undefined)).toBe('tous');
  });

  it('builds a wa.me link from digits only, with a message that fits where the vendor is', () => {
    const url = whatsappUrl(row({ lost: true }), NOW)!;
    expect(url.startsWith('https://wa.me/224620000001?text=')).toBe(true);
    expect(decodeURIComponent(url)).toContain('Bonjour Awa');
    expect(whatsappMessage(row({ lost: true }), NOW)).toContain("qu'est-ce qui vous a manqué");
    expect(whatsappMessage(row({ created_at: '2026-10-04T00:00:00Z', first_value_at: null }), NOW)).toContain('Merci d\'avoir ouvert');
    expect(whatsappUrl(row({ owner_phone: null }), NOW)).toBeNull();
  });
});
