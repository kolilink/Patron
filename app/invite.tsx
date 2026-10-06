import { useLocalSearchParams } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { InviteArrival } from '@/src/components/InviteArrival';

// Bare /invite, or /invite?i=<inviter-id>: InviteArrival carries the id (if
// any) and sends the user through the normal flow.
export default function InviteBare() {
    const { i } = useLocalSearchParams<{ i?: string }>();
    return (
        <Screen>
            <InviteArrival inviterId={(Array.isArray(i) ? i[0] : i) ?? ''} />
        </Screen>
    );
}
