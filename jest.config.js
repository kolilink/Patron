/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    // Must precede the generic '^@/(.*)$' mapping below (Jest uses the first
    // matching key) — lib/purchases.ts imports react-native-purchases and
    // react-native's Platform, both of which ship unparsed Flow/ESM syntax
    // this project's plain ts-jest setup doesn't transform (see __mocks__/purchases.js).
    '^@/lib/purchases$': '<rootDir>/__mocks__/purchases.js',
    // Same reason as lib/purchases above — lib/chatImages.ts imports
    // expo-image-manipulator, which ships unparsed ESM.
    '^@/lib/chatImages$': '<rootDir>/__mocks__/chatImages.js',
    '^@/(.*)$': '<rootDir>/$1',
    '^expo-sqlite$': '<rootDir>/__mocks__/expo-sqlite.js',
    '^expo-secure-store$': '<rootDir>/__mocks__/expo-secure-store.js',
    '^expo-haptics$': '<rootDir>/__mocks__/expo-haptics.js',
    '^expo-crypto$': '<rootDir>/__mocks__/expo-crypto.js',
    '^expo-localization$': '<rootDir>/__mocks__/expo-localization.js',
    '^expo-file-system(/.*)?$': '<rootDir>/__mocks__/expo-file-system.js',
    '^@react-native-async-storage/async-storage$': '<rootDir>/__mocks__/async-storage.js',
    '^@sentry/react-native$': '<rootDir>/__mocks__/sentry.js',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        jsx: 'react-native',
        paths: { '@/*': ['./*'] },
        baseUrl: '.',
      },
      diagnostics: false,
    }],
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Integration tests hit a real local Supabase instance (npm run test:db:start)
  // and are run separately via jest.integration.config.js, not as part of the
  // default fast/hermetic `npm test` / `npm run check`.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/__tests__/integration/'],
};
