// @sentry/react-native ships unparsed ESM `export` syntax this project's
// plain ts-jest setup doesn't transform (node_modules isn't transformed by
// default) — same class of fix as __mocks__/purchases.js and
// __mocks__/chatImages.js. Mocked at the package level (not a local wrapper)
// since stores/auth.ts and app/_layout.tsx import it directly.
module.exports = {
  init: () => {},
  wrap: (component) => component,
  captureMessage: () => {},
  captureException: () => {},
  setTag: () => {},
  setUser: () => {},
};
