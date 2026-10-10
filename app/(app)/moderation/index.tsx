import { useCallback, useEffect, useMemo, useState } from 'react';
import { appAlert } from '@/src/utils/appAlert';
import { FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/src/components/ui/Screen';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { router, useFocusEffect } from 'expo-router';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { DataState } from '@/src/components/ui/DataState';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useModerationStore } from '@/stores/moderation';
import { toast } from '@/stores/toast';
import { isFounderPhone } from '@/src/utils/founder';
import { REPORT_MOTIFS } from '@/src/constants/conduct';
import type { Report, ReportMotif } from '@/src/types';

const ETAT_LABEL: Record<Report['etat'], string> = {
    nouveau: 'Nouveau',
    en_cours: 'En cours',
    resolu: 'Résolu',
};

const ETAT_COLOR: Record<Report['etat'], 'primary' | 'warning' | 'secondary'> = {
    nouveau: 'warning',
    en_cours: 'primary',
    resolu: 'secondary',
};

function motifLabel(motif: ReportMotif): string {
    return REPORT_MOTIFS.find(m => m.id === motif)?.label ?? motif;
}

function relativeTime(iso: string): string {
    const diffM = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (diffM < 1) return 'maintenant';
    if (diffM < 60) return `${diffM}min`;
    const diffH = Math.floor(diffM / 60);
    if (diffH < 24) return `${diffH}h`;
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(iso));
}

