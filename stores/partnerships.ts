import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { getKV, setKV, savePartnershipsCache, getPartnershipsCache, getCacheTimestamp } from '@/lib/db';
import { isNetworkError } from '@/lib/sync';
import { notifyEvent } from '@/src/utils/notifications';
import type { PartnerData, PendingRequest, PartnerInviteCode } from '@/src/types';

function dmReadKey(roomId: string) { return `dm_last_read_${roomId}`; }

interface PartnershipsStore {
  partners: PartnerData[];
  pending: PendingRequest[];
  loading: boolean;
  error: string | null;
  inviteCode: PartnerInviteCode | null;
  inviteCodeLoading: boolean;
  offline: boolean;
  offlineSince: number | null;

  loadPartnerships: (businessId: string, userId: string) => Promise<void>;
  loadInviteCode: (businessId: string) => Promise<void>;
  regenerateInviteCode: (businessId: string) => Promise<void>;
  sendPartnerRequest: (
    inviteCode: string,
    myBusinessId: string,
    myBusinessName: string,
  ) => Promise<string>; // returns partner business name for confirmation
  acceptRequest: (
    partnershipId: string,
    myBusinessId: string,
    myBusinessName: string,
    requesterBusinessId: string,
  ) => Promise<void>;
  declineRequest: (partnershipId: string, myBusinessId: string) => Promise<void>;
  updatePartnerSettings: (
    partnershipId: string,
    myBusinessId: string,
    nickname: string | null,
    shareStock: boolean,
  ) => Promise<void>;
  removePartner: (partnershipId: string, myBusinessId: string) => Promise<void>;
  getOrCreateDmRoom: (partnershipId: string, myBusinessId: string) => Promise<string>;
  markDmRead: (roomId: string, partnershipId: string) => Promise<void>;
  reset: () => void;
}

const initialState = {
  partners: [] as PartnerData[],
  pending: [] as PendingRequest[],
  loading: false,
  error: null as string | null,
  inviteCode: null as PartnerInviteCode | null,
  inviteCodeLoading: false,
  offline: false,
  offlineSince: null as number | null,
};

