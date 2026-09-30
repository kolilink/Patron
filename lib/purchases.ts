import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';
import Purchases from 'react-native-purchases';

// react-native-purchases is native code — it doesn't exist inside the Expo Go
// sandbox app (only Expo's own built-in native modules run there). Once real
// API keys replaced the placeholders, configure() below stopped being a
// harmless no-op and started actually reaching for that missing native
// module, crashing the whole app on every boot under Expo Go (not just the
// paywall). This guard restores Expo Go as a safe no-op environment — same
// posture as the missing-key case — while real dev-client/production builds
// (ExecutionEnvironment.StoreClient or Bare) configure normally.
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

// Singleton wrapper around the RevenueCat SDK — mirrors lib/posthog.ts's
// pattern of a key that's optional until the real dashboard/store setup
// exists. RevenueCat needs App Store Connect + Play Console products and a
// RevenueCat project before these keys exist (see CLAUDE.md's IAP setup
// checklist) — until then, every function here is a safe no-op so the rest
// of the app (trial, gate logic) keeps working.
const IOS_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_API_KEY_IOS ?? '';
const ANDROID_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_API_KEY_ANDROID ?? '';

// Master killswitch for the entire Alpha Pro paywall/upsell surface (the
// full-screen + inline PaywallScreen, the WhatsApp-reminder consent ask, and
// the "ALPHA PRO"/"gratuite" tier wording — all in app/(app)/alpha/index.tsx —
// plus the post-business-creation TrialWelcomeOverlay in app/(app)/_layout.tsx,
// which pitches "premier mois offert, ensuite 2,99$/mois" and was originally
// wired unconditionally, independent of this flag — found 2026-07-30 when a
// merchant reported still seeing a paywall-like screen after this was set to
// false).
// Set to false 2026-07-16 on explicit product direction: no upsell should be
// visible to anyone — including App Store/Play Store reviewers — until the
// app has a real base of active users (order of 100s). Alpha itself stays
// available to everyone at a flat quota in the meantime (see
// db/migration_v147.sql's app_config — alpha_free_daily_limit and
// alpha_paid_daily_limit both set to 10 via set_alpha_daily_limit) with no
// way to ever reach an upgrade prompt while this is false. Flip back to true
// (and raise alpha_paid_daily_limit back up) when ready to re-launch
// monetization — every paywall-adjacent surface reads this one flag.
export const PAYWALL_ENABLED = false;

let configured = false;

export function configurePurchases(): void {
  if (configured) return;
  if (isExpoGo) {
    if (__DEV__) console.log('[purchases] Running in Expo Go — native module unavailable, IAP disabled for this session');
    return;
  }
  const apiKey = Platform.OS === 'ios' ? IOS_API_KEY : ANDROID_API_KEY;
  if (!apiKey) {
    if (__DEV__) console.log('[purchases] No RevenueCat API key set for this platform — IAP disabled until configured');
    return;
  }
  try {
    Purchases.configure({ apiKey });
    configured = true;
  } catch (err) {
    console.warn('[purchases] configure() failed:', err);
  }
}

export const isPurchasesConfigured = (): boolean => configured;

// Called right after a business is created/restored so RevenueCat's
// app_user_id equals businesses.id — the same identity convention
// PaywallScreen.tsx previously used for Stripe's client_reference_id, and
// what supabase/functions/revenuecat-webhook/index.ts assumes when writing
// back to the businesses table.
export async function loginPurchases(businessId: string): Promise<void> {
  if (!configured) return;
  try {
    await Purchases.logIn(businessId);
  } catch (err) {
    console.warn('[purchases] logIn failed:', err);
  }
}
