// Pure push composition — extracted from index.ts so the exact title / body /
// route / data a device receives can be unit- and integration-tested without
// a Deno runtime. index.ts calls composePush(); nothing else builds a push.
import { EVENT_REGISTRY, sanitizeDataPayload } from './registry.ts';

// ─── Titles ───────────────────────────────────────────────────────────────
// Every event's title is the business name, EXCEPT chat_message, where the
// sender name IS the point (named exception to the lock-screen rule).
export const EVENT_TITLES: Record<string, string> = {
  sale_completed: '✅ Vente enregistrée',
  sale_cancelled: '⚠️ Vente annulée',
  sale_edited: '✏️ Vente modifiée',
  low_stock: '📦 Stock bas', // product name is appended, e.g. "📦 Stock bas : Riz"
  partnership_request: '🤝 Demande de partenariat',
  partnership_accepted: '🤝 Partenariat accepté',
  partnership_declined: '🤝 Demande refusée',
  consumer_invite_accepted: '🎉 Un ami t\'a rejoint',
  support_message: '💬 Nouveau message',
  support_reply: '💬 Réponse du support',
  founder_new_user: 'New user',
  alpha_quota_reset: '✨ Alpha',
  daily_digest: '🌙 Votre journée',
  activation_nudge_1: '💰 Un client vous doit de l\'argent ?',
  activation_nudge_2: '⏰ Une minute suffit',
  // second_action_reminder's title is contextual (product/debt/sale) — see
  // SECOND_ACTION_TITLES and buildTitle below, not this fixed map.
  revenue_milestone: '🎉 Nouveau cap franchi',
  debt_aging_reminder: '💰 Crédits à relancer',
};

const SECOND_ACTION_TITLES: Record<string, string> = {
  product: '📦 Premier produit ajouté',
  debt: '💰 Première dette notée',
  sale: '✅ Première vente notée',
};

export function buildTitle(eventType: string, bizName: string, p: Record<string, unknown>): string {
  if (eventType === 'chat_message') return String(p.sender ?? bizName);
  if (eventType === 'low_stock') {
    const label = p.variant ? `${p.product ?? ''} · ${p.variant}` : (p.product ?? '');
    return `📦 Stock bas : ${label}`;
  }
  if (eventType === 'second_action_reminder') {
    return SECOND_ACTION_TITLES[String(p.action_type)] ?? '✅ Première action notée';
  }
  return EVENT_TITLES[eventType] ?? bizName;
}

export interface ComposedPush {
  title: string;
  subtitle: string | null;
  body: string;
  route: string;
  data: Record<string, unknown>;
}

export function composePush(
  eventType: string,
  bizName: string,
  payload: Record<string, unknown>,
  businessId: string,
): ComposedPush {
  const def = EVENT_REGISTRY[eventType];
  const route = def.route(payload);
  return {
    title: buildTitle(eventType, bizName, payload),
    subtitle: def.subtitle,
    body: def.body(payload),
    route,
    data: { route, event_type: eventType, business_id: businessId, ...sanitizeDataPayload(eventType, payload) },
  };
}
