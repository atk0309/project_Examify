import { env } from './env';

export const siteConfig = {
  name: 'Examify',
  shortName: 'Examify',
  description: 'Short, focused mini exams — calm, encouraging practice for school exams.',
  author: 'Examify',
  url: env.SITE_URL,
} as const;

export type SiteConfig = typeof siteConfig;
