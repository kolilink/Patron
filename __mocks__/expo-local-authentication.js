// Hermetic mock for expo-local-authentication. The real module ships native
// bindings that don't resolve under ts-jest/node, and every test that touches
// unlockWithBiometric (stores/auth.ts) needs the prompt callable + inspectable.
module.exports = {
    hasHardwareAsync: jest.fn(async () => true),
    isEnrolledAsync: jest.fn(async () => true),
    authenticateAsync: jest.fn(async () => ({ success: true })),
};