export const usePartnershipsStore = create<PartnershipsStore>((set, get) => ({
  ...initialState,

  loadPartnerships: async (businessId, userId) => {
    set({ loading: true, error: null });
    try {
      // 1. Fetch partnerships with embedded business names
      const { data: rows, error: pErr } = await supabase
        .from('business_partnerships')
        .select(`
          *,
          requester:requester_id(id, name),
          recipient:recipient_id(id, name)
        `)
        .or(`requester_id.eq.${businessId},recipient_id.eq.${businessId}`)
        .in('status', ['pending', 'accepted'])
        .order('created_at', { ascending: false });
      if (pErr) throw pErr;

      const all = rows ?? [];

      // 2. Pending = rows where I'm the recipient and it's still pending
      const pending: PendingRequest[] = all
        .filter(r => r.status === 'pending' && r.recipient_id === businessId)
        .map(r => ({
          id: r.id,
          requester_business_id: r.requester_id,
          requester_business_name: (r.requester as { name: string } | null)?.name ?? 'Boutique',
          created_at: r.created_at,
        }));

      // 3. Accepted partnerships
      const accepted = all.filter(r => r.status === 'accepted');
      const partnershipIds = accepted.map(r => r.id);

      // 4. Fetch DM rooms for accepted partnerships
      let dmRooms: Array<{ id: string; partnership_id: string }> = [];
      if (partnershipIds.length > 0) {
        const { data: rooms } = await supabase
          .from('chat_rooms')
          .select('id, partnership_id')
          .in('partnership_id', partnershipIds);
        dmRooms = (rooms ?? []) as Array<{ id: string; partnership_id: string }>;
      }

      // 5. Fetch the latest message per DM room (for preview + unread)
      const dmRoomIds = dmRooms.map(r => r.id);
      const latestByRoom: Record<string, { content: string; created_at: string; sender_id: string }> = {};
      if (dmRoomIds.length > 0) {
        const { data: msgs } = await supabase
          .from('chat_messages')
          .select('room_id, content, created_at, sender_id')
          .in('room_id', dmRoomIds)
          .order('created_at', { ascending: false })
          .limit(dmRoomIds.length * 10);
        for (const msg of msgs ?? []) {
          if (!latestByRoom[msg.room_id]) latestByRoom[msg.room_id] = msg;
        }
      }

      // 6. Load per-room last-read timestamps from KV
      const lastReadByRoom: Record<string, Date> = {};
      for (const roomId of dmRoomIds) {
        const ts = await getKV(dmReadKey(roomId));
        lastReadByRoom[roomId] = ts ? new Date(ts) : new Date(0);
      }

      // 7. Build PartnerData[]
      const partners: PartnerData[] = accepted.map(r => {
        const isRequester = r.requester_id === businessId;
        const partnerBizId = isRequester ? r.recipient_id : r.requester_id;
        const partnerBizName = isRequester
          ? ((r.recipient as { name: string } | null)?.name ?? 'Boutique')
          : ((r.requester as { name: string } | null)?.name ?? 'Boutique');
        const myNickname = isRequester ? r.requester_nickname : r.recipient_nickname;
        const myShareStock = isRequester ? r.requester_shares_stock : r.recipient_shares_stock;
        const theyShareStock = isRequester ? r.recipient_shares_stock : r.requester_shares_stock;

        const dmRoom = dmRooms.find(dr => dr.partnership_id === r.id) ?? null;
        const latestMsg = dmRoom ? latestByRoom[dmRoom.id] : null;
        const lastRead = dmRoom ? (lastReadByRoom[dmRoom.id] ?? new Date(0)) : new Date(0);
        const unreadCount = (latestMsg && latestMsg.sender_id !== userId
          && new Date(latestMsg.created_at) > lastRead) ? 1 : 0;

        return {
          partnership_id: r.id,
          partner_business_id: partnerBizId,
          partner_business_name: partnerBizName,
          display_name: (myNickname ?? partnerBizName) as string,
          is_requester: isRequester,
          i_share_stock: myShareStock as boolean,
          they_share_stock: theyShareStock as boolean,
          dm_room_id: dmRoom?.id ?? null,
          last_message: latestMsg?.content ?? null,
          last_message_at: latestMsg?.created_at ?? null,
          unread_count: unreadCount,
        };
      });

      void savePartnershipsCache(businessId, { partners, pending });
      set({ partners, pending, loading: false, offline: false, offlineSince: null });
    } catch (err) {
      if (isNetworkError(err)) {
        const cached = await getPartnershipsCache(businessId) as { partners: PartnerData[]; pending: PendingRequest[] } | null;
        if (cached) {
          const ts = await getCacheTimestamp('partnerships_cache', businessId);
          set({ partners: cached.partners, pending: cached.pending, loading: false, offline: true, offlineSince: ts });
          return;
        }
      }
      set({ loading: false, error: translateError(err, 'Impossible de charger vos amis') });
    }
  },

  loadInviteCode: async (businessId) => {
    set({ inviteCodeLoading: true });
    try {
      const { data, error } = await supabase.rpc('get_or_create_invite_code', {
        p_business_id: businessId,
      });
      if (error) throw error;
      // The RPC returns the code string; we don't get expires_at back directly.
      // Approximate expires_at as 24h from now (server-side it may differ slightly).
      // For display purposes this is accurate enough.
      const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      set({ inviteCode: { code: data as string, expires_at }, inviteCodeLoading: false });
    } catch {
      set({ inviteCodeLoading: false });
    }
  },

  regenerateInviteCode: async (businessId) => {
    set({ inviteCodeLoading: true });
    try {
      const { data, error } = await supabase.rpc('regenerate_invite_code', {
        p_business_id: businessId,
      });
      if (error) throw error;
      const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      set({ inviteCode: { code: data as string, expires_at }, inviteCodeLoading: false });
    } catch {
      set({ inviteCodeLoading: false });
    }
  },

  sendPartnerRequest: async (inviteCode, myBusinessId, myBusinessName) => {
    const { data, error } = await supabase.rpc('send_partnership_request', {
      p_invite_code: inviteCode.trim(),
      p_my_business_id: myBusinessId,
    });
    if (error) throw error;

    // Look up partnership to get partner's business info for notification + name
    const { data: partnership } = await supabase
      .from('business_partnerships')
      .select('recipient_id, recipient:recipient_id(name)')
      .eq('id', data as string)
      .single();

    const partnerName = (partnership as { recipient: { name: string } | null } | null)?.recipient?.name ?? 'Boutique';

    if (partnership) {
      notifyEvent({
        businessId: (partnership as { recipient_id: string }).recipient_id,
        eventType: 'partnership_request',
        payload: {
          sender_name: myBusinessName,
          preview: `${myBusinessName} vous a envoyé une demande d'ami`,
        },
        targetRoles: ['administrateur', 'manager'],
      });
    }

    return partnerName;
  },

  acceptRequest: async (partnershipId, myBusinessId, myBusinessName, requesterBusinessId) => {
    const { error } = await supabase.rpc('accept_partnership_request', {
      p_partnership_id: partnershipId,
      p_my_business_id: myBusinessId,
    });
    if (error) throw error;

    // Remove from pending, trigger reload
    set(state => ({
      pending: state.pending.filter(p => p.id !== partnershipId),
    }));

    // Notify the requester
    notifyEvent({
      businessId: requesterBusinessId,
      eventType: 'partnership_accepted',
      payload: {
        acceptor_name: myBusinessName,
        preview: `${myBusinessName} a accepté votre demande d'ami`,
      },
      targetRoles: ['administrateur', 'manager'],
    });
  },

  declineRequest: async (partnershipId, myBusinessId) => {
    const { error } = await supabase.rpc('decline_partnership_request', {
      p_partnership_id: partnershipId,
      p_my_business_id: myBusinessId,
    });
    if (error) throw error;
    set(state => ({
      pending: state.pending.filter(p => p.id !== partnershipId),
    }));
  },

  updatePartnerSettings: async (partnershipId, myBusinessId, nickname, shareStock) => {
    const { error } = await supabase.rpc('update_partner_settings', {
      p_partnership_id: partnershipId,
      p_my_business_id: myBusinessId,
      p_nickname: nickname,
      p_share_stock: shareStock,
    });
    if (error) throw error;
    set(state => ({
      partners: state.partners.map(p =>
        p.partnership_id === partnershipId
          ? {
              ...p,
              display_name: nickname ?? p.partner_business_name,
              i_share_stock: shareStock,
            }
          : p,
      ),
    }));
  },

  removePartner: async (partnershipId, myBusinessId) => {
    const { error } = await supabase.rpc('remove_partnership', {
      p_partnership_id: partnershipId,
      p_my_business_id: myBusinessId,
    });
    if (error) throw error;
    set(state => ({
      partners: state.partners.filter(p => p.partnership_id !== partnershipId),
    }));
  },

  getOrCreateDmRoom: async (partnershipId, myBusinessId) => {
    const { data: roomId, error } = await supabase.rpc('get_or_create_dm_room', {
      p_partnership_id: partnershipId,
      p_my_business_id: myBusinessId,
    });
    if (error) throw error;

    // Update the partner's dm_room_id in local state
    set(state => ({
      partners: state.partners.map(p =>
        p.partnership_id === partnershipId
          ? { ...p, dm_room_id: roomId as string }
          : p,
      ),
    }));

    return roomId as string;
  },

  markDmRead: async (roomId, partnershipId) => {
    const now = new Date();
    await setKV(dmReadKey(roomId), now.toISOString());
    set(state => ({
      partners: state.partners.map(p =>
        p.partnership_id === partnershipId
          ? { ...p, unread_count: 0 }
          : p,
      ),
    }));
  },

  reset: () => set(initialState),
}));
