'use strict';

// ESLint flat config (ESLint 9). CommonJS throughout (package "type": "commonjs").
const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        global: 'writable',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none', // catch (_) { } is a deliberate idiom here
      }],
      'no-undef': 'error',
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Braces required when the body is on its own line(s); one-line
      // `if (x) return y;` stays brace-free.
      curly: ['error', 'multi-line'],
    },
  },
  {
    // Tests use a few deliberate globals and looser structure.
    files: ['test/**/*.js'],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // Debug/scratch files are not linted (they are not committed).
    ignores: ['**/debug-*.js', 'node_modules/**'],
  },
];
