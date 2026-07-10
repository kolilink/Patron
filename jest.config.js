/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^expo-sqlite$': '<rootDir>/__mocks__/expo-sqlite.js',
    '^expo-secure-store$': '<rootDir>/__mocks__/expo-secure-store.js',
    '^expo-haptics$': '<rootDir>/__mocks__/expo-haptics.js',
    '^expo-crypto$': '<rootDir>/__mocks__/expo-crypto.js',
    '^expo-localization$': '<rootDir>/__mocks__/expo-localization.js',
    '^expo-file-system(/.*)?$': '<rootDir>/__mocks__/expo-file-system.js',
    '^@react-native-async-storage/async-storage$': '<rootDir>/__mocks__/async-storage.js',
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
