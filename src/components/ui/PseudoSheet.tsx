import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FormSheet } from './FormSheet';
import { Text } from './Text';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { friendlyMessage } from '@/lib/errors';
import { PRIVACY_PROMISE } from '@/src/constants/conduct';

/**
 * Phase 5 — stable visible identity, chosen and confirmed at arrival.
 * The member picks a familiar pseudo; it is shown in every space in place of
 * the legal name, and every post resolves to this stable account. Anonymous
 * posts are impossible: the composer opens this sheet until a pseudo exists.
 */
export function PseudoSheet({
    visible,
    onClose,
    onConfirmed,
}: {
    visible: boolean;
    onClose: () => void;
    onConfirmed?: (pseudo: string) => void;
}) {
    const { palette } = useTheme();
    const styles = useMemo(() => makeStyles(palette), [palette]);
    const confirmPseudo = useAuthStore(s => s.confirmPseudo);
    const currentPseudo = useAuthStore(s => s.session?.user.pseudo ?? null);

    const [pseudo, setPseudo] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const submit = async () => {
        const trimmed = pseudo.trim();
        if (trimmed.length < 2) {
            setError('Le pseudo doit contenir au moins 2 caractères');
            return;
        }
        if (trimmed.length > 30) {
            setError('Le pseudo doit contenir au plus 30 caractères');
            return;
        }
        setSaving(true);
        setError('');
        try {
            const confirmed = await confirmPseudo(trimmed);
            setPseudo('');
            onClose();
            onConfirmed?.(confirmed);
        } catch (err) {
            setError(friendlyMessage(err, 'Impossible de confirmer ce pseudo'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={currentPseudo ? 'Mon pseudo' : 'Choisissez votre pseudo'}
            cancelLabel="Plus tard"
            headerRight={
                <Pressable onPress={submit} disabled={saving} hitSlop={8}>
                    <Text
                        variant="body"
                        style={{ color: saving ? palette.textDisabled : palette.primary, fontWeight: '600' }}
                    >
                        {saving ? '…' : 'Confirmer'}
                    </Text>
                </Pressable>
            }
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
        >
            <Text variant="caption" color="secondary" style={{ lineHeight: 19 }}>
                Ce pseudo est votre identité visible dans les espaces sociaux. Votre nom légal et vos
                chiffres restent privés — seul votre pseudo apparaît.
            </Text>

            <View style={styles.inputWrap}>
                <Ionicons name="person-outline" size={18} color={palette.textSecondary} />
                <TextInput
                    style={styles.input}
                    value={pseudo}
                    onChangeText={t => { setPseudo(t); setError(''); }}
                    placeholder={currentPseudo ?? 'Votre pseudo'}
                    placeholderTextColor={palette.textDisabled}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoFocus
                    maxLength={30}
                    returnKeyType="done"
                    onSubmitEditing={submit}
                />
            </View>
            <Text variant="caption" color="secondary">2 à 30 caractères · unique</Text>

            {error ? (
                <Text variant="caption" style={{ color: palette.danger }}>{error}</Text>
            ) : null}

            <View style={[styles.promise, { backgroundColor: palette.primaryLight }]}>
                <Ionicons name="lock-closed-outline" size={16} color={palette.primary} />
                <Text variant="caption" style={{ color: palette.primary, flex: 1 }}>{PRIVACY_PROMISE}</Text>
            </View>
        </FormSheet>
    );
}

function makeStyles(p: Palette) {
    return StyleSheet.create({
        content: { padding: spacing[5] },
        inputWrap: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[3],
            borderWidth: 1,
            borderColor: p.border,
            borderRadius: radius.md,
            paddingHorizontal: spacing[3],
            marginTop: spacing[3],
            backgroundColor: p.background,
        },
        input: {
            flex: 1,
            paddingVertical: spacing[3],
            fontSize: 16,
            color: p.textPrimary,
        },
        promise: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[2],
            borderRadius: radius.md,
            paddingHorizontal: spacing[4],
            paddingVertical: spacing[3],
            marginTop: spacing[3],
        },
    });
}
