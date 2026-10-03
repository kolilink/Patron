// expo-clipboard ships unparsed ESM. lib/inviteLink.ts imports it for the iOS
// clipboard handoff (B2(b) token survival). Kept minimal — no clipboard exists
// in the test environment, so all reads return false/null.
module.exports = {
    hasStringAsync: async () => false,
    getStringAsync: async () => null,
    setStringAsync: async () => { },
};
