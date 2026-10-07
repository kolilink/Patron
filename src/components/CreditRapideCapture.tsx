import { useEffect, useMemo, useRef, useState } from 'react';
import { SilentKeyboardAccessory } from '@/src/components/ui/SilentKeyboardAccessory';
import { TRUST_LINE } from '@/src/utils/trustLine';
import { Animated, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius, fontFamily, CLIENT_AVATAR_PALETTE } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { formatAmountInput, parseAmountInput, formatAmount } from '@/src/utils/format';
import { useQuickClients, type QuickClient } from '@/src/hooks/useQuickClients';
import { useSalesStore } from '@/stores/sales';
import { supabase } from '@/lib/supabase';
import { haptics } from '@/lib/haptics';
import { trackEvent } from '@/lib/analytics';

// ── Crédit rapide — the shared entry logic for both places this exists:
// Accueil's "+" (QuickCaptureSheet) and Vendre's own Crédit tab. Previously
// two separately-maintained, near-identical implementations (name field →
// phone → amount, both autofocused on a blank Nom TextInput) — the exact
// "deux implémentations différentes" drift this codebase has already been
// burned by elsewhere (fournisseurs' old duplicate "Nouvelle commande"
// screens). One component now, embedded by both hosts.
//
// The redesign itself follows a research pass (KhataBook/OkCredit's shipped
// pattern, InfiniteUp's measured funnel — 18% completion on first attempts,
// mandatory phone + a post-save WhatsApp detour were the two measured
// killers, only 1 in 14 ever logged a second transaction): recognition
// before recall (tap a face, don't type a name), amount-only in the rush
// path, stay in the loop after adding (back to faces, not a blank field).
// Deliberately scoped to *entry* only — no "qui me doit"/collection surface
// here, that's a separate pass.
//
// Two things the research flagged but this pass deliberately doesn't build:
// round-amount quick chips (the research itself says these need real
// on-the-ground usage data before picking values, not guessed) and a
// post-add "Annuler" undo (would need submitCarnetDebt to return the new
// order id — a shared, hardened function — for what's a nice-to-have here,
// not core to the entry redesign).

const MAX_GRID_CLIENTS = 8; // "5-8 recent/frequent, visible on open" — the research's own number
// Height of one chip row (56 avatar + 4 gap + caption line) — reserved while
// the first client load is in flight so nothing below the grid jumps when the
// chips arrive.
const GRID_PLACEHOLDER_HEIGHT = 78;
// Upper bound on how long the chip row is held back. The clients query has no
// client-side timeout of its own (global fetch abort is 15s), and "Nouveau" —
// the primary action when a business has no history, or no connection — must
// never wait that long. Past this, the grid renders with whatever has loaded
// (possibly just "Nouveau") and chips that arrive later pop in; accepted for
// the slow/offline case only.
const GRID_GATE_MAX_MS = 1500;
const AMOUNT_SILENT_ACCESSORY_ID = 'creditRapideAmountSilentAccessory';
// Longer than the sheet's slide-up, for focus calls that fire at mount.
const SHEET_SETTLE_MS = 450;

interface CreditRapideCaptureProps {
  businessId: string;
  userId: string;
  currency: string;
  /** Called when the "N crédits · Voir" link is tapped — hosts differ on
   * whether they need to close themselves first (a Modal host) before
   * navigating, or can just push (an inline screen host). */
  onViewClients?: () => void;
  /** Called with the debt's amount (cents) right after a successful save —
   * feeds the host's own session ticker (visible under the Crédit/Vente
   * toggle), which has to survive a mode switch and so can't live in this
   * component's own state, unlike sessionCount below (that one only drives
   * this component's own "N crédits noté(s) · Voir →" link). */
  onAdded?: (amountCents: number) => void;
  /** Skips the pick-a-face grid entirely and lands straight on the amount
   * step for this one client — used by the client ledger's own "+ Nouveau
   * crédit" button, where the customer is already the whole point of the
   * screen and re-picking her from a grid would be backwards. `id` is
   * omitted for a client that only exists as a bare customer_name string
   * (no real clients row) — submitCarnetDebt already accepts a null id. */
  initialClient?: { id?: string; name: string };
  /** Called once the confirm window ends after a save made against
   * initialClient — closes the host's sheet instead of resetting back to
   * the pick grid, since there's no grid to return to in this mode. */
  onDone?: () => void;
}

