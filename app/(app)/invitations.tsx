import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/src/components/ui/Screen';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useInviterStore, buildInviteLink, buildInviteMessage } from '@/stores/inviter';
import type { ConsumerInvite } from '@/stores/inviter';
import { trackEvent } from '@/lib/analytics';
import { haptics } from '@/lib/haptics';
import { toast } from '@/stores/toast';

// ─── Invitations — Phase 6 code-hygiene surface ────────────────────────────
//
// The sender-side companion to the home header's one-tap "Inviter" pill. That
// pill stays a single tap straight into the share sheet (Phase 1); this screen
// is where the invitee's side of the promise gets made visible and kept honest:
//
//   * The hygiene notice sits directly above the share action — "Ce lien ne
//     marche qu'une fois, pendant 24 h. Envoie-le en privé, pas dans un groupe."
//   * Every invite is listed with its live status: active (revocable now),
//     used (who redeemed it and when — "X a rejoint", the Phase 5 sender
//     surface, progress not rewards), or revoked.
//   * Instant revocation of any unused code, with a confirm dialog.
//
// User-level, not business-level — invitations belong to the person, same as
// the store that backs them (stores/inviter.ts, keyed off auth.uid()).

// Relative "… ago" for used/revoked timestamps.
function agoLabel(iso: string): string {
    const diffM = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (diffM < 1) return "à l'instant";
    if (diffM < 60) return `il y a ${diffM} min`;
    const diffH = Math.floor(diffM / 60);
    if (diffH < 24) return `il y a ${diffH} h`;
    const diffD = Math.floor(diffH / 24);
    if (diffD <= 7) return `il y a ${diffD} j`;
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(iso));
}

// Countdown to expiry for a live invite.
function expiresLabel(iso: string): string {
    const diffM = Math.floor((new Date(iso).getTime() - Date.now()) / 60_000);
    if (diffM <= 0) return 'Expirée';
    if (diffM < 60) return `Expire dans ${diffM} min`;
    const diffH = Math.floor(diffM / 60);
    return `Expire dans ${diffH} h`;
}

function statusMeta(status: ConsumerInvite['status'], p: Palette) {
    switch (status) {
        case 'active':
            return { label: 'Active', bg: p.successLight, fg: p.success };
        case 'used':
            return { label: 'Utilisée', bg: p.primaryLight, fg: p.primary };
        case 'revoked':
            return { label: 'Révoquée', bg: p.border, fg: p.textSecondary };
    }
}

