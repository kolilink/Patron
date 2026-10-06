// Founder prospecting log — the pure bits (channel list, payload shape).
// The write goes through log_founder_outreach() (db/migration_v238.sql);
// the SQL CHECK on founder_outreach_log.channel and this list must agree,
// which __tests__/founder-outreach.test.ts pins against the migration text.

export const OUTREACH_CHANNELS = [
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'appel',    label: 'Appel' },
  { key: 'sms',      label: 'SMS' },
  { key: 'visite',   label: 'Visite' },
  { key: 'autre',    label: 'Autre' },
] as const;

export type OutreachChannel = typeof OUTREACH_CHANNELS[number]['key'];

export interface OutreachInput {
  channel: OutreachChannel;
  name: string;
  note: string;
}

/** RPC params for log_founder_outreach: blanks become null, text is trimmed. */
export function outreachParams(i: OutreachInput): { p_channel: OutreachChannel; p_contact_name: string | null; p_note: string | null } {
  return {
    p_channel: i.channel,
    p_contact_name: i.name.trim() || null,
    p_note: i.note.trim() || null,
  };
}
