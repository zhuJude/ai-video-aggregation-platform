const SAFE_RETURN_PATH =
  /^\/(?:studio|tasks(?:\/[A-Za-z0-9_-]+)?|assets|wallet|orders|invoices|messages|tickets|settings\/(?:profile|security))$/;

export function safeReturnTo(input: string | string[] | undefined): string {
  if (
    typeof input !== 'string' ||
    input.length > 512 ||
    !input.startsWith('/') ||
    input.startsWith('//') ||
    input.includes('\\') ||
    input.includes('#') ||
    /%(?:2e|2f|5c)/i.test(input) ||
    input
      .split(/[?#]/, 1)[0]
      ?.split('/')
      .some((segment) => segment === '.' || segment === '..')
  )
    return '/tasks';
  try {
    const parsed = new URL(input, 'https://app.invalid');
    if (
      parsed.origin !== 'https://app.invalid' ||
      parsed.hash ||
      !SAFE_RETURN_PATH.test(parsed.pathname)
    ) {
      return '/tasks';
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/tasks';
  }
}
