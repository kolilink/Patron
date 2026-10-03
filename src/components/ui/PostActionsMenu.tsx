import { useMemo, useState, type ComponentProps } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FormSheet } from './FormSheet';
import { Text } from './Text';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useModerationStore } from '@/stores/moderation';
import { useMarketStore } from '@/stores/market';
import { REPORT_MOTIFS } from '@/src/constants/conduct';
import { toast } from '@/stores/toast';
import type { MarketPost, ReportMotif } from '@/src/types';
import { ConductRulesSheet } from './ConductBanner';

/**
 * The one affordance for "Signaler / Bloquer l'auteur / Supprimer" on a post.
 * Renders a kebab (⋯) button and owns all its sheets, so both post surfaces
 * (Le Marché list in discussions.tsx and the post detail in marche/[id].tsx)
 * expose the exact same actions — Phase 1, item 1: on EVERY publication, in
 * EVERY space.
 *
 *   * own post  → "Supprimer" (immediate)
 *   * other's   → "Signaler" + "Bloquer l'auteur"
 *   * both      → the code de conduite (Phase 2, linked from every report flow)
 */
export function PostActionsMenu({ post, isOwnPost }: { post: MarketPost; isOwnPost: boolean }) {
    const { palette } = useTheme();
    const styles = useMemo(() => makeStyles(palette), [palette]);

    const { deletePost, blockUser, reportPost } = useModerationStore();
    const removePost = useMarketStore(s => s.removePost);
    const removePostsByAuthor = useMarketStore(s => s.removePostsByAuthor);

    const [showActions, setShowActions] = useState(false);
    const [showReport, setShowReport] = useState(false);
    const [showRules, setShowRules] = useState(false);
    const [motif, setMotif] = useState<ReportMotif | null>(null);
    const [detail, setDetail] = useState('');
    const [reporting, setReporting] = useState(false);

    const openReport = () => {
        setShowActions(false);
        setMotif(null);
        setDetail('');
        setShowReport(true);
    };

    const openRules = () => {
        setShowActions(false);
        setShowRules(true);
    };

    const handleDelete = async () => {
        setShowActions(false);
        const ok = await deletePost(post.id);
        if (ok) {
            removePost(post.id);
            toast.success('Post supprimé.');
        }
    };

    const handleBlock = async () => {
        setShowActions(false);
        try {
            await blockUser(post.author_id);
            // Hide the author's posts in-session too — block_user only
            // rewrites the server RLS wall, so the already-loaded list
            // would keep showing them until the next fetch.
            removePostsByAuthor(post.author_id);
            toast.success('Auteur bloqué. Vous ne verrez plus ses publications.');
        } catch {
            // The store already surfaced a toast with the translated error.
        }
    };

    const handleSubmitReport = async () => {
        if (!motif) return;
        setReporting(true);
        try {
            await reportPost(post.id, motif, detail);
            // Hide the post from the reporter immediately — it stays
            // visible until the founder acts otherwise, which reads as
            // "nothing happened" after the success toast.
            removePost(post.id);
            setShowReport(false);
        } catch {
            // The store already surfaced a toast with the translated error.
        } finally {
            setReporting(false);
        }
    };

    const authorName = post.author_name || 'Cet auteur';

    return (
        <>
            <Pressable
                onPress={e => { e.stopPropagation(); setShowActions(true); }}
                hitSlop={10}
                accessibilityLabel="Plus d'options"
                accessibilityRole="button"
                style={({ pressed }) => [styles.trigger, pressed && { opacity: 0.5 }]}
            >
                <Ionicons name="ellipsis-horizontal" size={20} color={palette.textSecondary} />
            </Pressable>

            {/* ── Actions menu ── */}
            <FormSheet
                visible={showActions}
                onClose={() => setShowActions(false)}
                title={isOwnPost ? 'Votre post' : authorName}
                cancelLabel="Fermer"
            >
                <View style={styles.actionsContent}>
                    {isOwnPost ? (
                        <ActionRow
                            icon="trash-outline"
                            iconColor={palette.danger}
                            label="Supprimer ce post"
                            onPress={handleDelete}
                            last
                        />
                    ) : (
                        <>
                            <ActionRow
                                icon="flag-outline"
                                iconColor={palette.textPrimary}
                                label="Signaler"
                                onPress={openReport}
                            />
                            <ActionRow
                                icon="ban-outline"
                                iconColor={palette.danger}
                                label="Bloquer l'auteur"
                                onPress={handleBlock}
                                last
                            />
                        </>
                    )}
                    <ActionRow
                        icon="shield-checkmark-outline"
                        iconColor={palette.textSecondary}
                        label="Code de conduite"
                        onPress={openRules}
                        last
                    />
                </View>
            </FormSheet>

            {/* ── Report form ── */}
            <FormSheet
                visible={showReport}
                onClose={() => setShowReport(false)}
                title="Signaler ce post"
                cancelLabel="Annuler"
                headerRight={
                    <Pressable onPress={handleSubmitReport} disabled={reporting || !motif} hitSlop={8}>
                        <Text
                            variant="body"
                            style={{
                                color: reporting || !motif ? palette.textDisabled : palette.primary,
                                fontWeight: '600',
                            }}
                        >
                            {reporting ? '…' : 'Envoyer'}
                        </Text>
                    </Pressable>
                }
                contentContainerStyle={styles.reportContent}
                keyboardShouldPersistTaps="handled"
            >
                <Text variant="caption" color="secondary">
                    Pourquoi signalez-vous ce post ? Le signalement est transmis à la modération, qui le
                    traite en privé.
                </Text>

                <View style={{ gap: spacing[2], marginTop: spacing[2] }}>
                    {REPORT_MOTIFS.map(m => (
                        <Pressable
                            key={m.id}
                            onPress={() => setMotif(m.id)}
                            style={({ pressed }) => [
                                styles.motifRow,
                                motif === m.id && { borderColor: palette.primary, backgroundColor: palette.primaryLight },
                                pressed && { opacity: 0.7 },
                            ]}
                        >
                            <Ionicons
                                name={m.icon as ComponentProps<typeof Ionicons>['name']}
                                size={18}
                                color={motif === m.id ? palette.primary : palette.textSecondary}
                            />
                            <Text variant="body" style={{ flex: 1 }}>{m.label}</Text>
                            <Ionicons
                                name={motif === m.id ? 'radio-button-on' : 'radio-button-off'}
                                size={18}
                                color={motif === m.id ? palette.primary : palette.textDisabled}
                            />
                        </Pressable>
                    ))}
                </View>

                <TextInput
                    style={styles.detailInput}
                    value={detail}
                    onChangeText={setDetail}
                    placeholder="Précisions (facultatif)"
                    placeholderTextColor={palette.textDisabled}
                    multiline
                    maxLength={280}
                    textAlignVertical="top"
                />

                <Pressable onPress={openRules} style={{ marginTop: spacing[2] }}>
                    <Text variant="caption" style={{ color: palette.primary }}>
                        Consulter le code de conduite
                    </Text>
                </Pressable>
            </FormSheet>

            {/* ── Code de conduite (Phase 2 — shared, versioned rules sheet) ── */}
            <ConductRulesSheet visible={showRules} onClose={() => setShowRules(false)} />
        </>
    );
}

