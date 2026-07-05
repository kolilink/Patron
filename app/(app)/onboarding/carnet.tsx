import { useRef, useState, useMemo } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { formatAmount, formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { useAuthStore } from '@/stores/auth';
import { useSalesStore } from '@/stores/sales';
import { generateId } from '@/lib/id';

interface CarnetEntry {
  id: string;
  name: string;
  amountCents: number;
}

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
    const trimmedName = name.trim();
    const parsed = Math.round(parseAmountInput(amount));
    if (!trimmedName || isNaN(parsed) || parsed <= 0) return;

    setEntries(prev => [...prev, { id: generateId(), name: trimmedName, amountCents: parsed * 100 }]);
    setName('');
    setAmount('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
      const ok = await submitCarnetDebt(businessId, userId, entry.name, entry.amountCents);
      if (!ok) failed++;
    }
    setSaving(false);
    if (failed > 0) {
      setError(`${failed} entrée${failed > 1 ? 's' : ''} n'ont pas pu être enregistrées. Réessayez.`);
      return;
    }
    router.replace('/(app)/(tabs)/');
  };

  const canAdd = name.trim().length > 0 && parseAmountInput(amount) > 0;

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
        keyboardVerticalOffset={0}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text variant="h3">Mes dettes en cours</Text>
          <Pressable onPress={() => router.replace('/(app)/(tabs)/') } hitSlop={12}>
            <Text variant="body" color="secondary">Passer</Text>
          </Pressable>
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
            onChangeText={v => setAmount(formatAmountInput(v))}
            keyboardType="numeric"
            returnKeyType="done"
            onSubmitEditing={handleAdd}
          />
          <Pressable
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
              <Text variant="label" style={{ color: palette.warning }}>
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
        />

        {/* Footer */}
        <View style={[styles.footer, { borderTopColor: palette.border }]}>
          {entries.length > 0 && (
            <Text variant="caption" color="secondary" style={styles.total}>
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
      </KeyboardAvoidingView>
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe:    { flex: 1, backgroundColor: p.background },
    header:  {
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
    list:      { paddingBottom: spacing[4] },
    emptyList: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[8] },
    entryRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingHorizontal: spacing[5], paddingVertical: spacing[3],
      backgroundColor: p.surface,
    },
    footer: {
      paddingHorizontal: spacing[5], paddingBottom: spacing[4], paddingTop: spacing[3],
      borderTopWidth: 1, gap: spacing[2],
    },
    total: { textAlign: 'center' },
  });
}
