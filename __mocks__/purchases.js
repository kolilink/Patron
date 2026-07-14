// lib/purchases.ts wraps react-native-purchases, which (like the real
// 'react-native' package it imports Platform from) ships Flow/ESM syntax
// this project's plain ts-jest setup deliberately doesn't transform — the
// store unit tests are meant to stay decoupled from real RN/native modules
// (see CLAUDE.md: "no UI/component tests, all mock supabase.rpc"). Mocked
// here the same way expo-sqlite/expo-secure-store/etc. already are.
module.exports = {
  configurePurchases: () => {},
  isPurchasesConfigured: () => false,
  loginPurchases: async () => {},
  logoutPurchases: async () => {},
};
