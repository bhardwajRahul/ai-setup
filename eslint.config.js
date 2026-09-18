import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  eslintConfigPrettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['src/**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_|^vi$' },
      ],
    },
  },
  {
    // src/vendor/** holds byte-for-byte upstream copies (see each VENDOR.md).
    // Linting them would pressure us into reformatting code we need to diff
    // cleanly against upstream on every re-sync.
    ignores: [
      'dist/**',
      'coverage/**',
      'index.cjs',
      '*.config.*',
      'src/vendor/**',
      // Ported verbatim from upstream alongside the vendored library; kept
      // unmodified so it still detects drift on a re-sync.
      'src/compaction/__tests__/vendor-parity.test.ts',
    ],
  },
);
