import { env } from './env';

export const siteConfig = {
  name: 'Examify',
  description: 'Short, focused mini exams for personal study and optional household practice.',
  author: 'Examify',
  url: env.SITE_URL,
} as const;
