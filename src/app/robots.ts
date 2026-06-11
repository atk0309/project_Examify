import type { MetadataRoute } from 'next';

// Examify is a private, allowlisted app — keep it out of search indexes.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: '/' }],
  };
}
