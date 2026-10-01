-- ============================================================
-- Patron — Migration v210
-- Run in Supabase SQL Editor AFTER migration_v209
--
-- "Alpha derrière une vitre" (pre-launch checklist §6) — the glass wall.
-- Turns Alpha from an open-ended, tool-calling model into a deterministic
-- intent router with exactly 5 read-only "skills", each backed by ONE
-- SECURITY DEFINER RPC that (a) checks is_member first, (b) derives the
-- caller's role server-side, and (c) filters every query by
-- business_id = p_business_id AND the role — so no multi-business data can
-- ever reach the model's prompt.
--
-- Each skill returns the SAME envelope shape:
--   { intention, autorise, raison, valeur, periode:{debut,fin},
--     provenance, chemin_details:{ecran,filtre}, version_donnees }
-- The edge function (supabase/functions/alpha-chat/) injects ONLY this
-- envelope (plus system instructions) into the prompt — it never streams raw
-- table rows, never lets the model choose a data source, and never exposes
-- write operations (there are none: the function has no tools).
--
-- All monetary values are BIGINT cents (×100, migration_v24). The edge
-- function converts to display units before the model ever sees them.
--
-- Also ships the Phase 6 DB surface:
--   * alpha_daily_usage + alpha_daily_cap (default 30) — a hard daily cost
--     ceiling layered ON TOP of the existing tier quota (free 5 / paid 100),
--     so even a paid account can never exceed 30 model calls per 24h window.
--     Effective ceiling = min(tier limit, daily cap); the daily cap counts
--     every message including the welcome burst.
--   * alpha_audit_trail (append-only, service-role only) — one row per
--     interaction (question, intention, params, data_hash, response, model,
--     token counts, cost).
--   * detect_alpha_anomaly() — flags a user whose daily call volume exceeds
--     3× their rolling 7-day baseline.
--   * alpha_messages new columns (intention, params, details_path, data_hash,
--     cost, prompt/completion tokens).
--   * business_data_versions + bump trigger — a per-business revision counter
--     incremented on EVERY write to sale_orders/so_lines/payments/stock_moves/
--     products/product_variants/clients/businesses, so cache keys can be
--     invalidated the moment the underlying data changes.
--
-- Safe to re-run: IF NOT EXISTS / CREATE OR REPLACE throughout.
-- ============================================================

