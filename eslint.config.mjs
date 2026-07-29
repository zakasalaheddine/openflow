import coreWebVitals from 'eslint-config-next/core-web-vitals'
import typescript from 'eslint-config-next/typescript'

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'data/**', 'exports/**', 'drizzle/**', '.playwright-data/**'] },
  ...coreWebVitals,
  ...typescript,
  {
    // The boundary rule. /core and /models are framework-free so the headless
    // runner (bin/run.ts) and the Phase 4 MCP server are nearly free.
    // Landed while /core is nearly empty — retrofitting it later fails on every
    // existing import and gets disabled instead of obeyed.
    files: ['src/core/**/*.ts', 'src/models/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react', 'react-dom', 'react/*', 'react-dom/*',
                'next', 'next/*',
                '@xyflow/*',
                '@/app/*', '**/app/*',
              ],
              message: '/core and /models must stay framework-free (see docs/phases/phase-1-core.md).',
            },
          ],
        },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
]

export default config
