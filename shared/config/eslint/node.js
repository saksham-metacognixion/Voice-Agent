import globals from 'globals';
import base from './base.js';

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...base,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Nest relies on classes with decorators and DI; these two rules fight it.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
];
