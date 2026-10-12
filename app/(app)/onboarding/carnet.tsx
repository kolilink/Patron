import { readyDebtEntry } from '@/src/utils/debtEntry';
import { useRef, useState, useMemo } from 'react';
import {
  FlatList,
  InputAccessoryView,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { formatAmount, formatAmountInput, parseAmountInput, amountInputToCents } from '@/src/utils/format';
import { useAuthStore } from '@/stores/auth';
import { useSalesStore } from '@/stores/sales';
import { generateId } from '@/lib/id';
import { supabase } from '@/lib/supabase';
import { haptics } from '@/lib/haptics';
import { ensureClient } from '@/lib/writeFunnel';

interface CarnetEntry {
  id: string;
  name: string;
  amountCents: number;
}

// iOS-only: suppresses the OS's auto-injected floating "Done" pill above
// the numeric keyboard — the "+" add button sits immediately next to the
// field, always visible with no scrolling.
const CARNET_SILENT_ACCESSORY_ID = 'onboarding-carnet-silent-accessory';

export default function CarnetScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const { submitCarnetDebt } = useSalesStore();

  const [entries, setEntries] = useState<CarnetEntry[]>([]);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<TextInput>(null);
  const amountRef = useRef<TextInput>(null);

  const totalCents = entries.reduce((s, e) => s + e.amountCents, 0);

  const handleAdd = () => {
    const ready = readyDebtEntry(name, amount, currency);
    if (!ready) return;

    setEntries(prev => [...prev, { id: generateId(), name: ready.name, amountCents: ready.amountCents }]);
    setName('');
    setAmount('');
    haptics.tap();
    setTimeout(() => nameRef.current?.focus(), 30);
  };

  const handleRemove = (id: string) => {
    setEntries(prev => prev.filter(e => e.id !== id));
  };

  const handleSave = async () => {
    if (entries.length === 0) { router.replace('/(app)/(tabs)/'); return; }
    setSaving(true);
    setError(null);
    let failed = 0;
    for (const entry of entries) {
      // Same "resolve or create a real client, then attach the debt to it"
      // step vendre.tsx's own carnet tab does — without this, a bulk-imported
      // debt book has no client_id at all, and the balance shown for these
      // same customers later reads as understated or zero (see migration_v168.sql).
      //
      // A failure here (including a network timeout) must never abort the
      // loop or leave `saving` stuck true forever — it's treated the same
      // as a failed submitCarnetDebt call: this one entry counts as failed,
      // the rest of the batch still gets a chance to save.
      // Device-first: the client upsert is queued durably (never fails offline); the id, when the server
      // already confirmed it, links the debt — otherwise the drain links it by name.
      const clientId: string | null = (await ensureClient({ businessId, name: entry.name })) ?? null;
      const submitted = await submitCarnetDebt(businessId, userId, entry.name, entry.amountCents, clientId);
      if (!submitted.ok) failed++;
    }
    setSaving(false);
    if (failed > 0) {
      setError(`${failed} entrée${failed > 1 ? 's' : ''} n'ont pas pu être enregistrées. Réessayez.`);
      return;
    }
    router.replace('/(app)/(tabs)/');
  };

  const canAdd = readyDebtEntry(name, amount, currency) !== null;

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, backgroundColor: palette.background }}
        keyboardVerticalOffset={0}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text variant="h3">L'argent qu'on me doit</Text>
          {entries.length > 0 && (
            <Pressable onPress={() => router.replace('/(app)/(tabs)/')} hitSlop={12}>
              <Text variant="body" color="secondary">Passer</Text>
            </Pressable>
          )}
        </View>

        {/* Entry inputs */}
        <View style={styles.inputRow}>
          <TextInput
            ref={nameRef}
            style={[styles.inputName, { color: palette.textPrimary, borderColor: palette.border }]}
            placeholder="Nom"
            placeholderTextColor={palette.textDisabled}
            value={name}
            onChangeText={setName}
            returnKeyType="next"
            onSubmitEditing={() => amountRef.current?.focus()}
            autoFocus
            autoCapitalize="words"
          />
          <TextInput
            ref={amountRef}
            style={[styles.inputAmount, { color: palette.textPrimary, borderColor: palette.border }]}
            placeholder="Montant"
            placeholderTextColor={palette.textDisabled}
            value={amount}
            onChangeText={v => setAmount(formatAmountInput(v, currency))}
            keyboardType="numeric"
            returnKeyType="done"
            onSubmitEditing={handleAdd}
            inputAccessoryViewID={Platform.OS === 'ios' ? CARNET_SILENT_ACCESSORY_ID : undefined}
          />
          <Pressable hitSlop={4}
            style={[styles.addBtn, { backgroundColor: canAdd ? palette.primary : palette.border }]}
            onPress={handleAdd}
            disabled={!canAdd}
          >
            <Text variant="label" style={{ color: palette.textInverse }}>+</Text>
          </Pressable>
        </View>

        <View style={styles.divider} />

        {/* Entry list */}
        <FlatList
          data={entries}
          keyExtractor={e => e.id}
          keyboardShouldPersistTaps="always"
          style={{ flex: 1 }}
          contentContainerStyle={entries.length === 0 ? styles.emptyList : styles.list}
          renderItem={({ item }) => (
            <View style={styles.entryRow}>
              <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>{item.name}</Text>
              <Text variant="label" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
                {formatAmount(item.amountCents / 100, currency)}
              </Text>
              <Pressable onPress={() => handleRemove(item.id)} hitSlop={10}>
                <Text variant="body" color="secondary" style={{ paddingLeft: spacing[3] }}>×</Text>
              </Pressable>
            </View>
          )}
          ListEmptyComponent={
            <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
              Ajoutez une première entrée ci-dessus
            </Text>
          }
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
          // CTA ends the list (end-of-flow), no dead gap below a short list
          ListFooterComponent={
        <View style={styles.footer}>
          {entries.length > 0 && (
            <Text variant="caption" color="secondary" style={styles.total} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
              {entries.length} personne{entries.length > 1 ? 's' : ''} · {formatAmount(totalCents / 100, currency)}
            </Text>
          )}
          {error && (
            <Text variant="caption" color="danger" style={{ textAlign: 'center', marginBottom: spacing[2] }}>
              {error}
            </Text>
          )}
          <Button
            label={entries.length === 0 ? 'Passer' : "C'est bon !"}
            onPress={handleSave}
            loading={saving}
            fullWidth
            size="lg"
          />
        </View>
          }
        />

      </KeyboardAvoidingView>
      {Platform.OS === 'ios' && (
        <InputAccessoryView nativeID={CARNET_SILENT_ACCESSORY_ID}>
          <View style={{ height: 0 }} />
        </InputAccessoryView>
      )}
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingTop: spacing[4], paddingBottom: spacing[3],
    },
    inputRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      paddingHorizontal: spacing[5], paddingVertical: spacing[3],
    },
    inputName: {
      flex: 1, borderWidth: 1, borderRadius: radius.md,
      paddingHorizontal: spacing[3], paddingVertical: spacing[3],
      fontSize: 15,
    },
    inputAmount: {
      width: 110, borderWidth: 1, borderRadius: radius.md,
      paddingHorizontal: spacing[3], paddingVertical: spacing[3],
      fontSize: 15,
    },
    addBtn: {
      width: 44, height: 44, borderRadius: radius.md,
      alignItems: 'center', justifyContent: 'center',
    },
    divider: { height: 1, backgroundColor: 'rgba(0,0,0,0.1)', marginHorizontal: spacing[5] },
    list: { paddingBottom: spacing[4] },
    emptyList: { alignItems: 'center', justifyContent: 'center', padding: spacing[8] },
    entryRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingHorizontal: spacing[5], paddingVertical: spacing[3],
      backgroundColor: p.surface,
    },
    footer: {
      paddingHorizontal: spacing[5], paddingBottom: spacing[4], paddingTop: spacing[3],
      gap: spacing[2],
    },
    total: { textAlign: 'center' },
  });
}
