// ─── Roles ───────────────────────────────────────────────────────────────────

export type Role = 'administrateur' | 'manager' | 'vendeur' | 'investisseur';

export type PaymentMethod = 'especes' | 'orange' | 'mtn' | 'moov' | 'digital';

export type StockMoveType = 'entree' | 'sortie' | 'perte' | 'retour';

export type OrderStatus = 'brouillon' | 'confirme' | 'annule' | 'paye' | 'credit';

export type POStatus = 'brouillon' | 'envoye' | 'recu_partiel' | 'recu' | 'annule';

export type ProposalStatus = 'en_attente' | 'approuve' | 'rejete' | 'clarification';

export type SubscriptionTier = 'gratuit' | 'starter' | 'business' | 'pro';

export type SubscriptionStatus = 'trialing' | 'active' | 'cancelled' | 'expired';

export type PaymentProvider = 'stripe' | 'apple' | 'google' | 'promotional';

export type ExpenseStatus = 'en_attente' | 'approuve' | 'rejete';

// ─── Base ─────────────────────────────────────────────────────────────────────

interface Base {
  id: string;
  business_id: string;
  created_at: string;
  updated_at: string;
  created_by: string;
}

// ─── User ─────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  avatar_url: string | null;
  language: string;
  recovery_email: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Business ─────────────────────────────────────────────────────────────────

export interface Business {
  id: string;
  name: string;
  type: string | null;
  currency: string;
  phone: string | null;
  logo_url: string | null;
  status: 'actif' | 'suspendu' | 'archive';
  subscription_tier: SubscriptionTier;
  subscription_status: SubscriptionStatus;
  trial_ends_at: string | null;
  stripe_customer_id: string | null;
  subscription_expires_at: string | null;
  payment_provider: PaymentProvider | null;
  revenuecat_customer_id: string | null;
  bonus_access_until: string | null;
  referred_by_business_id: string | null;
  referral_code: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
}

// ─── Membership ───────────────────────────────────────────────────────────────

export interface Membership {
  id: string;
  user_id: string;
  business_id: string;
  role: Role;
  joined_at: string;
  milestone_reached: boolean;
  user?: User;
  business?: Business;
}

// ─── Product ──────────────────────────────────────────────────────────────────

export interface Product extends Base {
  name: string;
  sku: string | null;
  category: string | null;
  unit: string;
  cost_price: number;
  sale_price: number;
  reorder_level: number;
  stock_qty: number;
  archived: boolean;
  is_system?: boolean;
  supplier_id: string | null;
  purchase_date: string | null;
  bulk_price: number | null;
  bulk_min_qty: number | null;
  has_variants: boolean;
  variants?: ProductVariant[];
}

// ─── Product Variant ──────────────────────────────────────────────────────────

