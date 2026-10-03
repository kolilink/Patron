import { useMemo, useState, type ComponentProps } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FormSheet } from './FormSheet';
import { Text } from './Text';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { CONDUCT_RULES, PRIVACY_PROMISE } from '@/src/constants/conduct';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

/**
 * Phase 2 — the code de conduite, pinned atop every social space and visible
 * BEFORE publishing. The banner is a compact, always-visible strip; tapping it
 * opens the full, versioned rules sheet (never silently rephrased). The
 * composer gets its own compact reminder via <ComposerReminder />.
 */
export function ConductBanner({ compact = false }: { compact?: boolean }) {
    const { palette } = useTheme();
    const styles = useMemo(() => makeStyles(palette), [palette]);
    const [show, setShow] = useState(false);

    return (
        <>
            <Pressable
                onPress={() => setShow(true)}
                style={({ pressed }) => [
                    styles.banner,
                    compact && styles.bannerCompact,
                    pressed && { opacity: 0.7 },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Code de conduite"
            >
                <Ionicons name="shield-checkmark-outline" size={15} color={palette.primary} />
                <View style={styles.bannerTextWrap}>
                    <Text variant="caption" style={styles.bannerTitle}>Code de conduite</Text>
                    <Text variant="labelSmall" color="secondary" numberOfLines={compact ? 1 : 2}>
                        {CONDUCT_RULES.map(r => r.short).join(' · ')}
                    </Text>
                </View>
                <Ionicons name="chevron-forward" size={15} color={palette.textSecondary} />
            </Pressable>

            <ConductRulesSheet visible={show} onClose={() => setShow(false)} />
        </>
    );
}

/**
 * The compact reminder rendered inside the composer, so the rules are seen
 * BEFORE publishing (not only after a report is already needed). Includes the
 * public privacy promise.
 */
export function ComposerReminder() {
    const { palette } = useTheme();
    const styles = useMemo(() => makeStyles(palette), [palette]);

    return (
        <View style={styles.reminder}>
            <View style={styles.reminderHeader}>
                <Ionicons name="information-circle-outline" size={15} color={palette.primary} />
                <Text variant="labelSmall" style={{ color: palette.primary }}>
                    Avant de publier
                </Text>
            </View>
            <Text variant="caption" color="secondary" style={{ lineHeight: 17 }}>
                {CONDUCT_RULES.map(r => r.short).join(' · ')}.
            </Text>
            <Text variant="caption" style={{ color: palette.primary, lineHeight: 17 }}>
                {PRIVACY_PROMISE}
            </Text>
        </View>
    );
}

/**
 * The single, versioned rules sheet. Shared by the banner and the report flow
 * so the wording is identical everywhere.
 */
export function ConductRulesSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const { palette } = useTheme();
    const styles = useMemo(() => makeStyles(palette), [palette]);
    return (
        <FormSheet visible={visible} onClose={onClose} title="Code de conduite" cancelLabel="Fermer">
            <View style={{ gap: spacing[4] }}>
                {CONDUCT_RULES.map(rule => (
                    <View key={rule.id} style={{ gap: spacing[1] }}>
                        <Text variant="label" color="primary">{rule.short}</Text>
                        <Text variant="body" color="secondary" style={{ lineHeight: 21 }}>{rule.full}</Text>
                    </View>
                ))}
                <View style={[styles.promise, { backgroundColor: palette.primaryLight }]}>
                    <Text variant="caption" style={{ color: palette.primary, flex: 1 }}>{PRIVACY_PROMISE}</Text>
                </View>
            </View>
        </FormSheet>
    );
}

function makeStyles(p: Palette) {
    return StyleSheet.create({
        banner: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[2],
            marginHorizontal: spacing[4],
            marginTop: spacing[2],
            paddingHorizontal: spacing[3],
            paddingVertical: spacing[2],
            borderRadius: radius.md,
            backgroundColor: p.primaryLight,
            borderWidth: 1,
            borderColor: `${p.primary}30`,
        },
        bannerCompact: {
            marginTop: spacing[1],
            paddingVertical: spacing[1],
        },
        bannerTextWrap: { flex: 1, gap: 1 },
        bannerTitle: { color: p.primary, fontWeight: '600' },
        reminder: {
            gap: spacing[1],
            padding: spacing[3],
            borderRadius: radius.md,
            backgroundColor: p.primaryLight,
            borderWidth: 1,
            borderColor: `${p.primary}30`,
            marginBottom: spacing[3],
        },
        reminderHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
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
