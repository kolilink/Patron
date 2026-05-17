// ─── Roles ───────────────────────────────────────────────────────────────────

export type Role = 'administrateur' | 'manager' | 'vendeur' | 'investisseur';

export type PaymentMethod = 'especes' | 'wave' | 'orange' | 'mtn' | 'moov' | 'credit' | 'digital';

export type StockMoveType = 'entree' | 'sortie' | 'perte' | 'retour';

export type OrderStatus = 'brouillon' | 'confirme' | 'annule' | 'paye' | 'credit';

export type POStatus = 'brouillon' | 'envoye' | 'recu_partiel' | 'recu' | 'annule';

export type ProposalStatus = 'en_attente' | 'approuve' | 'rejete' | 'clarification';

export type SubscriptionTier = 'gratuit' | 'starter' | 'business' | 'pro';

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
  created_at: string;
  updated_at: string;
}

// ─── Business ─────────────────────────────────────────────────────────────────

export interface Business {
  id: string;
  name: string;
  type: string | null;
  currency: string;
  logo_url: string | null;
  status: 'actif' | 'suspendu' | 'archive';
  subscription_tier: SubscriptionTier;
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
  pin_hash: string | null;
  joined_at: string;
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
  supplier_id: string | null;
  purchase_date: string | null;
  bulk_price: number | null;
  bulk_min_qty: number | null;
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
  product?: Product;
}

// ─── Sale Order ───────────────────────────────────────────────────────────────

export interface SaleOrder extends Base {
  customer_name: string | null;
  seller_id: string;
  status: OrderStatus;
  paid_at: string | null;
  sale_date: string | null;
  total_amount: number;
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
  product?: Product;
}

// ─── Payment ──────────────────────────────────────────────────────────────────

export interface Payment {
  id: string;
  order_id: string;
  method: PaymentMethod;
  amount: number;
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

// ─── Auth Session ─────────────────────────────────────────────────────────────

export interface AppSession {
  user: User;
  activeBusiness: Business | null;
  activeMembership: Membership | null;
  memberships: Membership[];
}