export default function ModerationScreen() {
    const { palette } = useTheme();
    const styles = useMemo(() => makeStyles(palette), [palette]);
    const session = useAuthStore(s => s.session);
    const isFounder = isFounderPhone(session?.user.phone);

    const { reports, fetchStatus, updating, error, fetchReports, setReportEtat, deletePost, blockUser } =
        useModerationStore();

    const [active, setActive] = useState<Report | null>(null);

    useEffect(() => {
        if (!isFounder) {
            if (router.canGoBack()) router.back();
            else router.replace('/(app)/(tabs)/');
        }
    }, [isFounder]);

    useFocusEffect(useCallback(() => {
        if (!isFounder) return;
        fetchReports();
    }, [isFounder]));

    if (!isFounder) return null;

    const handleDelete = () => {
        if (!active?.post_id) return;
        appAlert(
            'Supprimer ce post ?',
            'Cette action est définitive et ne peut pas être annulée.',
            [
                { text: 'Annuler', style: 'cancel' },
                {
                    text: 'Supprimer', style: 'destructive',
                    onPress: async () => {
                        const ok = await deletePost(active.post_id);
                        if (ok) {
                            toast.success('Post supprimé.');
                            setActive(null);
                        }
                    },
                },
            ],
        );
    };

    const handleBlock = () => {
        if (!active?.post_author_id) return;
        const authorId = active.post_author_id;
        const authorName = active.post_author_name || 'cet auteur';
        appAlert(
            `Bloquer ${authorName} ?`,
            'Vous ne verrez plus ses publications.',
            [
                { text: 'Annuler', style: 'cancel' },
                {
                    text: 'Bloquer', style: 'destructive',
                    onPress: async () => {
                        try {
                            await blockUser(authorId);
                            toast.success('Auteur bloqué.');
                            setActive(null);
                        } catch {
                          // failure: speaks — the store already surfaced the translated failure toast
                            // The store already surfaced a toast with the translated error.
                        }
                    },
                },
            ],
        );
    };

    const renderReport = ({ item }: { item: Report }) => (
        <Pressable
            onPress={() => setActive(item)}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
        >
            <View style={{ flex: 1, gap: 3 }}>
                <View style={styles.nameRow}>
                    <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
                        {item.post_title || 'Post supprimé'}
                    </Text>
                    {item.report_count > 1 && (
                        <View style={[styles.countBadge, { backgroundColor: palette.warningLight }]}>
                            <Text variant="labelSmall" style={{ color: palette.warning }}>
                                {item.report_count}×
                            </Text>
                        </View>
                    )}
                </View>
                <Text variant="caption" color="secondary" numberOfLines={1}>
                    {motifLabel(item.motif)}
                    {item.post_author_name ? ` · ${item.post_author_name}` : ''}
                </Text>
                {item.post_excerpt ? (
                    <Text variant="caption" color="secondary" numberOfLines={1}>
                        « {item.post_excerpt} »
                    </Text>
                ) : null}
            </View>
            <View style={{ alignItems: 'flex-end', gap: spacing[1] }}>
                <Text variant="labelSmall" color={ETAT_COLOR[item.etat]}>{ETAT_LABEL[item.etat]}</Text>
                <Text variant="caption" color="secondary">{relativeTime(item.created_at)}</Text>
            </View>
        </Pressable>
    );

    return (
        <Screen>
            <View style={styles.header}>
                <Pressable onPress={() => router.back()}>
                    <Text variant="body" color="secondary">‹ Retour</Text>
                </Pressable>
                <View style={{ alignItems: 'center' }}>
                    <Text variant="h4">Modération</Text>
                    <Text variant="caption" color="secondary" numberOfLines={1}>File des signalements</Text>
                </View>
                <View style={{ width: 60 }} />
            </View>

            <DataState
              status={fetchStatus}
              isEmpty={reports.length === 0}
              skeleton={<SkeletonList count={6} />}
              empty={(
                <EmptyState
                    icon="shield-checkmark-outline"
                    title="Aucun signalement."
                    subtitle="La communauté est calme pour le moment."
                />
            )}
            >
                <FlatList<Report>
                    data={reports}
                    keyExtractor={r => r.id}
                    contentContainerStyle={{ paddingBottom: spacing[10] }}
                    renderItem={renderReport}
                    ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
                />
            </DataState>

            {error ? (
                <View style={styles.errorStrip}>
                    <Text variant="caption" style={{ color: palette.danger }}>{error}</Text>
                </View>
            ) : null}

            {/* ── Detail sheet: treat in under 5 minutes ── */}
            <FormSheet
                visible={!!active}
                onClose={() => setActive(null)}
                title={active?.post_title || 'Signalement'}
                cancelLabel="Fermer"
            >
                {active && (
                    <View style={styles.detailContent}>
                        <View style={styles.detailMeta}>
                            <Text variant="body" style={{ fontWeight: '600' }}>
                                {motifLabel(active.motif)}
                            </Text>
                            {active.post_author_name && (
                                <Text variant="caption" color="secondary">
                                    Auteur : {active.post_author_name}
                                </Text>
                            )}
                            {active.detail ? (
                                <Text variant="body" color="secondary" style={{ marginTop: spacing[2] }}>
                                    {active.detail}
                                </Text>
                            ) : null}
                        </View>

                        {active.post_excerpt ? (
                            <View style={styles.excerptCard}>
                                <Text variant="body" color="secondary" numberOfLines={6}>
                                    {active.post_excerpt}
                                </Text>
                            </View>
                        ) : null}

                        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: spacing[3] }}>
                            <View style={{ flexDirection: 'row', gap: spacing[2] }}>
                                {(['en_cours', 'resolu', 'nouveau'] as const).map(etat => (
                                    <Pressable
                                        key={etat}
                                        onPress={() => setReportEtat(active.id, etat)}
                                        disabled={updating || active.etat === etat}
                                        style={({ pressed }) => [
                                            styles.chip,
                                            active.etat === etat && { backgroundColor: palette.primary },
                                            pressed && { opacity: 0.7 },
                                        ]}
                                    >
                                        <Text
                                            variant="labelSmall"
                                            style={{ color: active.etat === etat ? palette.textInverse : palette.textSecondary }}
                                        >
                                            {ETAT_LABEL[etat]}
                                        </Text>
                                    </Pressable>
                                ))}
                            </View>
                        </ScrollView>

                        <View style={{ flexDirection: 'row', gap: spacing[3], marginTop: spacing[4] }}>
                            <Button
                                label="Bloquer l'auteur"
                                variant="danger"
                                icon={<Ionicons name="ban-outline" size={16} color={palette.textInverse} />}
                                onPress={handleBlock}
                                disabled={!active.post_author_id}
                                style={{ flex: 1 }}
                            />
                            <Button
                                label="Supprimer le post"
                                variant="danger"
                                icon={<Ionicons name="trash-outline" size={16} color={palette.textInverse} />}
                                onPress={handleDelete}
                                disabled={!active.post_id}
                                style={{ flex: 1 }}
                            />
                        </View>
                    </View>
                )}
            </FormSheet>
        </Screen>
    );
}

function makeStyles(p: Palette) {
    return StyleSheet.create({
        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: p.border },
        row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[5], paddingVertical: spacing[4], backgroundColor: p.surface },
        nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
        countBadge: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: radius.full },
        errorStrip: { padding: spacing[4], backgroundColor: p.dangerLight },
        detailContent: { gap: spacing[3] },
        detailMeta: { gap: spacing[1] },
        excerptCard: { backgroundColor: p.background, borderRadius: radius.md, padding: spacing[4], borderWidth: 1, borderColor: p.border },
        chip: { paddingHorizontal: spacing[4], paddingVertical: spacing[2], borderRadius: radius.full, backgroundColor: p.background, borderWidth: 1, borderColor: p.border },
    });
}
