import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  InteractionManager,
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
import { ALL_COUNTRIES, PINNED_CODES, detectCountryCode, detectCountryCodeAsync, type Country } from '@/src/lib/countries';

interface PhoneInputProps {
  onChange: (e164: string, isComplete: boolean) => void;
  label?: string;
  autoFocus?: boolean;
  resetKey?: number;
  strict?: boolean;
  initialValue?: string; // E.164 number to pre-fill (e.g. "+224620000000")
  // Enables OS-level "this is your own number" autofill (Contacts/SIM suggestion).
  // Only appropriate when the field captures the current user's own number
  // (login, signup) — not when entering someone else's (client, supplier).
  autofillOwnNumber?: boolean;
}

function parseE164(e164: string): { country: Country; local: string } | null {
  if (!e164?.startsWith('+')) return null;
  const sorted = [...ALL_COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);
  for (const c of sorted) {
    if (e164.startsWith(c.dial)) {
      return { country: c, local: e164.slice(c.dial.length) };
    }
  }
  return null;
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

export function PhoneInput({ onChange, label, autoFocus, resetKey, strict = true, initialValue, autofillOwnNumber }: PhoneInputProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const defaultCode    = detectCountryCode();
  const defaultCountry = ALL_COUNTRIES.find(c => c.code === defaultCode) ?? PINNED[0];

  const parsed = initialValue ? parseE164(initialValue) : null;
  const [country, setCountry]         = useState<Country>(parsed?.country ?? defaultCountry);
  const [localNumber, setLocalNumber] = useState(parsed?.local ?? '');
  const [pickerOpen, setPickerOpen]   = useState(false);
  const [search, setSearch]           = useState('');

  const inputRef      = useRef<TextInput>(null);
  const blink         = useRef(new Animated.Value(1)).current;
  const userTouched   = useRef(false);

  // IP-based country detection — only fires when no initialValue and user hasn't picked manually
  useEffect(() => {
    if (initialValue) return;
    detectCountryCodeAsync().then(code => {
      if (userTouched.current) return;
      const c = ALL_COUNTRIES.find(x => x.code === code);
      if (c) setCountry(c);
    });
  }, []);

  useEffect(() => { if ((resetKey ?? 0) > 0) setLocalNumber(''); }, [resetKey]);

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
    if (!autoFocus) return;
    // A flat setTimeout here used to fire mid-screen-transition (React
    // Navigation's slide animation runs ~350ms on iOS) — iOS then queues the
    // keyboard's own raise animation until that transition's animation block
    // finishes, so the keyboard visibly lagged behind the screen settling
    // instead of feeling like one motion. InteractionManager ties the focus
    // call to the actual end of the transition instead of a guessed delay.
    const task = InteractionManager.runAfterInteractions(() => inputRef.current?.focus());
    return () => task.cancel();
  }, [autoFocus]);

  const handleChangeText = (t: string) => {
    const raw = t.replace(/\D/g, '');

    // Autofill/paste of a full international number can carry a different
    // country than the one currently selected on screen (e.g. the screen
    // defaulted to Guinea but the device's own number is French) — resolve
    // the country straight from the pasted digits instead of assuming it
    // matches whatever is already selected.
    if (raw.length > country.digits + 1) {
      const parsed = parseE164(`+${raw}`);
      if (parsed) {
        userTouched.current = true;
        setCountry(parsed.country);
        setLocalNumber(parsed.local.slice(0, parsed.country.digits));
        return;
      }
    }

    // Strip leading trunk-prefix 0 only when pasting a full number that's too long —
    // not while typing digit by digit, since many countries (Gabon, Nigeria, Senegal…)
    // have mobile numbers that genuinely start with 0.
    let digits = (raw.startsWith('0') && raw.length > country.digits) ? raw.slice(1) : raw;
    const prefix = country.dial.replace('+', '');
    if (digits.startsWith(prefix) && digits.length > country.digits) {
      digits = digits.slice(prefix.length);
    }
    setLocalNumber(digits.slice(0, country.digits));
  };

  const handleSelectCountry = (c: Country) => {
    userTouched.current = true;
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
        <View style={styles.digitRow}>
          {renderSlots()}
          <TextInput
            ref={inputRef}
            value={localNumber}
            onChangeText={handleChangeText}
            keyboardType="number-pad"
            maxLength={country.digits + 1}
            style={styles.hiddenInput}
            caretHidden
            selectionColor="transparent"
            textContentType={autofillOwnNumber ? 'telephoneNumber' : undefined}
            autoComplete={autofillOwnNumber ? 'tel' : undefined}
          />
        </View>
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
    hiddenInput: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, color: 'transparent', backgroundColor: 'transparent' },
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
