const js = require('@eslint/js');
const globals = require('globals');

// Backend lint. Mirrors the frontend's stance: errors for things that are certainly wrong,
// warnings for the existing backlog so it is visible without blocking CI.
module.exports = [
  { ignores: ['node_modules/**', 'logs/**', 'storage/**', 'test/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // The logger is the one sanctioned output path (it adds requestId, branch, user).
      'no-console': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    // Startup scripts and one-off ops scripts are allowed to talk to the console.
    files: ['server.js', 'scripts/**/*.js'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
];
