import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from './Text';
import { Input } from './Input';
import { useTheme } from '@/src/theme';
import { spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { ALL_COUNTRIES, PINNED_CODES, detectCountryCode, type Country } from '@/src/lib/countries';

interface PhoneInputProps {
  onChange: (e164: string, isComplete: boolean) => void;
  label?: string;
  autoFocus?: boolean;
  resetKey?: number;
  strict?: boolean;
}

const PINNED = PINNED_CODES.map(c => ALL_COUNTRIES.find(x => x.code === c)!).filter(Boolean);
const REST   = ALL_COUNTRIES.filter(c => !PINNED_CODES.includes(c.code))
                            .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

type ListItem = Country | { divider: true };

function buildList(search: string): ListItem[] {
  if (search) {
    const q = search.toLowerCase();
    return ALL_COUNTRIES.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.dial.includes(q) ||
      c.code.toLowerCase().includes(q),
    ).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }
  return [...PINNED, { divider: true }, ...REST];
}

export function PhoneInput({ onChange, label, autoFocus, resetKey, strict = true }: PhoneInputProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const defaultCode    = detectCountryCode();
  const defaultCountry = ALL_COUNTRIES.find(c => c.code === defaultCode) ?? PINNED[0];

  const [country, setCountry]         = useState<Country>(defaultCountry);
  const [localNumber, setLocalNumber] = useState('');
  const [pickerOpen, setPickerOpen]   = useState(false);
  const [search, setSearch]           = useState('');

  const inputRef = useRef<TextInput>(null);
  const blink    = useRef(new Animated.Value(1)).current;

  useEffect(() => { setLocalNumber(''); }, [resetKey]);

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0, duration: 530, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 530, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, []);

  useEffect(() => {
    const e164 = `${country.dial}${localNumber}`;
    const isComplete = localNumber.length === country.digits;
    onChange(e164, isComplete);
  }, [localNumber, country]);

  useEffect(() => {
    if (autoFocus) {
      const t = setTimeout(() => inputRef.current?.focus(), 200);
      return () => clearTimeout(t);
    }
  }, [autoFocus]);

  const handleChangeText = (t: string) => {
    const raw = t.replace(/\D/g, '');
    let digits = raw.startsWith('0') ? raw.slice(1) : raw;
    const prefix = country.dial.replace('+', '');
    if (digits.startsWith(prefix) && digits.length > country.digits) {
      digits = digits.slice(prefix.length);
    }
    setLocalNumber(digits.slice(0, country.digits));
  };

  const handleSelectCountry = (c: Country) => {
    setCountry(c);
    setLocalNumber('');
    setPickerOpen(false);
    setSearch('');
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const listData = useMemo(() => buildList(search), [search]);

  const renderSlots = () => {
    const slots: React.ReactElement[] = [];
    for (let i = 0; i < country.digits; i++) {
      const char   = localNumber[i];
      const isNext = i === localNumber.length && localNumber.length < country.digits;
      if (i > 0 && i % 3 === 0) slots.push(<Text key={`sep-${i}`} style={styles.sep}> </Text>);
      if (char) {
        slots.push(<Text key={i} style={styles.filledDigit}>{char}</Text>);
      } else if (isNext) {
        slots.push(<Animated.Text key={i} style={[styles.emptyDigit, { opacity: blink }]}>_</Animated.Text>);
      } else {
        slots.push(<Text key={i} style={[styles.emptyDigit, { opacity: 0.25 }]}>_</Text>);
      }
    }
    return slots;
  };

  const renderPickerItem = ({ item }: { item: ListItem }) => {
    if ('divider' in item) return <View style={styles.divider} />;
    return (
      <Pressable
        onPress={() => handleSelectCountry(item)}
        style={({ pressed }) => [styles.countryRow, pressed && { opacity: 0.6 }]}
      >
        <Text style={styles.countryFlag}>{item.flag}</Text>
        <Text variant="body" style={{ flex: 1 }}>{item.name}</Text>
        <Text variant="caption" color="secondary">{item.dial}</Text>
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      {label ? <Text variant="label" color="secondary" style={styles.label}>{label}</Text> : null}
      <Pressable style={styles.inputRow} onPress={() => inputRef.current?.focus()}>
        <Pressable onPress={() => setPickerOpen(true)} style={styles.countryBtn}>
          <Text style={styles.flagLarge}>{country.flag}</Text>
          <Text variant="label" style={styles.dialCode}>{country.dial}</Text>
          <Text style={styles.chevron}>▾</Text>
        </Pressable>
        <View style={styles.vertDivider} />
        <View style={styles.digitRow}>{renderSlots()}</View>
        <TextInput
          ref={inputRef}
          value={localNumber}
          onChangeText={handleChangeText}
          keyboardType="phone-pad"
          maxLength={country.digits + 1}
          style={styles.hiddenInput}
          caretHidden
        />
      </Pressable>
      <Modal visible={pickerOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPickerOpen(false)}>
        <SafeAreaView style={styles.modal} edges={['top']}>
          <View style={styles.modalHeader}>
            <Text variant="h4">Choisir un pays</Text>
            <Pressable onPress={() => { setPickerOpen(false); setSearch(''); }}>
              <Text variant="body" color="secondary">Fermer</Text>
            </Pressable>
          </View>
          <View style={styles.searchWrap}>
            <Input
              placeholder="Pays ou indicatif"
              value={search}
              onChangeText={setSearch}
              autoFocus={Platform.OS === 'ios'}
            />
          </View>
          <FlatList
            data={listData}
            keyExtractor={(item, i) => ('divider' in item ? `div-${i}` : item.code)}
            renderItem={renderPickerItem}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: spacing[10] }}
          />
        </SafeAreaView>
      </Modal>
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    container: { gap: spacing[1.5] },
    label:     { marginBottom: 2 },
    inputRow: {
      flexDirection: 'row', alignItems: 'center',
      borderWidth: 1, borderColor: p.border,
      borderRadius: radius.md, backgroundColor: p.surface,
      minHeight: 56, overflow: 'hidden',
    },
    countryBtn: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[3], paddingVertical: spacing[3],
      gap: spacing[1],
    },
    flagLarge:   { fontSize: 22 },
    dialCode:    { color: p.textPrimary },
    chevron:     { fontSize: 10, color: p.textSecondary, marginTop: 2 },
    vertDivider: { width: 1, height: 28, backgroundColor: p.border },
    digitRow: {
      flex: 1, flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[3], flexWrap: 'nowrap', overflow: 'hidden',
    },
    filledDigit: { fontSize: 18, fontWeight: '500', color: p.textPrimary },
    emptyDigit:  { fontSize: 18, fontWeight: '400', color: p.textSecondary },
    sep:         { fontSize: 18, color: p.textSecondary, width: 7, textAlign: 'center' },
    hiddenInput: { position: 'absolute', opacity: 0, width: 1, height: 1, left: -999 },
    modal:       { flex: 1, backgroundColor: p.background },
    modalHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border,
    },
    searchWrap:  { paddingHorizontal: spacing[5], paddingVertical: spacing[3] },
    countryRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[5], paddingVertical: spacing[3],
      gap: spacing[3],
    },
    countryFlag: { fontSize: 24 },
    divider: {
      height: 1, backgroundColor: p.border,
      marginVertical: spacing[2], marginHorizontal: spacing[5],
    },
  });
}
