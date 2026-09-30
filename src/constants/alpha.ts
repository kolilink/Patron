// Transparency strings for Alpha (spec §6 Phase 4) — single source of truth
// for the app UI. The edge function (supabase/functions/alpha-chat/lib.ts)
// ships its own copies because Supabase deploys that directory in isolation;
// __tests__/alpha-lib.test.ts asserts the two stay in sync so the "?"
// info sheet can never drift from what the server actually prefixes.

export const ALPHA_LABEL = "Alpha, l'assistant IA";

export const ALPHA_DISCLOSURE =
    "Je suis Alpha, un assistant automatique de Patron. Je lis tes chiffres pour t'aider.";

export const ALPHA_WARNING = 'Je peux me tromper — vérifie avec tes chiffres.';
