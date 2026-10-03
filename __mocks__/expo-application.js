// expo-application ships unparsed ESM. lib/inviteLink.ts imports it for the
// Android Play Install Referrer read. Kept minimal — no install referrer in
// the test environment.
module.exports = {
    getInstallReferrerAsync: async () => null,
};