function initialsAvatar(name: string) {
  const sum = name ? name.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) : 0;
  const pair = CLIENT_AVATAR_PALETTE[sum % CLIENT_AVATAR_PALETTE.length];
  return { bg: pair.bg, text: pair.text, initial: name ? name.charAt(0).toUpperCase() : '?' };
}

export function CreditRapideCapture({ businessId, userId, currency, onViewClients, onAdded, initialClient, onDone }: CreditRapideCaptureProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const submitCarnetDebt = useSalesStore(s => s.submitCarnetDebt);

  // Bumped after every successful add so the recency ranking is live within
  // one rapid multi-entry session, not just on next mount.
  const [refreshKey, setRefreshKey] = useState(0);
  // Only the very first load gates the grid (`loaded` never goes back to
  // false for the same business) — a refreshKey refetch after an add keeps
  // showing the previous list until the new one swaps in atomically.
  const { clients, loaded: clientsLoaded } = useQuickClients(businessId, refreshKey);
  const [gateTimedOut, setGateTimedOut] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGateTimedOut(true), GRID_GATE_MAX_MS);
    return () => clearTimeout(t);
  }, []);
  const gridReady = clientsLoaded || gateTimedOut;

  type Phase = 'pick' | 'amount';
  const [phase, setPhase] = useState<Phase>(initialClient ? 'amount' : 'pick');
  const [search, setSearch] = useState('');
  const [isNew, setIsNew] = useState(false);
  const [name, setName] = useState(initialClient?.name ?? '');
  const [clientId, setClientId] = useState<string | undefined>(initialClient?.id);
  const [amount, setAmount] = useState('');
  const [clientBalance, setClientBalance] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionCount, setSessionCount] = useState(0);

  const nameRef = useRef<TextInput>(null);
  const amountRef = useRef<TextInput>(null);
  const blinkAnim = useRef(new Animated.Value(0)).current;
  const blinkLoopRef = useRef<Animated.CompositeAnimation | null>(null);
  // Deferred focus (one at a time) and the post-save reset are both tracked
  // so an unmount (e.g. Crédit→Vente switch) cancels them instead of letting
  // them fire into a screen that has moved on; a phase change also cancels a
  // still-pending focus, which would otherwise target the wrong phase's
  // field. The reset timer is deliberately NOT cancelled by phase changes —
  // it's what clears `success`, and dropping it would leave handleAdd's
  // `if (success) return` guard stuck on.
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelFocus = () => { if (focusTimerRef.current) { clearTimeout(focusTimerRef.current); focusTimerRef.current = null; } };
  // `delay` is 80ms for in-sheet taps; the mount-time paths (initialClient,
  // empty-grid skip) pass SHEET_SETTLE_MS so the keyboard never rises while the
  // sheet is still sliding up.
  const focusLater = (ref: { current: TextInput | null }, delay = 80) => {
    cancelFocus();
    focusTimerRef.current = setTimeout(() => { focusTimerRef.current = null; ref.current?.focus(); }, delay);
  };
  useEffect(() => () => {
    cancelFocus();
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  // Mirrors pickClient's own focus behavior — initialClient lands directly
  // on 'amount' phase (set in the useState initializers above), so nothing
  // else would ever focus this field otherwise.
  useEffect(() => {
    if (initialClient) focusLater(amountRef, SHEET_SETTLE_MS);
    // Deliberately mount-only — initialClient is fixed for this component's
    // whole lifetime (the host remounts it fresh per open, same as every
    // other consumer of this component).
  }, []);

  const searching = search.trim().length > 0;
  const filteredClients = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients.slice(0, MAX_GRID_CLIENTS);
    return clients.filter(c => c.name.toLowerCase().includes(q) || (c.phone ?? '').includes(q));
  }, [clients, search]);

  // Amber pulse on the amount box while a name is set but nothing's been
  // typed yet — a wordless "this is the next thing to do" nudge, ported
  // from vendre.tsx's own already-shipped credit tab rather than reinvented.
  useEffect(() => {
    const active = phase === 'amount' && (isNew ? name.trim().length > 0 : true) && !amount;
    if (active) {
      blinkLoopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(blinkAnim, { toValue: 1, duration: 700, useNativeDriver: false }),
          Animated.timing(blinkAnim, { toValue: 0, duration: 700, useNativeDriver: false }),
        ]),
      );
      blinkLoopRef.current.start();
    } else {
      blinkLoopRef.current?.stop();
      blinkLoopRef.current = null;
      Animated.timing(blinkAnim, { toValue: 0, duration: 150, useNativeDriver: false }).start();
    }
    return () => { blinkLoopRef.current?.stop(); };
  }, [phase, isNew, name, amount]);

  // Outstanding balance preview for the selected client, shown once she's
  // picked someone with an existing debt — context, not a collection tool.
  useEffect(() => {
    if (phase !== 'amount' || !clientId) { setClientBalance(null); return; }
    let cancelled = false;
    supabase
      .from('sale_orders')
      .select('id, total_amount, discount_amount')
      .eq('business_id', businessId)
      .eq('client_id', clientId)
      .eq('status', 'credit')
      .then(async ({ data: orders }) => {
        if (cancelled) return;
        if (!orders?.length) { setClientBalance(null); return; }
        const orderIds = orders.map(o => (o as { id: string }).id);
        const { data: pays } = await supabase.from('payments').select('order_id, amount').in('order_id', orderIds);
        if (cancelled) return;
        const paidByOrder: Record<string, number> = {};
        for (const p of (pays ?? []) as { order_id: string; amount: number }[]) {
          paidByOrder[p.order_id] = (paidByOrder[p.order_id] ?? 0) + p.amount;
        }
        const totalCents = (orders as { id: string; total_amount: number; discount_amount: number | null }[])
          .reduce((sum, s) => {
            const remaining = s.total_amount - (s.discount_amount ?? 0) - (paidByOrder[s.id] ?? 0);
            return sum + (remaining > 0 ? remaining : 0);
          }, 0);
        setClientBalance(totalCents > 0 ? totalCents / 100 : null);
      });
    return () => { cancelled = true; };
  }, [phase, clientId, businessId]);

  const pickClient = (c: QuickClient) => {
    setIsNew(false);
    setName(c.name);
    setClientId(c.id);
    setError(null);
    setPhase('amount');
    focusLater(amountRef);
  };

  const pickNew = (focusDelay = 80) => {
    setIsNew(true);
    setName('');
    setClientId(undefined);
    setError(null);
    setPhase('amount');
    focusLater(nameRef, focusDelay);
  };

  // Zero confirmed clients → the pick-a-face grid would show only "Nouveau", so
  // go straight to the name + amount form. Only once gridReady (never while the
  // first load is still in flight), only once per mount (clients arriving later
  // must never yank her back to the grid mid-typing), and never when the host
  // already named the client.
  const skippedEmptyGridRef = useRef(false);
  useEffect(() => {
    if (skippedEmptyGridRef.current || initialClient || phase !== 'pick') return;
    if (gridReady && clients.length === 0) {
      skippedEmptyGridRef.current = true;
      pickNew(SHEET_SETTLE_MS);
    }
  }, [gridReady, clients.length, phase]);

  const backToPick = () => {
    cancelFocus(); // a pending focus must not fire against the grid
    setPhase('pick');
    setError(null);
  };

  const handleAdd = async () => {
    // success guards against a double-submit while the "✓ Ajouté" confirm
    // is still showing — name/amount aren't cleared until the timeout below
    // fires, so without this a second tap in that window would silently
    // record the same debt twice.
    if (success) return;
    const trimmedName = name.trim();
    const parsed = Math.round(parseAmountInput(amount, currency));
    if (!trimmedName || isNaN(parsed) || parsed <= 0) return;
    setSaving(true);
    setError(null);

    let resolvedClientId = clientId;
    if (!resolvedClientId) {
      // A failure/timeout here must never block the debt submission below —
      // submitCarnetDebt already accepts a null client id, so this just
      // degrades to "no linked client this time."
      try {
        const { data } = await supabase.from('clients').upsert(
          { business_id: businessId, name: trimmedName },
          { onConflict: 'business_id,name' },
        ).select('id').single();
        resolvedClientId = data?.id ?? undefined;
      } catch {
        resolvedClientId = undefined;
      }
    }

    const ok = await submitCarnetDebt(businessId, userId, trimmedName, parsed * 100, resolvedClientId ?? null);
    setSaving(false);
    if (!ok) {
      setError('Impossible d\'enregistrer. Vérifiez votre connexion et réessayez.');
      return;
    }
    const wasQueued = useSalesStore.getState().lastCarnetDebtQueued;
    trackEvent('quick_capture_submitted', businessId, userId, { mode: 'credit', queued: wasQueued });
    haptics.success();
    onAdded?.(parsed * 100);
    setSuccess(true);
    setSessionCount(c => c + 1);
    setRefreshKey(k => k + 1);
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setSuccess(false);
      // initialClient mode has no grid to return to — one credit for this
      // one customer is the whole point, so close the host's sheet instead
      // of resetting fields for a "next" entry that was never on offer.
      if (initialClient) { onDone?.(); return; }
      setName(''); setClientId(undefined); setAmount(''); setIsNew(false); setClientBalance(null);
      setSearch('');
      setPhase('pick'); // "retour immédiat aux visages" — stay in the loop, not a blank field
    }, 900);
  };

  return (
    <View style={styles.content}>
      {phase === 'pick' ? (
        <>
          {/* Chips appear together or not at all: until the first load
              resolves (or GRID_GATE_MAX_MS passes) the row is reserved
              empty space — including "Nouveau", so it doesn't sit alone
              and then get pushed around by the rest. */}
          {!gridReady ? (
            <View style={{ height: GRID_PLACEHOLDER_HEIGHT }} />
          ) : (
          <View style={styles.grid}>
            {filteredClients.map(c => {
              const { bg, text: avatarText, initial } = initialsAvatar(c.name);
              return (
                <Pressable
                  key={c.id ?? c.name}
                  onPress={() => pickClient(c)}
                  style={({ pressed }) => [styles.personCell, pressed && { opacity: 0.6 }]}
                >
                  <View style={[styles.personAvatar, { backgroundColor: bg }]}>
                    <Text allowFontScaling={false} style={{ fontFamily: fontFamily.bold, fontSize: 18, lineHeight: 22, color: avatarText }}>
                      {initial}
                    </Text>
                  </View>
                  <Text variant="caption" numberOfLines={1} style={{ fontFamily: fontFamily.semibold, maxWidth: 84 }}>
                    {c.name}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable onPress={() => pickNew()} style={({ pressed }) => [styles.personCell, pressed && { opacity: 0.6 }]}>
              <View style={[styles.personAvatar, styles.personAvatarNew, { borderColor: palette.primary }]}>
                <Ionicons name="person-add-outline" size={20} color={palette.primary} />
              </View>
              <Text variant="caption" style={{ color: palette.primary, fontFamily: fontFamily.semibold }}>Nouveau</Text>
            </Pressable>
          </View>
          )}

          {gridReady && (clients.length > MAX_GRID_CLIENTS || searching) && (
            <TextInput
              style={[styles.search, { color: palette.textPrimary, borderColor: palette.border }]}
              value={search}
              onChangeText={setSearch}
              placeholder="Rechercher…"
              placeholderTextColor={palette.textDisabled}
            />
          )}
          {searching && filteredClients.length === 0 && (
            <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>Aucun client trouvé</Text>
          )}
        </>
      ) : (
        <>
          {!initialClient && (
            <Pressable onPress={backToPick} hitSlop={8} style={{ alignSelf: 'flex-start' }}>
              <Text variant="caption" color="secondary">‹ Changer</Text>
            </Pressable>
          )}

          {isNew ? (
            <TextInput
              ref={nameRef}
              style={[styles.nameInput, { color: palette.textPrimary, borderColor: palette.border }]}
              placeholder="Nom"
              placeholderTextColor={palette.textDisabled}
              value={name}
              onChangeText={v => { setName(v); setError(null); }}
              returnKeyType="next"
              onSubmitEditing={() => amountRef.current?.focus()}
              autoCapitalize="words"
            />
          ) : (
            <Text variant="h3">{name}</Text>
          )}

          <View>
            <Text variant="label" color="secondary" style={{ marginBottom: spacing[2] }}>
              Combien {name.trim() || 'il'} vous doit ?
            </Text>
            <Animated.View style={[styles.amountBox, {
              borderColor: blinkAnim.interpolate({ inputRange: [0, 1], outputRange: [palette.border, palette.primary] }),
            }]}>
              <TextInput
                ref={amountRef}
                style={[styles.amountInput, { color: amount ? palette.textPrimary : palette.textDisabled }]}
                placeholder="0"
                placeholderTextColor={palette.textDisabled}
                value={amount}
                onChangeText={v => { setAmount(formatAmountInput(v, currency)); setError(null); }}
                keyboardType="numeric"
                returnKeyType="done"
                inputAccessoryViewID={Platform.OS === 'ios' ? AMOUNT_SILENT_ACCESSORY_ID : undefined}
                onSubmitEditing={handleAdd}
              />
              <Text style={[styles.amountCurrency, { color: palette.textSecondary }]}>{currency}</Text>
            </Animated.View>
            {clientBalance !== null && clientBalance > 0 && (
              <Text variant="caption" style={{ color: palette.textDisabled, marginTop: spacing[1], textAlign: 'center' }}>
                Solde actuel · {formatAmount(clientBalance, currency)}
              </Text>
            )}
          </View>

          {/* Brand purple throughout, label swap only — the confirmation is
              "✓ Ajouté" plus the haptic already fired above, never a color
              change (queued vs. synced is no longer distinguished here; the
              persistent SyncBanner already covers that elsewhere). */}
          <Button
            label={success ? '✓ Ajouté' : 'Ajouter'}
            onPress={handleAdd}
            loading={saving}
            disabled={!name.trim() || !(parseAmountInput(amount, currency) > 0)}
            fullWidth
            size="lg"
          />
          {error ? (
            <Text variant="caption" style={{ color: palette.warning, textAlign: 'center' }}>{error}</Text>
          ) : null}
          <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>{TRUST_LINE}</Text>
        </>
      )}

      {sessionCount > 0 && !error && onViewClients ? (
        <Pressable
          onPress={onViewClients}
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing[1], marginTop: spacing[1] }}
        >
          <Text variant="caption" style={{ color: palette.success }}>
            {sessionCount} crédit{sessionCount > 1 ? 's' : ''} noté{sessionCount > 1 ? 's' : ''}
          </Text>
          <Text variant="caption" style={{ color: palette.primary }}>· Voir →</Text>
        </Pressable>
      ) : null}

      <SilentKeyboardAccessory nativeID={AMOUNT_SILENT_ACCESSORY_ID} />
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    content: { gap: spacing[4] },
    // Fixed cell width, not a percentage — with RN's `gap` on a flex-wrap
    // row, a percentage width doesn't account for the gaps themselves and
    // can wrap earlier/later than intended. A fixed width sidesteps that:
    // however many fit per row on a given screen, they fit cleanly.
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3], justifyContent: 'flex-start' },
    personCell: { width: 78, alignItems: 'center', gap: spacing[1] },
    personAvatar: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
    personAvatarNew: { backgroundColor: 'transparent', borderWidth: 1.5, borderStyle: 'dashed' },
    search: {
      borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing[4], paddingVertical: spacing[3], fontSize: 15,
    },
    nameInput: {
      borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing[4], paddingVertical: spacing[3], fontSize: 20,
      lineHeight: 25, fontFamily: fontFamily.semibold,
    },
    amountBox: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing[4], paddingVertical: spacing[4],
    },
    amountInput: { flex: 1, fontSize: 28, lineHeight: 34, fontFamily: fontFamily.bold },
    amountCurrency: { fontSize: 16, fontFamily: fontFamily.semibold },
  });
}
