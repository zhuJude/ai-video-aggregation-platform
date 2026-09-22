import { containsSensitivePhoneLikeValue } from './sensitive-query';

const protectedRouteRoots = new Set([
  'audit',
  'content',
  'finance',
  'iam',
  'models',
  'overview',
  'pricing',
  'providers',
  'routing',
  'runbooks',
  'system',
  'tasks',
  'tickets',
  'users',
]);
const safePath = /^\/[A-Za-z0-9._~/-]{1,512}$/u;

export function normalizeAdminLoginReturnTarget(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//')
  )
    return undefined;
  if (containsSensitivePhoneLikeValue(value)) return undefined;
  try {
    const target = new URL(value, 'https://admin-return.invalid');
    const root = target.pathname.split('/').find(Boolean);
    if (
      target.origin !== 'https://admin-return.invalid' ||
      target.hash ||
      !safePath.test(target.pathname) ||
      !root ||
      !protectedRouteRoots.has(root) ||
      target.pathname === '/login'
    )
      return undefined;
    const normalized = `${target.pathname}${target.search}`;
    return normalized === value ? normalized : undefined;
  } catch {
    return undefined;
  }
}
