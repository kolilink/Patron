// react-native ships unparsed Flow/ESM syntax this project's plain ts-jest
// setup doesn't transform (node_modules isn't transformed by default) —
// same class of fix as __mocks__/purchases.js, __mocks__/chatImages.js,
// __mocks__/sentry.js. Only lib/sync.ts imports from 'react-native' directly
// (for Platform.OS, purely informational in Sentry's `extra` payload) — kept
// minimal on purpose rather than a full react-native mock, since nothing
// under test renders actual RN components (see CLAUDE.md: no UI/component
// tests). Add exports here only as new call sites actually need them.
const a11y = { enabled: false, listeners: [] };
module.exports = {
  LayoutAnimation: { configureNext: jest.fn(), Presets: { easeInEaseOut: {} } },
  UIManager: {},
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(a11y.enabled),
    addEventListener: (_e, cb) => { a11y.listeners.push(cb); return { remove: () => {} }; },
    __set: (v) => { a11y.enabled = v; a11y.listeners.forEach(cb => cb(v)); },
    __reset: () => { a11y.enabled = false; a11y.listeners = []; },
  },
  Platform: {
    OS: 'ios',
    // Android API level — mutated by haptics tests to exercise the
    // performAndroidHapticsAsync fallback ladder (30/34 thresholds).
    Version: 0,
    select: (spec) => ('ios' in spec ? spec.ios : spec.default),
  },
};
