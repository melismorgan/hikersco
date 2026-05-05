// Protects every /dashboard/* and /api/sheets/* route. Anything outside
// the matcher (e.g. /login, /api/auth) is public.
//
// Next 16 deprecated the `middleware.ts` filename in favor of `proxy.ts`,
// but middleware.ts still works for now. We'll rename when v4-of-next-auth
// publishes its v16-compatible release.
import withAuth from 'next-auth/middleware';

export default withAuth;

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/accessories/:path*',
    '/sku/:path*',
    '/reorder/:path*',
    '/api/sheets/:path*',
  ],
};