-- ═══════════════════════════════════════════════════════════════
-- 1. Data-version counter (cache invalidation key, Phase 6)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS business_data_versions (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  version     bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE business_data_versions ENABLE ROW LEVEL SECURITY;
-- No client policies: read only through get_business_data_version() below,
-- write only through the trigger. Kept out of raw PostgREST reach.

CREATE OR REPLACE FUNCTION get_business_data_version(p_business_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE((
    SELECT version FROM business_data_versions WHERE business_id = p_business_id
  ), 0);
END;
$$;

GRANT EXECUTE ON FUNCTION get_business_data_version(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_business_data_version(uuid) TO service_role;

-- Bumps the per-business revision on any write to the 8 tables the 5 skills
-- read from. so_lines has no business_id column — it resolves through
-- sale_orders.order_id. payments has business_id since migration_v5, but it
-- was never backfilled/not-null for pre-v5 rows, so fall back to the parent
-- sale order when it is null.
CREATE OR REPLACE FUNCTION bump_business_data_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bid uuid;
BEGIN
  v_bid := NULL;

  IF TG_TABLE_NAME IN ('sale_orders', 'stock_moves', 'products', 'product_variants', 'clients') THEN
    v_bid := COALESCE(NEW.business_id, OLD.business_id);
  ELSIF TG_TABLE_NAME = 'payments' THEN
    v_bid := COALESCE(NEW.business_id, OLD.business_id);
    IF v_bid IS NULL THEN
      SELECT business_id INTO v_bid
      FROM sale_orders
      WHERE id = COALESCE(NEW.order_id, OLD.order_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'so_lines' THEN
    SELECT business_id INTO v_bid
    FROM sale_orders
    WHERE id = COALESCE(NEW.order_id, OLD.order_id);
  ELSIF TG_TABLE_NAME = 'businesses' THEN
    v_bid := COALESCE(NEW.id, OLD.id);
  END IF;

  IF v_bid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  INSERT INTO business_data_versions (business_id, version, updated_at)
  VALUES (v_bid, 1, now())
  ON CONFLICT (business_id)
  DO UPDATE SET version = business_data_versions.version + 1, updated_at = now();

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_version_sale_orders        ON sale_orders;
DROP TRIGGER IF EXISTS trg_bump_version_so_lines           ON so_lines;
DROP TRIGGER IF EXISTS trg_bump_version_payments           ON payments;
DROP TRIGGER IF EXISTS trg_bump_version_stock_moves        ON stock_moves;
DROP TRIGGER IF EXISTS trg_bump_version_products           ON products;
DROP TRIGGER IF EXISTS trg_bump_version_product_variants   ON product_variants;
DROP TRIGGER IF EXISTS trg_bump_version_clients            ON clients;
DROP TRIGGER IF EXISTS trg_bump_version_businesses         ON businesses;

CREATE TRIGGER trg_bump_version_sale_orders
  AFTER INSERT OR UPDATE OR DELETE ON sale_orders
  FOR EACH ROW EXECUTE FUNCTION bump_business_data_version();
CREATE TRIGGER trg_bump_version_so_lines
  AFTER INSERT OR UPDATE OR DELETE ON so_lines
  FOR EACH ROW EXECUTE FUNCTION bump_business_data_version();
CREATE TRIGGER trg_bump_version_payments
  AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION bump_business_data_version();
CREATE TRIGGER trg_bump_version_stock_moves
  AFTER INSERT OR UPDATE OR DELETE ON stock_moves
  FOR EACH ROW EXECUTE FUNCTION bump_business_data_version();
CREATE TRIGGER trg_bump_version_products
  AFTER INSERT OR UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION bump_business_data_version();
CREATE TRIGGER trg_bump_version_product_variants
  AFTER INSERT OR UPDATE OR DELETE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION bump_business_data_version();
CREATE TRIGGER trg_bump_version_clients
  AFTER INSERT OR UPDATE OR DELETE ON clients
  FOR EACH ROW EXECUTE FUNCTION bump_business_data_version();
CREATE TRIGGER trg_bump_version_businesses
  AFTER INSERT OR UPDATE OR DELETE ON businesses
  FOR EACH ROW EXECUTE FUNCTION bump_business_data_version();

-- ═══════════════════════════════════════════════════════════════
-- 2. The 5 skills (Phase 1 — the glass wall)
-- ═══════════════════════════════════════════════════════════════
-- Every function: SECURITY DEFINER, is_member checked FIRST, role derived
-- server-side, every query filtered by business_id = p_business_id AND role.
-- autorise=false is returned (not an exception) for roles that must not see
-- the data, so the router can produce the exact "Je n'ai pas cette
-- information" fallback instead of leaking an error.

-- ── 2.1 ventes_periode ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION alpha_skill_ventes_periode(
  p_business_id uuid,
  p_debut       date DEFAULT NULL,
  p_fin         date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role      text;
  v_uid       uuid;
  v_debut     date := COALESCE(p_debut, CURRENT_DATE - 30);
  v_fin       date := COALESCE(p_fin, CURRENT_DATE);
  v_revenue   bigint := 0;
  v_count     int    := 0;
  v_autorise  boolean := true;
  v_raison    text;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  v_role := get_role(p_business_id);
  v_uid  := auth.uid();

  IF v_role = 'investisseur' THEN
    v_autorise := false;
    v_raison   := 'Votre rôle ne permet pas de consulter les ventes du commerce.';
  ELSE
    SELECT
      COALESCE(SUM(so.total_amount - COALESCE(so.discount_amount, 0)), 0),
      COUNT(*)::int
    INTO v_revenue, v_count
    FROM sale_orders so
    WHERE so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= v_debut
      AND so.sale_date <= v_fin
      AND (v_role <> 'vendeur' OR so.seller_id = v_uid);
  END IF;

  RETURN jsonb_build_object(
    'intention',      'ventes_periode',
    'autorise',       v_autorise,
    'raison',         v_raison,
    'valeur',         v_revenue,
    'nombre_ventes',  v_count,
    'periode',        jsonb_build_object('debut', v_debut, 'fin', v_fin),
    'provenance',     'd''après tes ventes enregistrées',
    'chemin_details', jsonb_build_object('ecran', 'ventes', 'filtre', 'periode'),
    'version_donnees', get_business_data_version(p_business_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION alpha_skill_ventes_periode(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION alpha_skill_ventes_periode(uuid, date, date) TO service_role;

-- ── 2.2 creances (read-only) ───────────────────────────────────

CREATE OR REPLACE FUNCTION alpha_skill_creances(
  p_business_id uuid,
  p_debut       date DEFAULT NULL,
  p_fin         date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role      text;
  v_uid       uuid;
  v_rows      jsonb := '[]'::jsonb;
  v_autorise  boolean := true;
  v_raison    text;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  v_role := get_role(p_business_id);
  v_uid  := auth.uid();

  IF v_role = 'investisseur' THEN
    v_autorise := false;
    v_raison   := 'Votre rôle ne permet pas de consulter les crédits du commerce.';
  ELSE
    WITH paid_per_order AS (
      SELECT p.order_id, SUM(p.amount) AS total_paid
      FROM payments p
      JOIN sale_orders so ON so.id = p.order_id
      WHERE so.business_id = p_business_id AND so.status = 'credit'
      GROUP BY p.order_id
    ),
    receivables AS (
      SELECT
        so.id                                             AS vente_id,
        COALESCE(cl.name, so.customer_name, 'Client')     AS client,
        GREATEST(0,
          so.total_amount - COALESCE(so.discount_amount, 0)
          - COALESCE(ppo.total_paid, 0)
        )                                                 AS balance,
        so.due_date                                       AS due_date,
        (so.due_date IS NOT NULL AND so.due_date < CURRENT_DATE) AS en_retard
      FROM sale_orders so
      LEFT JOIN paid_per_order ppo ON ppo.order_id = so.id
      LEFT JOIN clients cl ON cl.id = so.client_id
      WHERE so.business_id = p_business_id
        AND so.status = 'credit'
        AND (v_role <> 'vendeur' OR so.seller_id = v_uid)
    )
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'vente_id',   r.vente_id,
        'client',     r.client,
        'montant_du', r.balance,
        'due_date',   r.due_date,
        'en_retard',  r.en_retard
      )
      ORDER BY r.balance DESC
    ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT * FROM receivables
      WHERE balance > 0
      ORDER BY balance DESC
      LIMIT 10
    ) r;
  END IF;

  RETURN jsonb_build_object(
    'intention',      'creances',
    'autorise',       v_autorise,
    'raison',         v_raison,
    'valeur',         v_rows,
    'periode',        jsonb_build_object('debut', p_debut, 'fin', p_fin),
    'provenance',     'd''après tes ventes à crédit enregistrées',
    'chemin_details', jsonb_build_object('ecran', 'credits', 'filtre', 'en_retard'),
    'version_donnees', get_business_data_version(p_business_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION alpha_skill_creances(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION alpha_skill_creances(uuid, date, date) TO service_role;

-- ── 2.3 stock_bas (all roles) ──────────────────────────────────

CREATE OR REPLACE FUNCTION alpha_skill_stock_bas(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(t.item ORDER BY (t.item->>'stock')::numeric ASC), '[]'::jsonb)
  INTO v_rows
  FROM (
    -- Plain products (variant parents have no real own stock)
    SELECT jsonb_build_object(
      'produit', p.name,
      'stock',   p.stock_qty,
      'seuil',   p.reorder_level
    ) AS item
    FROM products p
    WHERE p.business_id = p_business_id
      AND NOT p.archived
      AND NOT p.is_system
      AND NOT p.has_variants
      AND p.stock_qty <= p.reorder_level

    UNION ALL

    -- Variants
    SELECT jsonb_build_object(
      'produit', p.name || ' · ' || pv.name,
      'stock',   pv.stock_qty,
      'seuil',   pv.reorder_level
    ) AS item
    FROM product_variants pv
    JOIN products p ON p.id = pv.product_id
    WHERE p.business_id = p_business_id
      AND NOT p.archived
      AND NOT pv.archived
      AND pv.stock_qty <= pv.reorder_level
  ) t
  LIMIT 10;

  RETURN jsonb_build_object(
    'intention',      'stock_bas',
    'autorise',       true,
    'raison',         NULL,
    'valeur',         v_rows,
    'periode',        NULL,
    'provenance',     'd''après ton stock actuel enregistré',
    'chemin_details', jsonb_build_object('ecran', 'catalogue', 'filtre', 'stock_bas'),
    'version_donnees', get_business_data_version(p_business_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION alpha_skill_stock_bas(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION alpha_skill_stock_bas(uuid) TO service_role;

-- ── 2.4 top_produits ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION alpha_skill_top_produits(
  p_business_id uuid,
  p_debut       date DEFAULT NULL,
  p_fin         date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role      text;
  v_uid       uuid;
  v_debut     date := COALESCE(p_debut, CURRENT_DATE - 30);
  v_fin       date := COALESCE(p_fin, CURRENT_DATE);
  v_rows      jsonb := '[]'::jsonb;
  v_autorise  boolean := true;
  v_raison    text;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  v_role := get_role(p_business_id);
  v_uid  := auth.uid();

  IF v_role = 'investisseur' THEN
    v_autorise := false;
    v_raison   := 'Votre rôle ne permet pas de consulter les ventes du commerce.';
  ELSE
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'produit',         t.product_name,
        'quantite_vendue', t.total_qty,
        'revenu',          t.total_revenue
      )
      ORDER BY t.total_revenue DESC
    ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        p.name                         AS product_name,
        SUM(sl.qty)                    AS total_qty,
        SUM(sl.qty * sl.unit_price)    AS total_revenue
      FROM so_lines sl
      JOIN products p     ON p.id = sl.product_id
      JOIN sale_orders so ON so.id = sl.order_id
      WHERE so.business_id = p_business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= v_debut
        AND so.sale_date <= v_fin
        AND p.archived = false
        AND p.is_system = false
        AND (v_role <> 'vendeur' OR so.seller_id = v_uid)
      GROUP BY p.name
      ORDER BY total_revenue DESC
      LIMIT 5
    ) t;
  END IF;

  RETURN jsonb_build_object(
    'intention',      'top_produits',
    'autorise',       v_autorise,
    'raison',         v_raison,
    'valeur',         v_rows,
    'periode',        jsonb_build_object('debut', v_debut, 'fin', v_fin),
    'provenance',     'd''après tes ventes enregistrées',
    'chemin_details', jsonb_build_object('ecran', 'rapports', 'filtre', 'top_produits'),
    'version_donnees', get_business_data_version(p_business_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION alpha_skill_top_produits(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION alpha_skill_top_produits(uuid, date, date) TO service_role;

-- ── 2.5 top_clients (no margin figures — launch scope) ─────────

CREATE OR REPLACE FUNCTION alpha_skill_top_clients(
  p_business_id uuid,
  p_debut       date DEFAULT NULL,
  p_fin         date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role      text;
  v_uid       uuid;
  v_debut     date := COALESCE(p_debut, CURRENT_DATE - 30);
  v_fin       date := COALESCE(p_fin, CURRENT_DATE);
  v_rows      jsonb := '[]'::jsonb;
  v_autorise  boolean := true;
  v_raison    text;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  v_role := get_role(p_business_id);
  v_uid  := auth.uid();

  IF v_role = 'investisseur' THEN
    v_autorise := false;
    v_raison   := 'Votre rôle ne permet pas de consulter les ventes du commerce.';
  ELSE
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'client',        t.client_name,
        'total_achats',  t.total_rev,
        'nombre_ventes', t.sale_count
      )
      ORDER BY t.total_rev DESC
    ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        COALESCE(cl.name, so.customer_name, 'Client')               AS client_name,
        SUM(so.total_amount - COALESCE(so.discount_amount, 0))      AS total_rev,
        COUNT(*)::int                                               AS sale_count
      FROM sale_orders so
      LEFT JOIN clients cl ON cl.id = so.client_id
      WHERE so.business_id = p_business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= v_debut
        AND so.sale_date <= v_fin
        AND (v_role <> 'vendeur' OR so.seller_id = v_uid)
      GROUP BY COALESCE(cl.name, so.customer_name, 'Client')
      ORDER BY total_rev DESC
      LIMIT 5
    ) t;
  END IF;

  RETURN jsonb_build_object(
    'intention',      'top_clients',
    'autorise',       v_autorise,
    'raison',         v_raison,
    'valeur',         v_rows,
    'periode',        jsonb_build_object('debut', v_debut, 'fin', v_fin),
    'provenance',     'd''après tes ventes enregistrées',
    'chemin_details', jsonb_build_object('ecran', 'clients', 'filtre', 'top_clients'),
    'version_donnees', get_business_data_version(p_business_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION alpha_skill_top_clients(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION alpha_skill_top_clients(uuid, date, date) TO service_role;

-- ═══════════════════════════════════════════════════════════════
-- 3. Phase 6 — daily hard cap (cost control) layered on tier quota
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS alpha_daily_usage (
  user_id         uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  window_start    timestamptz NOT NULL DEFAULT now(),
  count_in_window int NOT NULL DEFAULT 0
);

ALTER TABLE alpha_daily_usage ENABLE ROW LEVEL SECURITY;
-- No client policy: read/written only inside send_alpha_message /
-- get_alpha_quota_status (SECURITY DEFINER), never exposed directly.

INSERT INTO app_config (key, value) VALUES
  ('alpha_daily_cap', 30)
ON CONFLICT (key) DO NOTHING;

-- service_role only, same posture as set_alpha_daily_limit (v147).
CREATE OR REPLACE FUNCTION set_alpha_daily_cap(p_cap INT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_cap < 1 THEN
    RAISE EXCEPTION 'p_cap must be a positive number';
  END IF;

  INSERT INTO app_config (key, value, updated_at)
  VALUES ('alpha_daily_cap', p_cap, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
END;
$$;

REVOKE EXECUTE ON FUNCTION set_alpha_daily_cap(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_alpha_daily_cap(INT) TO service_role;

-- Recreate send_alpha_message: identical to v147 except the daily hard cap is
-- enforced on EVERY message (including the welcome burst) BEFORE the tier
-- quota. Effective ceiling = min(tier limit, daily cap). Existing integration
-- tests stay green: none of them send more than 16 messages, all below the
-- 30/day cap.
CREATE OR REPLACE FUNCTION send_alpha_message(p_business_id uuid, p_content text)
RETURNS alpha_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv        alpha_conversations;
  v_msg         alpha_messages;
  v_prior_count int;
  v_has_access  boolean;
  v_limit       int;
  v_daily_cap   int;
  v_quota       alpha_quota;
  v_daily       alpha_daily_usage;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;
  IF length(trim(p_content)) = 0 THEN
    RAISE EXCEPTION 'Message vide' USING ERRCODE = 'P0001';
  END IF;

  v_conv := open_or_get_alpha_conversation(p_business_id);

  SELECT count(*) INTO v_prior_count
  FROM alpha_messages
  WHERE conversation_id = v_conv.id AND role = 'user';

  -- ── Daily hard cap (Phase 6): every message counts, all tiers ──
  SELECT value INTO v_daily_cap FROM app_config WHERE key = 'alpha_daily_cap';
  IF v_daily_cap IS NULL THEN v_daily_cap := 30; END IF;

  SELECT * INTO v_daily FROM alpha_daily_usage WHERE user_id = auth.uid() FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO alpha_daily_usage (user_id, window_start, count_in_window)
    VALUES (auth.uid(), now(), 1);
  ELSIF now() - v_daily.window_start >= interval '24 hours' THEN
    UPDATE alpha_daily_usage SET window_start = now(), count_in_window = 1
    WHERE user_id = auth.uid();
  ELSIF v_daily.count_in_window < v_daily_cap THEN
    UPDATE alpha_daily_usage SET count_in_window = count_in_window + 1
    WHERE user_id = auth.uid();
  ELSE
    RAISE EXCEPTION 'Limite de questions atteinte pour l''instant. Réessayez plus tard ou passez à Alpha Illimité.' USING ERRCODE = 'P0001';
  END IF;

  -- ── Tier quota (unchanged semantics): welcome burst bypasses it ──
  IF v_prior_count >= 10 THEN
    v_has_access := has_ai_access(p_business_id);
    SELECT value INTO v_limit FROM app_config
    WHERE key = CASE WHEN v_has_access THEN 'alpha_paid_daily_limit' ELSE 'alpha_free_daily_limit' END;

    SELECT * INTO v_quota FROM alpha_quota WHERE user_id = auth.uid() FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO alpha_quota (user_id, window_start, count_in_window)
      VALUES (auth.uid(), now(), 1);
    ELSIF now() - v_quota.window_start >= interval '24 hours' THEN
      UPDATE alpha_quota SET window_start = now(), count_in_window = 1
      WHERE user_id = auth.uid();
    ELSIF v_quota.count_in_window < v_limit THEN
      UPDATE alpha_quota SET count_in_window = count_in_window + 1
      WHERE user_id = auth.uid();
    ELSE
      RAISE EXCEPTION 'Limite de questions atteinte pour l''instant. Réessayez plus tard ou passez à Alpha Illimité.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO alpha_messages (conversation_id, role, content)
  VALUES (v_conv.id, 'user', p_content)
  RETURNING * INTO v_msg;

  UPDATE alpha_conversations
  SET last_message_at = v_msg.created_at, updated_at = now()
  WHERE id = v_conv.id;

  RETURN v_msg;
END;
$$;

GRANT EXECUTE ON FUNCTION send_alpha_message(uuid, text) TO authenticated;

-- Recreate get_alpha_quota_status: identical output to v147, plus additive
-- daily_limit / daily_remaining fields so the client can surface the hard cap
-- without changing the existing limit/remaining semantics.
CREATE OR REPLACE FUNCTION get_alpha_quota_status(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_has_access  boolean;
  v_limit       int;
  v_daily_cap   int;
  v_quota       alpha_quota;
  v_daily       alpha_daily_usage;
  v_prior_count int;
  v_in_burst    boolean;
  v_remaining   int;
  v_daily_remaining int;
  v_next_reset  timestamptz;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  v_has_access := has_ai_access(p_business_id);
  SELECT value INTO v_limit FROM app_config
  WHERE key = CASE WHEN v_has_access THEN 'alpha_paid_daily_limit' ELSE 'alpha_free_daily_limit' END;

  SELECT value INTO v_daily_cap FROM app_config WHERE key = 'alpha_daily_cap';
  IF v_daily_cap IS NULL THEN v_daily_cap := 30; END IF;

  SELECT count(*) INTO v_prior_count
  FROM alpha_messages am
  JOIN alpha_conversations ac ON ac.id = am.conversation_id
  WHERE ac.business_id = p_business_id AND ac.user_id = auth.uid() AND am.role = 'user';
  v_in_burst := v_prior_count < 10;

  SELECT * INTO v_quota FROM alpha_quota WHERE user_id = auth.uid();

  IF NOT FOUND OR now() - v_quota.window_start >= interval '24 hours' THEN
    v_remaining  := v_limit;
    v_next_reset := NULL;
  ELSE
    v_remaining  := GREATEST(0, v_limit - v_quota.count_in_window);
    v_next_reset := CASE WHEN v_remaining = 0 THEN v_quota.window_start + interval '24 hours' ELSE NULL END;
  END IF;

  SELECT * INTO v_daily FROM alpha_daily_usage WHERE user_id = auth.uid();

  IF NOT FOUND OR now() - v_daily.window_start >= interval '24 hours' THEN
    v_daily_remaining := v_daily_cap;
  ELSE
    v_daily_remaining := GREATEST(0, v_daily_cap - v_daily.count_in_window);
  END IF;

  RETURN jsonb_build_object(
    'has_ai_access',            v_has_access,
    'limit',                    v_limit,
    'remaining',                v_remaining,
    'daily_limit',              v_daily_cap,
    'daily_remaining',          v_daily_remaining,
    'next_reset_at',            v_next_reset,
    'in_welcome_burst',         v_in_burst,
    'burst_messages_remaining', GREATEST(0, 10 - v_prior_count)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_alpha_quota_status(uuid) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 4. Phase 6 — audit trail + anomaly detection
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE alpha_messages ADD COLUMN IF NOT EXISTS intention         text;
ALTER TABLE alpha_messages ADD COLUMN IF NOT EXISTS params            jsonb;
ALTER TABLE alpha_messages ADD COLUMN IF NOT EXISTS details_path      text;
ALTER TABLE alpha_messages ADD COLUMN IF NOT EXISTS data_hash         text;
ALTER TABLE alpha_messages ADD COLUMN IF NOT EXISTS cost              numeric;
ALTER TABLE alpha_messages ADD COLUMN IF NOT EXISTS prompt_tokens     int;
ALTER TABLE alpha_messages ADD COLUMN IF NOT EXISTS completion_tokens int;

CREATE TABLE IF NOT EXISTS alpha_audit_trail (
  id                bigserial PRIMARY KEY,
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id           uuid,
  role              text,
  conversation_id   uuid,
  message_id        uuid,
  question          text,
  intention         text,
  params            jsonb,
  data_hash         text,
  response          text,
  model             text,
  prompt_tokens     int,
  completion_tokens int,
  cost              numeric,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE alpha_audit_trail ENABLE ROW LEVEL SECURITY;
-- No client policies at all: append-only, written and read only by the
-- service role (edge function / founder tooling). Merchants never see this.

-- Service-role only: the edge function records one audit row per interaction.
CREATE OR REPLACE FUNCTION write_alpha_audit_trail(
  p_business_id       uuid,
  p_user_id           uuid,
  p_role              text,
  p_conversation_id   uuid,
  p_message_id        uuid,
  p_question          text,
  p_intention         text,
  p_params            jsonb,
  p_data_hash         text,
  p_response          text,
  p_model             text,
  p_prompt_tokens     int,
  p_completion_tokens int,
  p_cost              numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO alpha_audit_trail (
    business_id, user_id, role, conversation_id, message_id,
    question, intention, params, data_hash, response,
    model, prompt_tokens, completion_tokens, cost
  ) VALUES (
    p_business_id, p_user_id, p_role, p_conversation_id, p_message_id,
    p_question, p_intention, p_params, p_data_hash, p_response,
    p_model, p_prompt_tokens, p_completion_tokens, p_cost
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION write_alpha_audit_trail(uuid, uuid, text, uuid, uuid, text, text, jsonb, text, text, text, int, int, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION write_alpha_audit_trail(uuid, uuid, text, uuid, uuid, text, text, jsonb, text, text, text, int, int, numeric) TO service_role;

-- Flags a user whose daily model-call volume exceeds 3× their rolling 7-day
-- baseline (excluding today). Read-only diagnostic; the edge function / cron
-- decides what to do with a true result (log + founder alert).
CREATE OR REPLACE FUNCTION detect_alpha_anomaly(p_business_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_today    int;
  v_baseline numeric;
BEGIN
  SELECT count(*) INTO v_today
  FROM alpha_messages am
  JOIN alpha_conversations ac ON ac.id = am.conversation_id
  WHERE ac.business_id = p_business_id
    AND ac.user_id = p_user_id
    AND am.role = 'user'
    AND am.created_at >= date_trunc('day', now());

  SELECT COALESCE(avg(d.cnt), 0) INTO v_baseline
  FROM (
    SELECT count(*)::numeric AS cnt
    FROM alpha_messages am
    JOIN alpha_conversations ac ON ac.id = am.conversation_id
    WHERE ac.business_id = p_business_id
      AND ac.user_id = p_user_id
      AND am.role = 'user'
      AND am.created_at >= date_trunc('day', now()) - interval '7 days'
      AND am.created_at <  date_trunc('day', now())
    GROUP BY date_trunc('day', am.created_at)
  ) d;

  RETURN jsonb_build_object(
    'anomaly',            (v_baseline > 0 AND v_today > 3 * v_baseline),
    'today_count',        v_today,
    'baseline_daily_avg', round(v_baseline, 2),
    'threshold',          round(3 * v_baseline, 2)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION detect_alpha_anomaly(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION detect_alpha_anomaly(uuid, uuid) TO service_role;
