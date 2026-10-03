import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, InputAccessoryView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Screen } from '@/src/components/ui/Screen';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { ProofPhotoField, type PickedImage } from '@/src/components/ui/ProofPhotoField';
import { ProofThumbnail } from '@/src/components/ui/ProofThumbnail';
import { attachTransactionProof } from '@/lib/proofs';
import { useTheme, spacing, radius, fontFamily } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { formatAmount, formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { useAuthStore } from '@/stores/auth';
import { useEquipeStore, type Membre } from '@/stores/equipe';
import { useAportsStore, type Apport } from '@/stores/apports';
import { haptics } from '@/lib/haptics';
import { toast } from '@/stores/toast';

// iOS-only: suppresses the OS's auto-injected floating "Done" pill above
// the numeric keyboard — this form already has a persistent, always-
// visible footer button.
const APPORT_FORM_SILENT_ACCESSORY_ID = 'apports-form-silent-accessory';

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
  if (currentUserId && a.injected_by_id === currentUserId) return 'Moi';
  const m = membres?.find(mb => mb.user_id === a.injected_by_id);
  if (m?.display_name) return m.display_name;
  return a.injected_by_name ?? a.source_name ?? 'Apport';
}

// ─── Form sheet ───────────────────────────────────────────────────────────────

// 'view' = an existing entry (typically a withdrawal, which can't be edited)
// opened only to see it and attach a photo — money fields are read-only.
type FormMode = 'add' | 'edit' | 'withdraw' | 'view';

const FORM_TITLES: Record<FormMode, string> = {
  add: 'Nouvel apport',
  edit: 'Modifier l\'apport',
  withdraw: 'Retrait de capital',
  view: 'Détails',
};

const FORM_SAVE_LABELS: Record<FormMode, string> = {
  add: 'Enregistrer',
  edit: 'Enregistrer',
  withdraw: 'Enregistrer',
  view: 'Enregistrer',
};

interface ApportFormModalProps {
  visible: boolean;
  mode: FormMode;
  editing: Apport | null;
  businessId: string;
  currency: string;
  saving: boolean;
  offline: boolean;
  onClose: () => void;
  onSave: (params: {
    amount: number;
    injectedById: string | null;
    sourceName: string | null;
    note: string | null;
    injectedAt: string;
    photo: PickedImage | null;
  }) => void;
}

