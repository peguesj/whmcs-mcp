// @peguesj/whmcs-mcp — ESLint flat config (ESLint 9 + typescript-eslint 8)
//
// Strict-by-default: this repo is a safety-critical MCP server that talks to
// production WHMCS billing systems, so `any` is an error (not a warning) and
// unused/unsafe patterns are flagged. See CLAUDE.md / SECURITY.md for the
// broader safety posture (read-only by default, confirmation-gated mutations,
// redaction before output).

import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    // Build output, deps, and generated artifacts are never linted.
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'site/assets/**',
      'site/data/**',
      '*.config.js',
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        // Type-aware linting (needed for no-unsafe-* / no-floating-promises,
        // which matter a lot in a client that talks to a billing API).
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
        sourceType: 'module',
      },
      ecmaVersion: 2022,
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs['strict-type-checked']?.rules,
      ...tseslint.configs['stylistic-type-checked']?.rules,

      // --- Core DRTW/safety rule for this repo: no `any`, ever, without an
      // explicit inline justification comment reviewed by opus. ---
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // Mutating WHMCS actions must never silently drop an unresolved promise.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Unused vars/imports are errors, but allow a leading-underscore escape
      // hatch for intentionally-unused destructured fields (e.g. redaction
      // helpers that strip a field by naming it and discarding it).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-empty-interface': 'off',

      // Never log secrets: this is enforced structurally in src/logger.ts and
      // src/safety/redact.ts, but banning raw console.* here keeps anyone
      // from adding a stray console.log(payload) that bypasses redaction.
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },

  {
    // Test files and scripts talk to the mock server / fixtures only, so
    // relax the type-aware rules that exist mainly to protect the real
    // WHMCS network boundary.
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      'no-console': 'off',
    },
  },
];
