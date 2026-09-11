import globals from 'globals';
import base from './base.js';

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...base,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { 'no-console': ['warn', { allow: ['warn', 'error', 'info'] }] },
  },
];
