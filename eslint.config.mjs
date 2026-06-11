import nextConfig from 'eslint-config-next';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'out/**',
      'build/**',
      'playwright-report/**',
      'test-results/**',
      'src/lib/db/migrations/**',
      'next-env.d.ts',
    ],
  },
  ...nextConfig,
  {
    rules: {
      'react/no-unescaped-entities': 'off',
      '@next/next/no-img-element': 'off',
    },
  },
];

export default config;
