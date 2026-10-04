import { useEffect, useMemo, useRef } from 'react';
import { trackEvent } from '@/lib/analytics';
import { View, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useInviterStore } from '@/stores/inviter';
import { toast } from '@/stores/toast';
import { setPendingInviteToken, clearPendingInviteToken } from '@/lib/inviteLink';

// ─── /invite deep-link entry (Phase 2 + Phase 5) ────────────────────────────
//
// Both link forms land here:
//   patron://invite?t=<token>                (custom scheme)
//   https://patron.kolilink.com/invite?t=<token>  (Universal/App Link)
//
// The token travels through onboarding *unread* when the user isn't
// authenticated yet: persist it, then hand off to the right screen. When the
// user IS authenticated we redeem immediately — idempotent for a re-fired
// deep link on the same device (resolve_consumer_invite returns success for
// an already-consumed invite owned by this user).
//
// Never a dead end: every path falls through to a usable screen.

export default function InviteRoute() {
    const { palette } = useTheme();
    const styles = useMemo(() => makeStyles(palette), [palette]);
    const { t } = useLocalSearchParams<{ t?: string }>();
    const token = (Array.isArray(t) ? t[0] : t)?.trim() ?? '';
    const ranRef = useRef(false);

    useEffect(() => {
        if (ranRef.current) return;
        ranRef.current = true;

        (async () => {
            const session = useAuthStore.getState().session;
            const activeBusiness = session?.activeBusiness;

            // Fully signed in with a business → redeem now and land in Amis.
            if (session && activeBusiness && token) {
                const resolved = await useInviterStore.getState().resolveInvite(token, '');
                if (resolved) {
                    await clearPendingInviteToken();
                    router.replace('/(app)/discussions?tab=amis');
                    return;
                }
                // Invalid/expired/revoked → name the failure instead of landing
                // silently on Home. A network failure (timeout) is told apart so
                // we never mislabel a blip as a bad link.
                const err = useInviterStore.getState().error;
                const networkErr = err === 'Erreur de réseau. Vérifiez votre connexion.';
                toast.warning(networkErr ? 'Problème de connexion, réessayez.' : "Lien d'invitation invalide ou expiré.");
                await clearPendingInviteToken();
                router.replace('/(app)/(tabs)/');
                return;
            }

            // No token → nothing to carry; go where the session dictates.
            if (!token) {
                router.replace(session ? (activeBusiness ? '/(app)/(tabs)/' : '/(welcome)/creer') : '/(welcome)/');
                return;
            }

            trackEvent('invite_opened', null, null, { source: 'deep_link', has_session: !!session });
            // Persist for the post-OTP onboarding (creer.tsx) to consume.
            await setPendingInviteToken(token);

            if (session) {
                router.replace(activeBusiness ? '/(app)/(tabs)/' : '/(welcome)/creer');
            } else {
                router.replace('/(welcome)/');
            }
        })();
    }, [token]);

    return (
        <Screen style={styles.screen}>
            <View style={styles.center}>
                <Text variant="body" color="secondary">Chargement…</Text>
            </View>
        </Screen>
    );
}

function makeStyles(p: Palette) {
    return StyleSheet.create({
        screen: { flex: 1, backgroundColor: p.background },
        center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing[8] },
    });
}
