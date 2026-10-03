import { useMemo, type ComponentProps } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FormSheet } from './FormSheet';
import { Text } from './Text';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { PRIVACY_INTERDICTIONS, PRIVACY_PROMISE } from '@/src/constants/conduct';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const INTERDICTION_ICONS: Record<string, IoniconName> = {
    autocomplete: 'text-outline',
    recherche: 'search-outline',
    partage: 'share-social-outline',
    alpha: 'sparkles-outline',
};

/**
 * Phase 4 — the privacy wall info screen. Shows the public promise
 * ("Vos chiffres ne quittent jamais votre carnet.") and the four ABSOLUTE
 * interdictions that keep business data out of the social spaces. Read-only,
 * calm, and versioned alongside the code de conduite.
 */
export function PrivacyWallSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const { palette } = useTheme();
    const styles = useMemo(() => makeStyles(palette), [palette]);

    return (
        <FormSheet visible={visible} onClose={onClose} title="Vos données restent privées" cancelLabel="Fermer">
            <View style={{ gap: spacing[4] }}>
                <View style={[styles.promise, { backgroundColor: palette.primaryLight }]}>
                    <Text variant="body" style={{ color: palette.primary, flex: 1, fontWeight: '600' }}>
                        {PRIVACY_PROMISE}
                    </Text>
                </View>

                {PRIVACY_INTERDICTIONS.map(rule => (
                    <View key={rule.id} style={styles.row}>
                        <View style={[styles.iconBadge, { backgroundColor: palette.primaryLight }]}>
                            <Ionicons
                                name={INTERDICTION_ICONS[rule.id] ?? 'shield-checkmark-outline'}
                                size={18}
                                color={palette.primary}
                            />
                        </View>
                        <View style={{ flex: 1, gap: spacing[1] }}>
                            <Text variant="label" color="primary">{rule.title}</Text>
                            <Text variant="body" color="secondary" style={{ lineHeight: 21 }}>{rule.full}</Text>
                        </View>
                    </View>
                ))}
            </View>
        </FormSheet>
    );
}

function makeStyles(p: Palette) {
    return StyleSheet.create({
        promise: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[2],
            borderRadius: radius.md,
            paddingHorizontal: spacing[4],
            paddingVertical: spacing[3],
        },
        row: {
            flexDirection: 'row',
            gap: spacing[3],
            alignItems: 'flex-start',
        },
        iconBadge: {
            width: 36,
            height: 36,
            borderRadius: radius.md,
            alignItems: 'center',
            justifyContent: 'center',
        },
    });
}
