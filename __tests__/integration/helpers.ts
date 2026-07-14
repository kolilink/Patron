import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

// Local `supabase start` dev stack — fixed well-known demo keys, not secrets.
// Override via env if a developer's local config.toml diverges from defaults.
const LOCAL_URL = process.env.TEST_SUPABASE_URL || 'http://127.0.0.1:54321';
// Printed by `supabase start` — fixed local-dev defaults, not secrets. Newer
// supabase-cli issues sb_publishable_/sb_secret_ keys instead of the old
// anon/service_role JWTs; override via env if a project's config.toml pins
// different values.
const LOCAL_ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY
  || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const LOCAL_SERVICE_KEY = process.env.TEST_SUPABASE_SERVICE_KEY
  || 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';

export function adminClient(): SupabaseClient {
  return createClient(LOCAL_URL, LOCAL_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Creates a real (test) auth user + signs in, mirroring how the app itself authenticates. */
export async function createTestUser(prefix: string): Promise<{ client: SupabaseClient; userId: string }> {
  const email = `${prefix}-${randomUUID()}@test.local`;
  const password = 'Test1234!';

  const admin = adminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('createUser returned no user');

  const client = createClient(LOCAL_URL, LOCAL_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;

  return { client, userId: data.user.id };
}

/** Creates a business with the given user as administrateur. */
export async function createTestBusiness(client: SupabaseClient, name: string): Promise<string> {
  const id = randomUUID();
  const { error } = await client.rpc('create_business_with_membership', {
    p_id: id,
    p_name: name,
    p_type: 'commerce',
    p_currency: 'GNF',
    p_phone: null,
  });
  if (error) throw error;
  return id;
}

/** Invites `client`'s user into `businessId` with `role`, using the admin service key to bypass RLS for setup. */
export async function addMember(businessId: string, userId: string, role: 'manager' | 'vendeur' | 'investisseur'): Promise<void> {
  const admin = adminClient();
  const { error } = await admin.from('memberships').insert({
    business_id: businessId,
    user_id: userId,
    role,
  });
  if (error) throw error;
}

/** Inserts a product directly (service role bypasses the admin/manager-only RLS write gate). */
export async function createTestProduct(businessId: string, createdBy: string, overrides: Partial<{
  name: string; stock_qty: number; cost_price: number; sale_price: number;
}> = {}): Promise<string> {
  const admin = adminClient();
  const id = randomUUID();
  const { error } = await admin.from('products').insert({
    id,
    business_id: businessId,
    name: overrides.name ?? 'Produit test',
    unit: 'unite',
    stock_qty: overrides.stock_qty ?? 100,
    cost_price: overrides.cost_price ?? 500,
    sale_price: overrides.sale_price ?? 1000,
    reorder_level: 0,
    created_by: createdBy,
  });
  if (error) throw error;
  return id;
}

export async function createInviteCode(businessId: string, createdBy: string, overrides: Partial<{
  role: string; expires_at: string | null; max_uses: number | null; uses: number;
}> = {}): Promise<string> {
  const admin = adminClient();
  const code = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const { error } = await admin.from('invite_codes').insert({
    business_id: businessId,
    code,
    role: overrides.role ?? 'vendeur',
    created_by: createdBy,
    expires_at: overrides.expires_at === undefined ? null : overrides.expires_at,
    max_uses: overrides.max_uses === undefined ? 10 : overrides.max_uses,
    uses: overrides.uses ?? 0,
  });
  if (error) throw error;
  return code;
}

export async function getProductStock(productId: string): Promise<number> {
  const admin = adminClient();
  const { data, error } = await admin.from('products').select('stock_qty').eq('id', productId).single();
  if (error) throw error;
  return data.stock_qty;
}

/** Creates a variant on an existing (has_variants) parent product. */
export async function createTestVariant(productId: string, businessId: string, overrides: Partial<{
  name: string; stock_qty: number; cost_price: number; sale_price: number;
}> = {}): Promise<string> {
  const admin = adminClient();
  const id = randomUUID();
  const { error } = await admin.from('product_variants').insert({
    id,
    product_id: productId,
    business_id: businessId,
    name: overrides.name ?? 'Taille M',
    stock_qty: overrides.stock_qty ?? 50,
    cost_price: overrides.cost_price ?? 500,
    sale_price: overrides.sale_price ?? 1000,
    reorder_level: 0,
  });
  if (error) throw error;
  await admin.from('products').update({ has_variants: true, stock_qty: 0 }).eq('id', productId);
  return id;
}
