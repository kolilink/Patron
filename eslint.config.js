// Minimal ESLint setup — exists solely to catch Rules-of-Hooks violations
// (conditional hooks / hooks after an early return) before they ship as a
// runtime crash. See CLAUDE.md's "Tabs layout — Rules-of-Hooks crash on
// logout" note for the bug this was added to prevent.
const tsParser = require('@typescript-eslint/parser');
const reactHooks = require('eslint-plugin-react-hooks');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'supabase/functions/**', // Deno runtime, not this project's lint target
      'ios/**',
      'android/**',
      '.expo/**',
      'dist/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // The only rule this setup exists for — everything else is deliberately off.
      // 100+ effects in this codebase are intentionally mount-only (deps array
      // scoped narrower than exhaustive-deps wants), so enabling it would just
      // bury the one signal this config is meant to surface.
      'react-hooks/rules-of-hooks': 'error',
    },
  },
];