function ApportFormModal({ visible, mode, editing, businessId, currency, saving, offline, onClose, onSave }: ApportFormModalProps) {
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
  const [photo, setPhoto] = useState<PickedImage | null>(null);

  const isViewMode = mode === 'view';
  const existingProof = (mode === 'edit' || mode === 'view') ? editing?.proof_image_url ?? null : null;

  const reset = () => {
    setAmountStr('');
    setSelectedMemberId(null);
    setSourceName('');
    setNote('');
    setDate(todayISO());
    setShowMemberPicker(false);
    setPhoto(null);
  };

  // Prefill when opening on an existing entry (edit or view)
  useEffect(() => {
    if (visible && (mode === 'edit' || mode === 'view') && editing) {
      setAmountStr(formatAmountInput(String(Math.round(Math.abs(editing.amount))), currency));
      setSelectedMemberId(editing.injected_by_id);
      setSourceName(editing.source_name ?? '');
      setNote(editing.note ?? '');
      setDate(editing.injected_at);
      setPhoto(null);
    }
  }, [visible, mode, editing]);

  const handleClose = () => { reset(); onClose(); };

  const selectedMember = membres.find(m => m.user_id === selectedMemberId) ?? null;
  const contributorLabel = selectedMember
    ? selectedMember.display_name ?? selectedMember.user_name
    : sourceName.trim() || null;

  const handleSave = () => {
    const amount = parseAmountInput(amountStr, currency);
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
      photo,
    });
  };

  // Détails (view mode) has no footer button at all — picking a photo here
  // attaches immediately instead of waiting on a separate "Enregistrer" tap,
  // which is exactly the confusion a save button on a read-only screen caused.
  const handleViewPickPhoto = async () => {
    if (offline) { toast.warning('Indisponible hors ligne'); return; }
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { toast.warning('Autorisez l\'accès aux photos'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (result.canceled || !result.assets?.[0]) return;
    const a = result.assets[0];
    const picked: PickedImage = { uri: a.uri, width: a.width, height: a.height };
    setPhoto(picked);
    onSave({
      amount: Math.abs(editing?.amount ?? 0),
      injectedById: selectedMemberId,
      sourceName: sourceName.trim() || null,
      note: note.trim() || null,
      injectedAt: date,
      photo: picked,
    });
  };

  return (
    <>
      <FormSheet
        visible={visible}
        onClose={handleClose}
        title={FORM_TITLES[mode]}
        cancelLabel={isViewMode ? 'Fermer' : 'Annuler'}
        presentationStyle="formSheet"
        contentContainerStyle={styles.formContent}
        /* Détails (view mode) is read-only — there is no "Modifier" here
           either, since a withdrawal (the only kind of entry ever opened in
           this mode) has no edit RPC/flow anywhere in this app. No footer at
           all, per the design brief, rather than a button with nowhere real
           to go. */
        footer={!isViewMode ? (
          <View style={styles.modalFooter}>
            <Button
              label={saving ? 'Enregistrement…' : FORM_SAVE_LABELS[mode]}
              onPress={handleSave}
              loading={saving}
              fullWidth
              size="lg"
            />
          </View>
        ) : undefined}
        accessory={
          Platform.OS === 'ios' ? (
            <InputAccessoryView nativeID={APPORT_FORM_SILENT_ACCESSORY_ID}>
              <View style={{ height: 0 }} />
            </InputAccessoryView>
          ) : undefined
        }
      >
        {isViewMode ? (
          /* An existing entry (usually a withdrawal, which can't be edited)
             opened only to see it and attach a photo. Money is read-only.
             Clean, spacious composition — the amount is the hero, everything
             else is a quiet label/value pair. Order: amount, person, note,
             date, photo last. */
          <View style={styles.viewWrap}>
            <View style={styles.viewHero}>
              <Text style={styles.viewMicroLabel}>{(editing?.amount ?? 0) < 0 ? 'Montant retiré' : 'Montant apporté'}</Text>
              {/* Same direction encoding as the list row — signed and
                    colored, never a neutral unsigned amount. */}
              <Text style={[styles.viewAmount, { color: (editing?.amount ?? 0) < 0 ? palette.apportsAmber : palette.apportsGreen }]}>
                {(editing?.amount ?? 0) < 0 ? '− ' : '+ '}{formatAmount(Math.abs(editing?.amount ?? 0), currency)}
              </Text>
            </View>

            <View style={styles.viewDetails}>
              {contributorLabel ? (
                <View style={styles.viewDetailRow}>
                  <Text style={styles.viewMicroLabel}>{(editing?.amount ?? 0) < 0 ? 'Versé à' : 'Reçu de'}</Text>
                  <Text style={styles.viewValue}>{contributorLabel}</Text>
                </View>
              ) : null}
              {note.trim() ? (
                <View style={styles.viewDetailRow}>
                  <Text style={styles.viewMicroLabel}>Note</Text>
                  <Text style={styles.viewValue}>{note}</Text>
                </View>
              ) : null}
              <View style={styles.viewDetailRow}>
                <Text style={styles.viewMicroLabel}>Date</Text>
                <Text style={styles.viewValue}>{fmtDate(date)}</Text>
              </View>
            </View>

            {/* Photo — one compact row unless a photo exists, never the
                  large add/edit dropzone; picking one here attaches
                  immediately (see handleViewPickPhoto), no save step. */}
            {existingProof ? (
              <View style={styles.viewPhotoRow}>
                <ProofThumbnail url={existingProof} />
                <Text variant="body" style={{ color: palette.apportsSecondary }}>Photo</Text>
              </View>
            ) : photo ? (
              <View style={styles.viewPhotoRow}>
                <ProofThumbnail url={photo.uri} />
                <Text variant="body" style={{ color: palette.apportsSecondary }}>Photo ajoutée</Text>
              </View>
            ) : (
              <Pressable onPress={handleViewPickPhoto} style={styles.viewPhotoAddRow}>
                <Ionicons name="camera-outline" size={18} color={palette.apportsSecondary} />
                <Text variant="body" style={{ color: palette.apportsSecondary }}>Ajouter une photo (optionnel)</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <>
            {/* Amount */}
            <View style={{ gap: spacing[2] }}>
              <Text variant="label">{mode === 'withdraw' ? 'Montant retiré' : 'Montant apporté'}</Text>
              <View style={styles.amountRow}>
                <TextInput
                  style={styles.amountInput}
                  value={amountStr}
                  onChangeText={v => setAmountStr(formatAmountInput(v, currency))}
                  keyboardType="numeric"
                  placeholder="0"
                  placeholderTextColor={palette.textDisabled}
                  selectTextOnFocus
                  inputAccessoryViewID={Platform.OS === 'ios' ? APPORT_FORM_SILENT_ACCESSORY_ID : undefined}
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
          </>
        )}

        {/* Photo well — the receipt as a natural field of the form. Not
              rendered in view mode, which has its own compact photo row
              above (inside the isViewMode branch). */}
        {!isViewMode && (
          <ProofPhotoField
            existingUrl={existingProof}
            existingWidth={editing?.proof_image_width}
            existingHeight={editing?.proof_image_height}
            value={photo}
            onChange={setPhoto}
            disabled={offline}
          />
        )}
      </FormSheet>

      {/* Member picker overlay — no keyboard field of its own, but shares
          this component with one (the amount/source TextInputs above), so
          it still gets statusBarTranslucent/navigationBarTranslucent for
          consistency (see scripts/lib/consistency-checks.js). */}
      <Modal
        visible={showMemberPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMemberPicker(false)}
        statusBarTranslucent
        navigationBarTranslucent
      >
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
    </>
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
    photo: PickedImage | null;
  }) => {
    const { photo, ...rest } = params;
    let ok = false;
    let targetId: string | null = null;
    let message = '';

    if (formMode === 'add') {
      targetId = await addApport({ businessId, ...rest });
      ok = !!targetId;
      message = 'Apport enregistré';
    } else if (formMode === 'edit' && editingApport) {
      ok = await editApport({ id: editingApport.id, businessId, ...rest });
      targetId = editingApport.id;
      message = 'Apport modifié';
    } else if (formMode === 'withdraw') {
      targetId = await recordWithdrawal({
        businessId,
        amount: rest.amount,
        injectedById: rest.injectedById,
        sourceName: rest.sourceName,
        note: rest.note,
        withdrawnAt: rest.injectedAt,
      });
      ok = !!targetId;
      message = 'Retrait enregistré';
    } else if (formMode === 'view' && editingApport) {
      ok = true;
      targetId = editingApport.id;
      message = 'Image ajoutée';
    }

    if (!ok) return;

    // Attach a picked photo to the row (new or existing), only if it has none yet.
    if (photo && targetId && !editingApport?.proof_image_url) {
      try {
        await attachTransactionProof({
          kind: 'apport', id: targetId, businessId,
          fileUri: photo.uri, sourceWidth: photo.width, sourceHeight: photo.height,
        });
        await fetchApports(businessId);
      } catch {
        toast.warning('Enregistré, mais l\'image n\'a pas pu être jointe');
      }
    }

    haptics.success();
    setShowForm(false);
    setEditingApport(null);
    toast.success(message);
  };

  const openAdd = () => { setFormMode('add'); setEditingApport(null); setShowForm(true); setShowAddChooser(false); };
  const openWithdraw = () => { setFormMode('withdraw'); setEditingApport(null); setShowForm(true); setShowAddChooser(false); };
  const openEdit = (apport: Apport) => {
    setFormMode('edit');
    setEditingApport(apport);
    setShowForm(true);
  };
  const openView = (apport: Apport) => {
    setFormMode('view');
    setEditingApport(apport);
    setShowForm(true);
  };
  // Tapping a row opens its record: injections are editable; withdrawals
  // (which can't be edited) open read-only, only to attach/view a photo.
  const openRow = (apport: Apport) => {
    if (!canWrite) return;
    if (apport.amount < 0) openView(apport);
    else openEdit(apport);
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

  const filterContributor = contributors.find(c => c.injected_by_id === filterMemberId);
  const filterMemberName = filterMemberId && filterContributor ? displayName(filterContributor, userId, membres) : null;

  return (
    <Screen>
      {/* Header — back + optional add */}
      <View style={styles.headerTop}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        {canWrite && (
          <Pressable onPress={() => setShowAddChooser(true)} hitSlop={8} style={styles.addBtn}>
            <Ionicons name="add" size={20} color={palette.apportsPurple} />
            <Text variant="label" style={{ color: palette.apportsPurple }}>Ajouter</Text>
          </Pressable>
        )}
      </View>

      {offline && (
        <OfflineNotice offlineSince={offlineSince} onRetry={() => fetchApports(businessId)} />
      )}

      {/* Title + total — omitted entirely on the true-empty state (no apports
          at all): a "—" placeholder for a total that doesn't exist yet is
          just noise above the empty illustration below. The label itself
          answers "whose money" together with the number — "Capital de
          [nom]" once a person tab is active, not just the number alone. */}
      {(loading || apports.length > 0) && (
        <View style={styles.headerMeta}>
          <Text variant="caption" style={{ color: palette.apportsSecondary, letterSpacing: 0.4 }}>
            {filterMemberName ? `Capital de ${filterMemberName}` : 'Capital investi'}
          </Text>
          {!loading && apports.length > 0 && (
            <>
              <Text
                style={[styles.totalText, { color: palette.apportsGreen, fontSize: totalFontSize, lineHeight: totalFontSize + 8 }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.6}
              >
                {displayTotal}
              </Text>
              {filterMemberId && (
                <Text variant="caption" style={{ color: palette.apportsSecondary }}>
                  sur {formatAmount(total, currency)} au total
                </Text>
              )}
            </>
          )}
        </View>
      )}

      {loading && apports.length === 0 ? (
        <SkeletonList count={4} />
      ) : !loading && apports.length === 0 && offline ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
            Données non disponibles hors ligne. Ouvrez l'application en ligne une première fois pour activer le mode hors ligne.
          </Text>
        </View>
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
                  {/* Text stays ink/secondary regardless of selection — purple
                      is reserved for the underline itself (and the + button
                      above), never a second place on this screen. */}
                  <Pressable onPress={() => setFilterMemberId(null)} style={styles.tab}>
                    <Text variant="label" numberOfLines={1} style={{ color: !filterMemberId ? palette.apportsInk : palette.apportsSecondary }}>
                      Tous
                    </Text>
                    {!filterMemberId && <View style={[styles.tabBar, { backgroundColor: palette.apportsPurple }]} />}
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
                        <Text variant="label" numberOfLines={1} style={{ color: active ? palette.apportsInk : palette.apportsSecondary }}>
                          {label}
                        </Text>
                        {active && <View style={[styles.tabBar, { backgroundColor: palette.apportsPurple }]} />}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              )}
              <View style={{ height: 1, backgroundColor: palette.border }} />
            </>
          )}
          ListEmptyComponent={(
            apports.length === 0 ? (
              <EmptyState
                icon="wallet-outline"
                title="Aucun capital noté pour le moment."
                subtitle="Notez l'argent que vous avez investi pour suivre votre commerce."
                actionLabel={canWrite ? '+ Ajouter un capital' : undefined}
                onAction={canWrite ? () => setShowAddChooser(true) : undefined}
              />
            ) : (
              <View style={styles.empty}>
                <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
                  Aucun apport pour ce contributeur.
                </Text>
              </View>
            )
          )}
          renderItem={({ item }) => {
            const name = displayName(item, userId, membres);
            const isWithdrawal = item.amount < 0;
            const numericPart = formatAmount(Math.abs(item.amount), currency).replace(` ${currency}`, '').trim();
            // Just the date in the list — note, contributor and edit history all
            // live in the tap-in detail, so the row stays calm and scannable.
            const meta = fmtDate(item.injected_at);
            return (
              <Pressable
                style={styles.row}
                onPress={canWrite ? () => openRow(item) : undefined}
              >
                <View style={styles.rowLeft}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {name !== 'Apport' ? name : '—'}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>{meta}</Text>
                </View>
                <Text
                  style={[styles.rowAmount, { color: isWithdrawal ? palette.apportsAmber : palette.apportsGreen }]}
                  numberOfLines={1}
                >
                  {isWithdrawal ? '− ' : '+ '}
                  {numericPart}
                  <Text style={[styles.rowCurrency, { color: isWithdrawal ? palette.apportsAmber : palette.apportsGreen }]}> {currency}</Text>
                </Text>
              </Pressable>
            );
          }}
        />
      )}

      <ApportFormModal
        visible={showForm}
        mode={formMode}
        editing={editingApport}
        businessId={businessId}
        currency={currency}
        saving={saving}
        offline={offline}
        onClose={() => { setShowForm(false); setEditingApport(null); }}
        onSave={handleSave}
      />

      {/* Add / withdraw chooser */}
      <Modal
        visible={showAddChooser}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAddChooser(false)}
        statusBarTranslucent
        navigationBarTranslucent
      >
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
    addBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing[1], padding: spacing[1] },
    headerMeta: {
      paddingHorizontal: spacing[5], paddingTop: spacing[1], paddingBottom: 0,
      gap: spacing[1],
    },
    totalText: {
      fontFamily: fontFamily.bold, fontSize: 36, letterSpacing: -0.5, lineHeight: 44,
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
    rowRight: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
    rowName: { fontFamily: fontFamily.semibold, fontSize: 15, color: p.apportsInk, letterSpacing: -0.2 },
    rowMeta: { fontSize: 12, color: p.apportsSecondary, letterSpacing: 0.1 },
    rowAmount: { fontFamily: fontFamily.bold, fontSize: 17, letterSpacing: -0.4 },
    rowCurrency: { fontSize: 12 },
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
    // View mode (read-only entry + image) — Ive-clean: hero amount, quiet
    // micro-labels, generous rhythm.
    viewWrap: { gap: spacing[7] },
    viewHero: { gap: spacing[2] },
    // No lineHeight was set here before — it silently inherited the default
    // Text variant's 24px line box on an 11px label, ~2x looser leading than
    // intended, on top of fontWeight being a no-op. 16 matches this app's
    // own `overline` variant (typography.ts), the closest existing style to
    // this uppercase micro-label's actual size/intent.
    viewMicroLabel: { fontFamily: fontFamily.semibold, fontSize: 11, lineHeight: 16, color: p.apportsSecondary, letterSpacing: 0.8, textTransform: 'uppercase' as const },
    viewAmount: { fontFamily: fontFamily.bold, fontSize: 36, color: p.apportsInk, letterSpacing: -0.5, lineHeight: 46 },
    viewDetails: { gap: spacing[5] },
    viewDetailRow: { gap: spacing[1] },
    viewValue: { fontFamily: fontFamily.medium, fontSize: 17, color: p.apportsInk, lineHeight: 24 },
    viewPhotoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
    viewPhotoAddRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingVertical: spacing[1] },

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
