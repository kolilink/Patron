// Carnet ledger virtualization (2026-10-16): a debtor's Historique is the
// app's #1 retention surface and entries accumulate unboundedly per
// client. The screen used to mount every line at once
// ({ledgerEntries.map(...)} inside one page ScrollView). The fix converts
// the page to a FlatList with the ledger entries as its data — how rows
// mount changes, what the page looks like never does. Locked design kept:
// one row per entry, newest first, no day-grouping, no sections, no
// pagination.
import { readFileSync } from 'fs';
import { join } from 'path';

const SCREEN = readFileSync(
  join(__dirname, '..', 'app/(app)/clients/[name].tsx'),
  'utf8',
);

describe('the ledger renders through a FlatList, not a ScrollView map', () => {
  it('the screen imports FlatList, not ScrollView', () => {
    expect(SCREEN).toContain('FlatList');
    expect(SCREEN).not.toMatch(/from 'react-native'[^;]*\bScrollView\b/);
    expect(SCREEN).not.toContain('<ScrollView');
  });

  it('the FlatList is fed the ledger entries with a stable key', () => {
    expect(SCREEN).toContain('data={ledgerEntries}');
    expect(SCREEN).toContain('keyExtractor={entry => entry.key}');
    expect(SCREEN).toContain('renderItem={renderLedgerRow}');
  });

  it('no entry is mounted via .map anywhere in the screen', () => {
    expect(SCREEN).not.toContain('ledgerEntries.map');
  });

  it('everything that sat above the ledger is the list header', () => {
    expect(SCREEN).toContain('ListHeaderComponent={ledgerHeader}');
    const header = SCREEN.slice(
      SCREEN.indexOf('const ledgerHeader = ('),
      SCREEN.indexOf('const renderLedgerRow = ('),
    );
    expect(header).toContain('styles.debtCard'); // status banner
    expect(header).toContain('newCreditBtn'); // "+ Crédit"
    expect(header).toContain('contactRow'); // Rappeler / Appeler
  });

  it('the empty state is the list empty component (header still renders)', () => {
    expect(SCREEN).toContain('ListEmptyComponent={');
    expect(SCREEN).toContain('Aucun crédit pour le moment.');
  });

  it('rows stay hairline-adjacent: the content gap is zeroed, the header re-applies its own spacing', () => {
    expect(SCREEN).toContain('contentContainerStyle={[styles.content, { gap: 0 }]}');
    expect(SCREEN).toMatch(/ledgerHeader:\s*\{\s*gap:\s*spacing\[4\],\s*marginBottom:\s*spacing\[4\]/);
  });
});

describe('the carnet design is untouched', () => {
  it('one row per entry with the paper-carnet markers', () => {
    expect(SCREEN).toContain('styles.carnetRow');
    expect(SCREEN).toContain('borderBottomWidth: StyleSheet.hairlineWidth');
    expect(SCREEN).toContain("entry.kind === 'credit' ? 'Donné' : 'Reçu'");
    expect(SCREEN).toContain('Reste : {fmt(entry.reste, currency)}');
    expect(SCREEN).toContain('Réglé ✓');
  });

  it('a tap on a line still opens the read-only detail sheet', () => {
    expect(SCREEN).toContain('onPress={() => setDetailEntry(entry)}');
  });

  it('there is no grouping: no sections, no day headers, no pagination affordance', () => {
    expect(SCREEN).not.toContain('SectionList');
    expect(SCREEN).not.toContain('ListFooterComponent');
  });
});