export default function InvitationsScreen() {
    const { palette } = useTheme();
    const styles = useMemo(() => makeStyles(palette), [palette]);
    const session = useAuthStore(s => s.session);
    const businessId = session?.activeBusiness?.id ?? '';
    const userId = session?.user.id ?? '';

    const invites = useInviterStore(s => s.invites);
    const loading = useInviterStore(s => s.loading);
    const error = useInviterStore(s => s.error);
    const fetchMyInvites = useInviterStore(s => s.fetchMyInvites);
    const revokeInvite = useInviterStore(s => s.revokeInvite);

    const [sharing, setSharing] = useState(false);
    const [revokingId, setRevokingId] = useState<string | null>(null);

    useEffect(() => {
        void fetchMyInvites();
    }, [fetchMyInvites]);

    const handleShareNew = useCallback(async () => {
        if (sharing) return;
        setSharing(true);
        haptics.tap();
        try {
            const invite = await useInviterStore.getState().createInvite();
            if (!invite) {
                const err = useInviterStore.getState().error;
                toast.warning(err ?? "Impossible de créer l'invitation");
                return;
            }
            const link = buildInviteLink(invite.token);
            const message = buildInviteMessage(link, invite.code);
            trackEvent('invite_sent', businessId, userId, { source: 'invitations_screen' });
            await Share.share({ message });
        } catch {
            toast.warning("Impossible d'ouvrir le partage");
        } finally {
            setSharing(false);
        }
    }, [sharing, businessId, userId]);

    const handleRevoke = useCallback((invite: ConsumerInvite) => {
        Alert.alert(
            "Révoquer l'invitation ?",
            "Ce lien ne pourra plus être utilisé. L'action est immédiate et définitive.",
            [
                { text: 'Annuler', style: 'cancel' },
                {
                    text: 'Révoquer',
                    style: 'destructive',
                    onPress: async () => {
                        haptics.destructive();
                        setRevokingId(invite.id);
                        const ok = await revokeInvite(invite.id);
                        setRevokingId(null);
                        if (!ok) {
                            toast.warning(useInviterStore.getState().error ?? "Impossible de révoquer l'invitation");
                        }
                    },
                },
            ],
        );
    }, [revokeInvite]);

    return (
        <Screen>
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} hitSlop={8}>
                    <Text variant="body" color="secondary">‹ Retour</Text>
                </Pressable>
                <Text variant="h4">Invitations</Text>
                <View style={{ width: 60 }} />
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
                {/* Hygiene notice — near the share action, per Phase 6. */}
                <View style={[styles.notice, { backgroundColor: palette.warningLight, borderColor: palette.warning }]}>
                    <Ionicons name="information-circle-outline" size={18} color={palette.warning} style={{ marginTop: 2 }} />
                    <Text variant="body" color="secondary" style={{ flex: 1 }}>
                        Ce lien ne marche qu'une fois, pendant 24 h. Envoie-le en privé, pas dans un groupe.
                    </Text>
                </View>

                <Button
                    label="Inviter un ami"
                    icon={<Ionicons name="person-add-outline" size={18} color={palette.textInverse} />}
                    loading={sharing}
                    fullWidth
                    size="lg"
                    onPress={handleShareNew}
                />

                <Text variant="label" color="secondary" style={styles.sectionLabel}>
                    Mes invitations
                </Text>

                {loading && invites.length === 0 ? (
                    <Text variant="body" color="secondary" style={styles.loadingLine}>Chargement…</Text>
                ) : invites.length === 0 ? (
                    <EmptyState
                        icon="people-outline"
                        title="Aucune invitation pour le moment."
                        subtitle="Chaque lien créé apparaîtra ici : qui l'a utilisé, et quand."
                    />
                ) : (
                    <View style={{ gap: spacing[3] }}>
                        {invites.map(invite => {
                            const meta = statusMeta(invite.status, palette);
                            const isRevoking = revokingId === invite.id;
                            return (
                                <View key={invite.id} style={styles.inviteRow}>
                                    <View style={styles.inviteRowTop}>
                                        <View style={[styles.statusBadge, { backgroundColor: meta.bg }]}>
                                            <Text allowFontScaling={false} style={[styles.statusBadgeText, { color: meta.fg }]}>{meta.label}</Text>
                                        </View>
                                        <View style={{ flex: 1 }} />
                                        {invite.status === 'active' && (
                                            <Pressable
                                                onPress={() => handleRevoke(invite)}
                                                disabled={isRevoking}
                                                hitSlop={8}
                                                style={({ pressed }) => [styles.revokeBtn, (pressed || isRevoking) && { opacity: 0.55 }]}
                                                accessibilityLabel="Révoquer cette invitation"
                                                accessibilityRole="button"
                                            >
                                                <Text allowFontScaling={false} style={[styles.revokeBtnText, { color: palette.danger }]}>
                                                    {isRevoking ? '…' : 'Révoquer'}
                                                </Text>
                                            </Pressable>
                                        )}
                                    </View>

                                    {invite.status === 'used' && invite.used_by_name ? (
                                        <Text variant="body" style={{ fontWeight: '600' }} numberOfLines={1}>
                                            {invite.used_by_name} a rejoint
                                        </Text>
                                    ) : (
                                        <Text variant="body" color="secondary" numberOfLines={1}>
                                            {invite.status === 'revoked' ? 'Lien révoqué' : 'Lien en attente'}
                                        </Text>
                                    )}
                                    <Text variant="caption" color="secondary" numberOfLines={1}>
                                        {invite.status === 'used' && invite.used_at
                                            ? `Utilisée ${agoLabel(invite.used_at)}`
                                            : invite.status === 'revoked' && invite.revoked_at
                                                ? `Révoquée ${agoLabel(invite.revoked_at)}`
                                                : `Créée ${agoLabel(invite.created_at)} · ${expiresLabel(invite.expires_at)}`}
                                    </Text>
                                </View>
                            );
                        })}
                    </View>
                )}

                {error ? (
                    <Text variant="caption" style={{ color: palette.warning }}>{error}</Text>
                ) : null}
            </ScrollView>
        </Screen>
    );
}

function makeStyles(p: Palette) {
    return StyleSheet.create({
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: spacing[5],
            borderBottomWidth: 1,
            borderBottomColor: p.border,
        },
        content: {
            padding: spacing[5],
            paddingBottom: spacing[10],
            gap: spacing[4],
        },
        notice: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: spacing[2],
            padding: spacing[4],
            borderRadius: radius.card,
            borderWidth: 1,
        },
        sectionLabel: {
            marginTop: spacing[2],
            textTransform: 'uppercase',
            letterSpacing: 0.4,
        },
        loadingLine: {
            paddingVertical: spacing[4],
        },
        inviteRow: {
            backgroundColor: p.surface,
            borderRadius: radius.card,
            borderWidth: 1,
            borderColor: p.border,
            padding: spacing[4],
            gap: spacing[1],
        },
        inviteRowTop: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[2],
        },
        statusBadge: {
            paddingHorizontal: spacing[2],
            paddingVertical: 3,
            borderRadius: radius.full,
            alignSelf: 'flex-start',
        },
        statusBadgeText: {
            fontSize: 12,
            fontWeight: '600',
            lineHeight: 16,
        },
        revokeBtn: {
            paddingHorizontal: spacing[2],
            paddingVertical: spacing[1],
        },
        revokeBtnText: {
            fontSize: 13,
            fontWeight: '600',
        },
    });
}
