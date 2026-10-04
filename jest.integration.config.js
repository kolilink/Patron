/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        paths: { '@/*': ['./*'] },
        baseUrl: '.',
      },
      diagnostics: false,
    }],
  },
  testMatch: ['**/__tests__/integration/**/*.test.ts'],
  testTimeout: 30000,
  // Every suite talks to ONE shared local Supabase stack (Postgres + GoTrue +
  // PostgREST + Kong + Storage + edge runtime) that, on a CI runner, shares its
  // CPUs with the jest workers. Each createTestUser() is a GoTrue admin call
  // with password hashing; too many workers saturate the stack and surface as
  // AuthRetryableFetchError / 502 "invalid response from upstream" / timeouts in
  // *unrelated* suites. Cap the workers so the stack stays responsive.
  maxWorkers: 2,
};