export interface ProductVariant {
  id: string;
  product_id: string;
  business_id: string;
  name: string;
  sale_price: number;
  cost_price: number;
  stock_qty: number;
  reorder_level: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

// ─── Stock Move ───────────────────────────────────────────────────────────────

export interface StockMove extends Base {
  product_id: string;
  type: StockMoveType;
  qty: number;
  ref_id: string | null;
  ref_type: string | null;
  note: string | null;
  product?: Product;
}

// ─── Supplier ─────────────────────────────────────────────────────────────────

export interface Supplier extends Base {
  name: string;
  phone: string | null;
  country: string | null;
  lead_days: number | null;
  notes: string | null;
}

// ─── Purchase Order ───────────────────────────────────────────────────────────

export interface PurchaseOrder extends Base {
  supplier_id: string;
  status: POStatus;
  ordered_at: string;
  received_at: string | null;
  total_cost: number;
  supplier?: Supplier;
  lines?: POLine[];
}

export interface POLine {
  id: string;
  po_id: string;
  product_id: string;
  qty_ordered: number;
  qty_received: number;
  unit_cost: number;
  variant_id?: string | null;
  product?: Product;
  variant?: ProductVariant;
}

// ─── Sale Order ───────────────────────────────────────────────────────────────

export interface SaleOrder extends Base {
  customer_name: string | null;
  seller_id: string;
  status: OrderStatus;
  is_credit: boolean;
  paid_at: string | null;
  sale_date: string | null;
  due_date?: string | null;
  total_amount: number;
  discount_amount: number;
  cancelled_by_id?: string | null;
  lines?: SOLine[];
  payments?: Payment[];
}

export interface SOLine {
  id: string;
  order_id: string;
  product_id: string;
  qty: number;
  unit_price: number;
  is_bulk: boolean;
  variant_id?: string | null;
  variant_name?: string | null;
  product_name?: string | null;
  product?: Product;
}

// ─── Payment ──────────────────────────────────────────────────────────────────

export interface Payment {
  id: string;
  order_id: string | null;
  customer_name: string | null;
  business_id: string | null;
  method: PaymentMethod;
  amount: number;
  date: string;
  ref_external: string | null;
  created_at: string;
}

// ─── Investor ─────────────────────────────────────────────────────────────────

export interface Investor extends Base {
  user_id: string;
  amount: number;
  invested_at: string;
  note: string | null;
  equity_pct: number;
  user?: User;
}

// ─── Expense ──────────────────────────────────────────────────────────────────

export interface Expense {
  id: string;
  business_id: string;
  amount: number;
  description: string;
  category: string | null;
  date: string;
  due_date: string | null;
  note: string | null;
  status: ExpenseStatus;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  creator_name?: string;
  product_id?: string | null;
  product_name?: string | null;
  purchase_order_id?: string | null;
}

// ─── Change Proposal ──────────────────────────────────────────────────────────

export interface ChangeProposal extends Base {
  entity_type: string;
  entity_id: string;
  proposed_by: string;
  status: ProposalStatus;
  diff_json: Record<string, { before: unknown; after: unknown }>;
  reviewed_by: string | null;
  reviewed_at: string | null;
  note: string | null;
  proposer?: User;
  reviewer?: User;
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

export interface AuditLog {
  id: string;
  business_id: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  payload_json: Record<string, unknown>;
  ip: string | null;
  ts: string;
}

// ─── Dashboard KPIs ───────────────────────────────────────────────────────────

export interface DashboardKPIs {
  revenue_today: number;
  revenue_week: number;
  revenue_month: number;
  gross_margin: number;
  sales_count_today: number;
  low_stock_count: number;
  pending_proposals: number;
  pending_receivables: number;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

export interface ChatRoom {
  id: string;
  name: string;
  business_id: string | null;
  is_global: boolean;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  room_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  created_at: string;
  edited_at?: string | null;
  reply_to_id?: string | null;
  reply_to_content?: string | null;
  reply_to_sender_name?: string | null;
  // Voice messages (v90)
  message_type?: 'text' | 'voice' | 'image';
  voice_url?: string | null;
  voice_duration?: number | null;       // seconds
  voice_waveform?: number[] | null;     // amplitude samples 0.0–1.0
  // Image messages (v132)
  image_url?: string | null;
  image_width?: number | null;
  image_height?: number | null;
}

// ─── Support chat (merchant ↔ founder) ─────────────────────────────────────────

export type SupportConversationStatus = 'open' | 'closed';
export type SupportSenderRole = 'merchant' | 'founder';

export interface SupportConversation {
  id: string;
  business_id: string;
  merchant_user_id: string | null;
  merchant_name: string | null;
  status: SupportConversationStatus;
  last_message_at: string;
  last_message_preview: string | null;
  founder_last_read_at: string | null;
  merchant_last_read_at: string | null;
  rating: number | null;
  rated_at: string | null;
  created_at: string;
  updated_at: string;
  business_name?: string; // joined in for the founder inbox list only
}

export interface SupportMessage {
  id: string;
  conversation_id: string;
  business_id: string;
  sender_id: string;
  sender_role: SupportSenderRole;
  sender_name: string;
  content: string;
  used_ai_draft: boolean;
  created_at: string;
  // Image messages (v132)
  message_type?: 'text' | 'image';
  image_url?: string | null;
  image_width?: number | null;
  image_height?: number | null;
}

export interface SupportAiDraft {
  id: string;
  conversation_id: string;
  based_on_message_id: string | null;
  draft_content: string | null;
  status: 'pending' | 'ready' | 'failed';
  error_note: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Alpha (AI business advisor) ────────────────────────────────────────────

export interface AlphaConversation {
  id: string;
  business_id: string;
  user_id: string;
  last_message_at: string;
  created_at: string;
  updated_at: string;
}

export interface AlphaMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'ready' | 'failed';
  error_note: string | null;
  model: string | null;
  created_at: string;
}

export interface AlphaQuotaStatus {
  has_ai_access: boolean;
  limit: number;
  remaining: number;
  next_reset_at: string | null;
  in_welcome_burst: boolean;
  burst_messages_remaining: number;
}

// ─── Forum (Le Marché) ────────────────────────────────────────────────────────

export type MarketCategory = 'suggestion' | 'entraide' | 'general';

export interface MarketPost {
  id: string;
  author_id: string;
  author_name: string;
  title: string;
  content: string;
  category: MarketCategory;
  likes_count: number;
  comments_count: number;
  created_at: string;
  updated_at: string;
  edited_at?: string | null;
}

export interface MarketComment {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  author_name: string;
  content: string;
  likes_count: number;
  created_at: string;
  edited_at?: string | null;
  author_level?: number;
}

// ─── Member Product Scope ─────────────────────────────────────────────────────

export interface MemberProductStake {
  id: string;
  membership_id: string;
  product_id: string;
  product_name: string;
  contribution: number;  // GNF units (already divided by 100)
  profit_share: number;  // 0–100
}

// ─── Auth Session ─────────────────────────────────────────────────────────────

export interface AppSession {
  user: User;
  activeBusiness: Business | null;
  activeMembership: Membership | null;
  memberships: Membership[];
  isDemoMode?: boolean;
}

// ─── Business Partnerships (Amis) ─────────────────────────────────────────────

export type PartnershipStatus = 'pending' | 'accepted' | 'declined' | 'blocked';

export interface BusinessPartnership {
  id: string;
  requester_id: string;
  recipient_id: string;
  status: PartnershipStatus;
  requester_shares_stock: boolean;
  recipient_shares_stock: boolean;
  requester_nickname: string | null;
  recipient_nickname: string | null;
  created_at: string;
  updated_at: string;
}

export interface PartnerData {
  partnership_id: string;
  partner_business_id: string;
  partner_business_name: string;
  display_name: string; // custom nickname ?? business name
  is_requester: boolean;
  i_share_stock: boolean;   // whether I allow them to see my stock
  they_share_stock: boolean; // whether they allow me to see their stock
  dm_room_id: string | null;
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
}

export interface PendingRequest {
  id: string;
  requester_business_id: string;
  requester_business_name: string;
  created_at: string;
}

export interface PartnerProduct {
  name: string;
  category: string | null;
  stock_qty: number;
  in_stock: boolean;
  unit: string;
}

export interface PartnerStockResult {
  business_name: string;
  products: PartnerProduct[] | null;
}

export interface PartnerInviteCode {
  code: string;
  expires_at: string; // ISO string — 24h from creation
}
