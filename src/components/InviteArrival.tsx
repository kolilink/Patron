import { useEffect, useMemo, useRef } from 'react';
import { trackEvent } from '@/lib/analytics';
import { View, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { recordPendingInviteAttribution } from '@/stores/inviter';
import { isInviterId, setPendingInviterId } from '@/lib/inviteLink';

// ─── /invite deep-link arrival (word-of-mouth) ──────────────────────────────
//
// Link forms (both land here via app/invite/[id].tsx or app/invite.tsx):
//   https://patron.kolilink.com/invite/?i=<inviter-id>  (Universal/App Link — the shared form)
//   https://patron.kolilink.com/invite/<inviter-id>     (older shared links)
//   patron://invite/<inviter-id>                       (custom scheme)
//
// The id is persisted and attributed silently, then the user goes through the
// normal install/onboarding flow. No inviter UI, no redemption, never a dead
// end: every path falls through to a usable screen.

export function InviteArrival({ inviterId }: { inviterId: string }) {
    const { palette } = useTheme();
    const styles = useMemo(() => makeStyles(palette), [palette]);
    const ranRef = useRef(false);

    useEffect(() => {
        if (ranRef.current) return;
        ranRef.current = true;

        (async () => {
            const session = useAuthStore.getState().session;
            const activeBusiness = session?.activeBusiness;
            const id = isInviterId(inviterId) ? inviterId.trim().toLowerCase() : null;

            if (id) {
                trackEvent('invite_opened', null, null, { source: 'deep_link', has_session: !!session });
                await setPendingInviterId(id);
                // Silent attribution: only possible once signed in. Otherwise the
                // pending id waits for onboarding (see (app)/_layout.tsx).
                if (session && activeBusiness) await recordPendingInviteAttribution();
            }

            // Normal install/onboarding flow, wherever the session dictates.
            router.replace(session ? (activeBusiness ? '/(app)/(tabs)/' : '/(welcome)/creer') : '/(welcome)/');
        })();
    }, [inviterId]);

    return (
        <View style={styles.center}>
            <Text variant="body" color="secondary">Chargement…</Text>
        </View>
    );
}

function makeStyles(p: Palette) {
    return StyleSheet.create({
        center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing[8] },
    });
}
