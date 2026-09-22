const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export function encodeCanonicalBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeCanonicalBase64Url(
  value: unknown,
  bounds: Readonly<{ maximumLength: number; minimumLength?: number }>,
): Uint8Array<ArrayBuffer> | null {
  if (
    typeof value !== 'string' ||
    value.length < (bounds.minimumLength ?? 1) ||
    value.length > bounds.maximumLength ||
    !BASE64URL.test(value)
  )
    return null;
  try {
    const padded = value
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return encodeCanonicalBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}
