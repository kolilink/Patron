// react-native ships unparsed Flow/ESM syntax this project's plain ts-jest
// setup doesn't transform (node_modules isn't transformed by default) —
// same class of fix as __mocks__/purchases.js, __mocks__/chatImages.js,
// __mocks__/sentry.js. Only lib/sync.ts imports from 'react-native' directly
// (for Platform.OS, purely informational in Sentry's `extra` payload) — kept
// minimal on purpose rather than a full react-native mock, since nothing
// under test renders actual RN components (see CLAUDE.md: no UI/component
// tests). Add exports here only as new call sites actually need them.
module.exports = {
  Platform: {
    OS: 'ios',
    select: (spec) => ('ios' in spec ? spec.ios : spec.default),
  },
};
