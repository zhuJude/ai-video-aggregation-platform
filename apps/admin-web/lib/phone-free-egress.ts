import { containsSensitivePhoneLikeValue } from './sensitive-query';

export function isPhoneFreeBoundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !containsSensitivePhoneLikeValue(value)
  );
}

export function isPhoneFreeHttpsUrl(value: unknown, maximumLength = 2048): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    containsSensitivePhoneLikeValue(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !containsSensitivePhoneLikeValue(url.href)
    );
  } catch {
    return false;
  }
}
