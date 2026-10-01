import { NextResponse, type NextRequest } from 'next/server';
import { env, isSoloMode } from '@/lib/env';
import { soloRequestAllowed } from '@/lib/solo-security';

/** Every path, including assets and API routes, requires the launcher boundary. */
export function proxy(request: NextRequest) {
  if (!isSoloMode()) return NextResponse.next();
  if (!soloRequestAllowed(request.headers, env, request.method)) {
    return new NextResponse('Local launcher access required.', { status: 403 });
  }
  // Apply the same household gate to percent-encoded route spellings too.
  let pathname: string;
  try {
    pathname = decodeURIComponent(request.nextUrl.pathname);
  } catch {
    return new NextResponse('Invalid local route.', { status: 400 });
  }
  // Solo never exposes household claiming, invitations, or ordinary sign-in.
  if (/^\/(?:setup|signin|invite)(?:\/|$)/.test(pathname)) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new NextResponse('Unavailable in solo mode.', { status: 403 });
    }
    return NextResponse.redirect(new URL('/solo/start', env.SITE_URL));
  }
  const response = NextResponse.next();
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  return response;
}