function ActionRow({
    icon,
    iconColor,
    label,
    onPress,
    last,
}: {
    icon: ComponentProps<typeof Ionicons>['name'];
    iconColor: string;
    label: string;
    onPress: () => void;
    last?: boolean;
}) {
    const { palette } = useTheme();
    return (
        <Pressable
            onPress={onPress}
            style={({ pressed }) => [
                {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing[3],
                    paddingVertical: spacing[4],
                    borderBottomWidth: last ? 0 : 1,
                    borderBottomColor: palette.border,
                },
                pressed && { opacity: 0.6 },
            ]}
        >
            <Ionicons name={icon} size={20} color={iconColor} />
            <Text variant="body" style={{ color: iconColor }}>{label}</Text>
        </Pressable>
    );
}

function makeStyles(p: Palette) {
    return StyleSheet.create({
        trigger: { padding: 4 },
        actionsContent: { paddingHorizontal: spacing[1] },
        reportContent: { padding: spacing[5] },
        motifRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[3],
            paddingHorizontal: spacing[4],
            paddingVertical: spacing[3],
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: p.border,
            backgroundColor: p.surface,
        },
        detailInput: {
            marginTop: spacing[3],
            minHeight: 80,
            borderWidth: 1,
            borderColor: p.border,
            borderRadius: radius.md,
            paddingHorizontal: spacing[3],
            paddingVertical: spacing[2],
            fontSize: 15,
            color: p.textPrimary,
            backgroundColor: p.background,
        },
        promise: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[2],
            borderRadius: radius.md,
            paddingHorizontal: spacing[4],
            paddingVertical: spacing[3],
        },
    });
}
