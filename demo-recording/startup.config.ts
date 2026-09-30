import path from 'node:path';
import { defineConfig } from '@playwright/test';
import base from './playwright.config';
if (process.env.DEMO_MODE !== 'stub') throw Error('startup_preflight_must_be_keyless');
if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)
  throw Error('startup_preflight_refuses_provider_keys');
const server = base.webServer;
if (!server || Array.isArray(server)) throw Error('startup_preflight_requires_one_server');
export default defineConfig({
  ...base,
  testMatch: 'startup.spec.ts',
  timeout: 30_000,
  outputDir: 'tests/.tmp/demo-startup-output',
  use: { ...base.use, video: 'off', trace: 'off', screenshot: 'off' },
  webServer: {
    ...server,
    env: {
      ...server.env,
      DEMO_MODE: 'stub',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      DEMO_BUDGET_DIR: path.resolve('tests/.tmp/demo-startup-budget'),
    },
  },
});
