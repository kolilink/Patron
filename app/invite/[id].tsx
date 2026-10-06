import { useLocalSearchParams } from 'expo-router';
import { Screen } from '@/src/components/ui/Screen';
import { InviteArrival } from '@/src/components/InviteArrival';

// patron.kolilink.com/invite/<inviter-id> — see InviteArrival.
export default function InviteWithId() {
    const { id } = useLocalSearchParams<{ id?: string }>();
    return (
        <Screen>
            <InviteArrival inviterId={(Array.isArray(id) ? id[0] : id) ?? ''} />
        </Screen>
    );
}
