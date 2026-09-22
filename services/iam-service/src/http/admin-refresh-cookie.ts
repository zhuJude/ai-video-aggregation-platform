const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REFRESH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function adminRefreshCookie(refreshToken: string): string {
  if (!REFRESH_TOKEN_PATTERN.test(refreshToken)) throw stableError('INVALID_REFRESH_TOKEN');
  return [
    `admin_refresh=${refreshToken}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/v1/admin/auth/refresh',
    `Max-Age=${String(REFRESH_MAX_AGE_SECONDS)}`,
  ].join('; ');
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
