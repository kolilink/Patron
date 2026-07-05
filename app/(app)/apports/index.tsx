import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { formatAmount, formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { useAuthStore } from '@/stores/auth';
import { useEquipeStore, type Membre } from '@/stores/equipe';
import { useAportsStore, type Apport } from '@/stores/apports';
import { haptics } from '@/lib/haptics';
import { toast } from '@/stores/toast';

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function scaledFontSize(str: string): number {
  const len = str.length;
  if (len <= 12) return 36;
  if (len <= 15) return 30;
  if (len <= 18) return 24;
  return 20;
}

function displayName(a: Apport, currentUserId?: string, membres?: Membre[]): string {
  if (currentUserId && a.injected_by_id === currentUserId) return 'Mon investissement';
  const m = membres?.find(mb => mb.user_id === a.injected_by_id);
  if (m?.display_name) return m.display_name;
  return a.injected_by_name ?? a.source_name ?? 'Apport';
}

// ─── Form sheet ───────────────────────────────────────────────────────────────

type FormMode = 'add' | 'edit' | 'withdraw';

const FORM_TITLES: Record<FormMode, string> = {
  add: 'Nouvel apport',
  edit: 'Modifier l\'apport',
  withdraw: 'Retrait de capital',
};

const FORM_SAVE_LABELS: Record<FormMode, string> = {
  add: 'Enregistrer l\'apport',
  edit: 'Enregistrer les modifications',
  withdraw: 'Enregistrer le retrait',
};

interface FormSheetProps {
  visible: boolean;
  mode: FormMode;
  editing: Apport | null;
  businessId: string;
  currency: string;
  saving: boolean;
  onClose: () => void;
  onSave: (params: {
    amount: number;
    injectedById: string | null;
    sourceName: string | null;
    note: string | null;
    injectedAt: string;
  }) => void;
}

function FormSheet({ visible, mode, editing, businessId, currency, saving, onClose, onSave }: FormSheetProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const membres = useEquipeStore(s => s.membres);
  const multiMember = membres.length > 1;

  const [amountStr, setAmountStr] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(todayISO());
  const [showMemberPicker, setShowMemberPicker] = useState(false);

  const reset = () => {
    setAmountStr('');
    setSelectedMemberId(null);
    setSourceName('');
    setNote('');
    setDate(todayISO());
    setShowMemberPicker(false);
  };

  // Prefill when opening in edit mode
  useEffect(() => {
    if (visible && mode === 'edit' && editing) {
      setAmountStr(formatAmountInput(String(Math.abs(editing.amount))));
      setSelectedMemberId(editing.injected_by_id);
      setSourceName(editing.source_name ?? '');
      setNote(editing.note ?? '');
      setDate(editing.injected_at);
    }
  }, [visible, mode, editing]);

  const handleClose = () => { reset(); onClose(); };

  const selectedMember = membres.find(m => m.user_id === selectedMemberId) ?? null;
  const contributorLabel = selectedMember
    ? selectedMember.display_name ?? selectedMember.user_name
    : sourceName.trim() || null;

  const handleSave = () => {
    const amount = parseAmountInput(amountStr);
    if (!amount || amount <= 0) {
      toast.warning('Entrez un montant valide');
      return;
    }
    onSave({
      amount,
      injectedById: selectedMemberId,
      sourceName: sourceName.trim() || null,
      note: note.trim() || null,
      injectedAt: date,
    });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={handleClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        <View style={styles.modalHeader}>
          <Pressable onPress={handleClose}>
            <Text variant="body" color="secondary">Annuler</Text>
          </Pressable>
          <Text variant="h4">{FORM_TITLES[mode]}</Text>
          <View style={{ width: 60 }} />
        </View>

        <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
          {/* Amount */}
          <View style={{ gap: spacing[2] }}>
            <Text variant="label">{mode === 'withdraw' ? 'Montant retiré' : 'Montant apporté'}</Text>
            <View style={styles.amountRow}>
              <TextInput
                style={styles.amountInput}
                value={amountStr}
                onChangeText={v => setAmountStr(formatAmountInput(v))}
                keyboardType="numeric"
                placeholder="0"
                placeholderTextColor={palette.textDisabled}
                selectTextOnFocus
              />
              <Text variant="label" style={{ color: palette.textSecondary }}>{currency}</Text>
            </View>
          </View>

          {/* Contributor — only shown when there are multiple members */}
          {multiMember && (
            <View style={{ gap: spacing[2] }}>
              <Text variant="label">{mode === 'withdraw' ? 'Retiré à' : 'De la part de'}</Text>
              <Pressable
                style={[styles.pickerBtn, { borderColor: palette.border }]}
                onPress={() => setShowMemberPicker(true)}
              >
                <Ionicons name="person-outline" size={16} color={palette.textSecondary} />
                <Text variant="body" style={{ flex: 1, color: contributorLabel ? palette.textPrimary : palette.textDisabled }}>
                  {contributorLabel ?? (mode === 'withdraw' ? 'Optionnel — à qui a-t-on repris l\'argent ?' : 'Optionnel — qui a apporté ?')}
                </Text>
                <Ionicons name="chevron-down" size={16} color={palette.textSecondary} />
              </Pressable>
              {!selectedMemberId && (
                <TextInput
                  style={styles.textInput}
                  value={sourceName}
                  onChangeText={setSourceName}
                  placeholder="Ou saisissez un nom libre…"
                  placeholderTextColor={palette.textDisabled}
                />
              )}
            </View>
          )}

          {/* Note */}
          <View style={{ gap: spacing[2] }}>
            <Text variant="label">Note <Text variant="caption" color="secondary">(optionnel)</Text></Text>
            <TextInput
              style={styles.textInput}
              value={note}
              onChangeText={setNote}
              placeholder=""
              placeholderTextColor={palette.textDisabled}
            />
          </View>

          <DatePickerField label="Date" value={date} onChange={setDate} maxToday />
        </ScrollView>

        <View style={styles.modalFooter}>
          <Button
            label={saving ? 'Enregistrement…' : FORM_SAVE_LABELS[mode]}
            onPress={handleSave}
            loading={saving}
            fullWidth
            size="lg"
          />
        </View>
      </SafeAreaView>

      {/* Member picker overlay */}
      <Modal visible={showMemberPicker} transparent animationType="fade" onRequestClose={() => setShowMemberPicker(false)}>
        <Pressable style={styles.pickerBackdrop} onPress={() => setShowMemberPicker(false)}>
          <View style={[styles.pickerPanel, { backgroundColor: palette.surface }]}>
            <Text variant="label" style={{ marginBottom: spacing[3] }}>
              {mode === 'withdraw' ? 'À qui a-t-on repris cet argent ?' : 'Qui a apporté cet argent ?'}
            </Text>
            <Pressable
              style={[styles.pickerOption, { borderBottomWidth: 1, borderBottomColor: palette.border }]}
              onPress={() => { setSelectedMemberId(null); setShowMemberPicker(false); }}
            >
              <Text variant="body" color="secondary">Personne en particulier</Text>
            </Pressable>
            {membres.map(m => (
              <Pressable
                key={m.user_id}
                style={[styles.pickerOption, selectedMemberId === m.user_id && { backgroundColor: palette.primary + '15' }]}
                onPress={() => { setSelectedMemberId(m.user_id); setSourceName(''); setShowMemberPicker(false); }}
              >
                <Text variant="body">{m.display_name ?? m.user_name}</Text>
                <Text variant="caption" color="secondary" style={{ textTransform: 'capitalize' }}>{m.role}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </Modal>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function AportsScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const userId = session?.user?.id;
  const canWrite = role === 'administrateur' || role === 'manager';

  const { apports, loading, saving, offline, offlineSince, fetchApports, addApport, editApport, recordWithdrawal } = useAportsStore();
  const fetchMembres = useEquipeStore(s => s.fetchMembres);
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>('add');
  const [editingApport, setEditingApport] = useState<Apport | null>(null);
  const [showAddChooser, setShowAddChooser] = useState(false);

  // Filter by contributor
  const [filterMemberId, setFilterMemberId] = useState<string | null>(null);
  const membres = useEquipeStore(s => s.membres);
  const multiMember = membres.length > 1;

  useFocusEffect(
    useCallback(() => {
      if (businessId) {
        fetchApports(businessId);
        fetchMembres(businessId);
      }
    }, [businessId]),
  );

  const filtered = useMemo(() => {
    if (!filterMemberId) return apports;
    return apports.filter(a => a.injected_by_id === filterMemberId);
  }, [apports, filterMemberId]);

  const total = useMemo(() => apports.reduce((s, a) => s + a.amount, 0), [apports]);
  const filteredTotal = useMemo(() => filtered.reduce((s, a) => s + a.amount, 0), [filtered]);
  const displayTotal = formatAmount(filterMemberId ? filteredTotal : total, currency);
  const totalFontSize = scaledFontSize(displayTotal);

  const handleSave = async (params: {
    amount: number;
    injectedById: string | null;
    sourceName: string | null;
    note: string | null;
    injectedAt: string;
  }) => {
    let ok = false;
    let message = '';

    if (formMode === 'add') {
      ok = await addApport({ businessId, ...params });
      message = 'Apport enregistré';
    } else if (formMode === 'edit' && editingApport) {
      ok = await editApport({ id: editingApport.id, businessId, ...params });
      message = 'Apport modifié';
    } else if (formMode === 'withdraw') {
      ok = await recordWithdrawal({
        businessId,
        amount: params.amount,
        injectedById: params.injectedById,
        sourceName: params.sourceName,
        note: params.note,
        withdrawnAt: params.injectedAt,
      });
      message = 'Retrait enregistré';
    }

    if (ok) {
      haptics.success();
      setShowForm(false);
      setEditingApport(null);
      toast.success(message);
    }
  };

  const openAdd = () => { setFormMode('add'); setEditingApport(null); setShowForm(true); setShowAddChooser(false); };
  const openWithdraw = () => { setFormMode('withdraw'); setEditingApport(null); setShowForm(true); setShowAddChooser(false); };
  const openEdit = (apport: Apport) => {
    if (!canWrite || apport.amount < 0) return;
    setFormMode('edit');
    setEditingApport(apport);
    setShowForm(true);
  };

  // Unique contributors for filter chips
  const contributors = useMemo(() => {
    const seen = new Set<string>();
    return apports.filter(a => {
      const key = a.injected_by_id ?? a.source_name ?? '';
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [apports]);

  return (
    <Screen>
      {/* Header — back + optional add */}
      <View style={styles.headerTop}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        {canWrite && (
          <Pressable onPress={() => setShowAddChooser(true)} hitSlop={8} style={styles.addBtn}>
            <Ionicons name="add" size={24} color={palette.primary} />
          </Pressable>
        )}
      </View>

      {offline && <OfflineNotice offlineSince={offlineSince} />}

      {/* Title + total */}
      <View style={styles.headerMeta}>
        <Text variant="caption" color="secondary" style={{ letterSpacing: 0.4 }}>Capital investi</Text>
        {!loading && apports.length > 0 ? (
          <>
            <Text
              style={[styles.totalText, { color: palette.success, fontSize: totalFontSize, lineHeight: totalFontSize + 8 }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
            >
              {displayTotal}
            </Text>
            {filterMemberId && (
              <Text variant="caption" color="secondary">
                sur {formatAmount(total, currency)} au total
              </Text>
            )}
          </>
        ) : !loading ? (
          <Text style={[styles.totalText, { color: palette.textDisabled }]}>—</Text>
        ) : null}
      </View>

      {loading && apports.length === 0 ? (
        <SkeletonList count={4} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={a => a.id}
          contentContainerStyle={filtered.length === 0 ? styles.listEmpty : styles.list}
          ListHeaderComponent={(
            <>
              {multiMember && contributors.length > 1 && (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.tabs}
                >
                  <Pressable onPress={() => setFilterMemberId(null)} style={styles.tab}>
                    <Text variant="label" style={{ color: !filterMemberId ? palette.primary : palette.textSecondary }}>
                      Tous
                    </Text>
                    {!filterMemberId && <View style={[styles.tabBar, { backgroundColor: palette.primary }]} />}
                  </Pressable>
                  {contributors.map(a => {
                    const key = a.injected_by_id ?? a.source_name ?? a.id;
                    const label = displayName(a, userId, membres);
                    const active = filterMemberId === a.injected_by_id;
                    return (
                      <Pressable
                        key={key}
                        onPress={() => setFilterMemberId(active ? null : (a.injected_by_id ?? null))}
                        style={styles.tab}
                      >
                        <Text variant="label" style={{ color: active ? palette.primary : palette.textSecondary }}>
                          {label}
                        </Text>
                        {active && <View style={[styles.tabBar, { backgroundColor: palette.primary }]} />}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              )}
              <View style={{ height: 1, backgroundColor: palette.border }} />
            </>
          )}
          ListEmptyComponent={(
            <View style={styles.empty}>
              <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
                {apports.length === 0
                  ? 'Aucun apport enregistré.\nAjoutez le capital de départ ou les mises de fonds.'
                  : 'Aucun apport pour ce contributeur.'}
              </Text>
            </View>
          )}
          renderItem={({ item }) => {
            const name = displayName(item, userId, membres);
            const isWithdrawal = item.amount < 0;
            const numericPart = formatAmount(Math.abs(item.amount), currency).replace(` ${currency}`, '').trim();
            const metaParts = [fmtDate(item.injected_at), item.note];
            if (isWithdrawal && item.created_by_name) metaParts.push(`retiré par ${item.created_by_name}`);
            if (item.edited_at) metaParts.push(`modifié par ${item.edited_by_name ?? '?'}`);
            const meta = metaParts.filter(Boolean).join(' · ');
            const editable = canWrite && !isWithdrawal;
            return (
              <Pressable
                style={styles.row}
                onPress={editable ? () => openEdit(item) : undefined}
                disabled={!editable}
              >
                <View style={styles.rowLeft}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {name !== 'Apport' ? name : '—'}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>{meta}</Text>
                </View>
                <Text style={styles.rowAmount} numberOfLines={1}>
                  <Text style={isWithdrawal ? { color: palette.warning, fontWeight: '700' } : styles.rowPlus}>
                    {isWithdrawal ? '− ' : '+ '}
                  </Text>
                  {numericPart}
                  <Text style={styles.rowCurrency}> {currency}</Text>
                </Text>
              </Pressable>
            );
          }}
        />
      )}

      <FormSheet
        visible={showForm}
        mode={formMode}
        editing={editingApport}
        businessId={businessId}
        currency={currency}
        saving={saving}
        onClose={() => { setShowForm(false); setEditingApport(null); }}
        onSave={handleSave}
      />

      {/* Add / withdraw chooser */}
      <Modal visible={showAddChooser} transparent animationType="fade" onRequestClose={() => setShowAddChooser(false)}>
        <Pressable style={styles.pickerBackdrop} onPress={() => setShowAddChooser(false)}>
          <View style={[styles.pickerPanel, { backgroundColor: palette.surface }]}>
            <Pressable
              style={[styles.pickerOption, { borderBottomWidth: 1, borderBottomColor: palette.border, flexDirection: 'row', alignItems: 'center', gap: spacing[3] }]}
              onPress={openAdd}
            >
              <Ionicons name="add-circle-outline" size={20} color={palette.success} />
              <View>
                <Text variant="body">Nouvel apport</Text>
                <Text variant="caption" color="secondary">Enregistrer de l'argent reçu</Text>
              </View>
            </Pressable>
            <Pressable
              style={[styles.pickerOption, { flexDirection: 'row', alignItems: 'center', gap: spacing[3] }]}
              onPress={openWithdraw}
            >
              <Ionicons name="remove-circle-outline" size={20} color={palette.warning} />
              <View>
                <Text variant="body">Retrait de capital</Text>
                <Text variant="caption" color="secondary">Un apport déjà reçu a été repris</Text>
              </View>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </Screen>
  );
}


// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },

    // Header
    headerTop: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingTop: spacing[3], paddingBottom: spacing[1],
    },
    addBtn: { padding: spacing[1] },
    headerMeta: {
      paddingHorizontal: spacing[5], paddingTop: spacing[1], paddingBottom: 0,
      gap: spacing[1],
    },
    totalText: {
      fontSize: 36, fontWeight: '700', letterSpacing: -0.5, lineHeight: 44,
    },

    // Filter tabs
    tabs: {
      paddingHorizontal: spacing[5], gap: spacing[5],
      paddingTop: spacing[1], paddingBottom: spacing[2],
    },
    tab: { alignItems: 'center', gap: spacing[1], paddingBottom: spacing[1] },
    tabBar: { height: 2, borderRadius: 1, width: '100%' },

    // List
    list: { paddingBottom: spacing[20] },
    listEmpty: { flexGrow: 1, paddingBottom: spacing[20] },
    row: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingVertical: spacing[5],
    },
    rowLeft: { flex: 1, gap: 5, marginRight: spacing[4] },
    rowName: { fontSize: 15, fontWeight: '600', color: p.textPrimary, letterSpacing: -0.2 },
    rowMeta: { fontSize: 11, fontWeight: '400', color: p.textDisabled, letterSpacing: 0.8, textTransform: 'uppercase' },
    rowAmount: { fontSize: 17, fontWeight: '700', color: p.textPrimary, letterSpacing: -0.4 },
    rowPlus: { color: p.success, fontWeight: '700' },
    rowCurrency: { fontSize: 12, fontWeight: '400', color: p.textSecondary },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing[8], paddingVertical: spacing[10] },

    // Form modal
    modalSafe: { flex: 1, backgroundColor: p.background },
    modalHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border,
    },
    formContent: { padding: spacing[5], gap: spacing[4] },
    modalFooter: {
      padding: spacing[5], borderTopWidth: 1, borderTopColor: p.border,
      backgroundColor: p.surface,
    },
    amountRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
    amountInput: {
      flex: 1, paddingHorizontal: spacing[4], paddingVertical: spacing[3],
      borderRadius: radius.md, borderWidth: 1, borderColor: p.border,
      backgroundColor: p.surface, color: p.textPrimary,
      fontSize: 28, fontWeight: '700',
    },
    textInput: {
      paddingHorizontal: spacing[4], paddingVertical: spacing[3],
      borderRadius: radius.md, borderWidth: 1, borderColor: p.border,
      backgroundColor: p.surface, color: p.textPrimary, fontSize: 16,
    },
    pickerBtn: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingHorizontal: spacing[4], paddingVertical: spacing[3],
      borderRadius: radius.md, borderWidth: 1,
      backgroundColor: p.surface,
    },
    pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
    pickerPanel: {
      borderTopLeftRadius: 20, borderTopRightRadius: 20,
      padding: spacing[5], paddingBottom: spacing[10],
    },
    pickerOption: { paddingVertical: spacing[3], gap: 2 },
  });
}
