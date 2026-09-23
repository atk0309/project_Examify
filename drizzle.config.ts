import type { Config } from 'drizzle-kit';
import { resolveCliDataPaths } from './src/lib/data-dir';

// Same SQLite file as the app and `pnpm db:migrate` (EXAMIFY_DATA_DIR /
// DATABASE_URL from the process env, then the repo env files).
export default {
  schema: './src/lib/db/schema.ts',
  out: './src/lib/db/migrations',
  dialect: 'sqlite',
  dbCredentials: { url: resolveCliDataPaths().dbPath },
  strict: true,
  verbose: true,
} satisfies Config;
