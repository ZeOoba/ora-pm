// OI-255: real lint. `npm run lint` used to alias `tsc --noEmit`; this is the actual linter.
// Pattern mirrors oxford-command-center/eslint.config.js (flat config, ESLint 9).
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Build output, tooling caches, and Claude-system worktrees are not app source. Compiled *.js
  // beside the TS sources (tsc -b output, gitignored) is excluded by the ts/tsx `files` filter.
  { ignores: ['dist', 'dist-server', 'node_modules', '.wrangler', 'coverage', '.claude', '.worktrees'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
)
