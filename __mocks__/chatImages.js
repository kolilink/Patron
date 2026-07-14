// lib/chatImages.ts imports expo-image-manipulator, which ships unparsed
// ESM ('export { ... } from ...') that this project's plain ts-jest setup
// doesn't transform (node_modules isn't transformed by default — same class
// of issue documented for react-native-purchases in __mocks__/purchases.js).
// No jest unit test exercises real image upload (they all mock supabase.rpc
// already), so a stub that never resolves in a test run is fine.
module.exports = {
  uploadMessageImage: jest.fn(() => Promise.reject(new Error('uploadMessageImage is not mocked in this test'))),
};
