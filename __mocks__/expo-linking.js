// expo-linking ships unparsed ESM (import of expo-modules-core) that this
// project's plain ts-jest setup doesn't transform — same class of fix as the
// other expo-* mocks. lib/inviteLink.ts imports it for getInitialURL(); only
// the deferred-deep-link read uses it. Kept minimal.
module.exports = {
    getInitialURL: async () => null,
    createURL: () => '',
    parse: () => ({ hostname: '', path: '', queryParams: {} }),
};
