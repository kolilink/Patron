// @sentry/react-native ships unparsed ESM `export` syntax this project's
// plain ts-jest setup doesn't transform (node_modules isn't transformed by
// default) — same class of fix as __mocks__/purchases.js and
// __mocks__/chatImages.js. Mocked at the package level (not a local wrapper)
// since stores/auth.ts and app/_layout.tsx import it directly.
// jest.fn() (not plain no-op arrows) so tests can assert on these calls —
// e.g. reportOfflineFallback() in lib/sync.ts, which exists specifically so
// a real device's offline transitions are diagnosable from Sentry instead
// of re-derived from scratch each time. Still a safe no-op when unasserted.
module.exports = {
  init: jest.fn(),
  wrap: (component) => component,
  captureMessage: jest.fn(),
  captureException: jest.fn(),
  setTag: jest.fn(),
  setUser: jest.fn(),
};
