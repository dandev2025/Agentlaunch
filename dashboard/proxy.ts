import { NextResponse, type NextRequest } from 'next/server';

/** Optional HTTP Basic auth: set DASHBOARD_PASSWORD (and optionally DASHBOARD_USER) before exposing this beyond localhost. */
export function proxy(req: NextRequest) {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return NextResponse.next();
  const user = process.env.DASHBOARD_USER ?? 'admin';
  const h = req.headers.get('authorization');
  if (h?.startsWith('Basic ')) {
    const [u, ...rest] = atob(h.slice(6)).split(':');
    const p = rest.join(':');
    if (u === user && p.length === pw.length && [...p].reduce((a, c, i) => a | (c.charCodeAt(0) ^ pw.charCodeAt(i)), 0) === 0) return NextResponse.next();
  }
  return new NextResponse('Authentication required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="order-flow dashboard"' } });
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
