const PHONE_SEPARATORS = /[\p{M}\p{S}\p{P}\p{Z}\p{C}]/gu;
const PHONE_SEQUENCE = /(?:\+?86)?1\d{10}/u;
const UNSAFE_CONTROL = /\p{C}/u;
const MAX_SENSITIVE_VALUE_LENGTH = 8192;
const MAX_PERCENT_DECODE_ROUNDS = 5;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u;
const TAG = /^[\p{L}\p{N}_ -]{1,64}$/u;
const DECIMAL_DIGIT = /^\p{Nd}$/u;
const decimalDigitCache = new Map<number, string>();
export const SENSITIVE_QUERY_NOTICE = 'sensitive-query-removed';
export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export const REGISTRATION_SOURCES = ['WEB', 'INVITE', 'PARTNER'] as const;
export const SPENDING_TIERS = ['LOW', 'MEDIUM', 'HIGH'] as const;
const userStatuses = new Set<string>(USER_STATUSES);
const registrationSources = new Set<string>(REGISTRATION_SOURCES);
const spendingTiers = new Set<string>(SPENDING_TIERS);

export type UserFilters = Readonly<{
  registrationSource?: (typeof REGISTRATION_SOURCES)[number];
  spendingTier?: (typeof SPENDING_TIERS)[number];
  status?: (typeof USER_STATUSES)[number];
  tag?: string;
}>;

type BrowserSearchParams =
  URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

export type SanitizedUsersSearchParams = Readonly<{
  cursor?: string;
  query?: string;
  registrationSource?: string;
  spendingTier?: string;
  status?: string;
  tag?: string;
  notice?: typeof SENSITIVE_QUERY_NOTICE;
}>;

function decodePercentBytes(value: string): string {
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (encoded) => {
    const bytes = encoded.match(/[0-9A-Fa-f]{2}/gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [];
    return new TextDecoder().decode(Uint8Array.from(bytes));
  });
}

function decimalDigitToAscii(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined || !DECIMAL_DIGIT.test(character)) return character;
  const cached = decimalDigitCache.get(codePoint);
  if (cached !== undefined) return cached;
  let runStart = codePoint;
  while (runStart > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(runStart - 1))) runStart -= 1;
  const digit = String((codePoint - runStart) % 10);
  decimalDigitCache.set(codePoint, digit);
  return digit;
}

function normalizePhoneGlyphs(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Nd}/gu, decimalDigitToAscii)
    .replace(PHONE_SEPARATORS, '');
}

export function containsSensitivePhoneLikeValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length > MAX_SENSITIVE_VALUE_LENGTH) return true;
  let decoded = value;
  for (let depth = 0; depth < MAX_PERCENT_DECODE_ROUNDS; depth += 1) {
    if (UNSAFE_CONTROL.test(decoded.normalize('NFKC'))) return true;
    if (PHONE_SEQUENCE.test(normalizePhoneGlyphs(decoded))) return true;
    const next = decodePercentBytes(decoded);
    if (next === decoded) return false;
    if (next.length > MAX_SENSITIVE_VALUE_LENGTH) return true;
    decoded = next;
  }
  return (
    UNSAFE_CONTROL.test(decoded.normalize('NFKC')) ||
    PHONE_SEQUENCE.test(normalizePhoneGlyphs(decoded))
  );
}

export function isSafeDirectoryCursor(value: unknown): value is string {
  return typeof value === 'string' && CURSOR.test(value) && !containsSensitivePhoneLikeValue(value);
}

function rawEntries(input: BrowserSearchParams): readonly (readonly [string, string])[] {
  if (input instanceof URLSearchParams) return [...input.entries()];
  return Object.entries(input).flatMap(([name, value]) =>
    typeof value === 'string'
      ? [[name, value] as const]
      : Array.isArray(value)
        ? value.map((item) => [name, item] as const)
        : [],
  );
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function sanitizeUsersSearchParams(
  input: BrowserSearchParams,
): Readonly<{ params: SanitizedUsersSearchParams; rejected: boolean }> {
  const entries = rawEntries(input);
  let rejected = entries.some(([, value]) => containsSensitivePhoneLikeValue(value));
  const byName = new Map<string, string[]>();
  for (const [name, value] of entries) {
    const values = byName.get(name) ?? [];
    values.push(value);
    byName.set(name, values);
  }
  const result: Record<string, string> = {};
  const acceptOne = (
    name: keyof SanitizedUsersSearchParams,
    validate: (value: string) => boolean,
    normalize: (value: string) => string = (value) => value,
  ) => {
    const values = byName.get(name);
    if (!values) return;
    if (values.length !== 1 || containsSensitivePhoneLikeValue(values[0])) {
      rejected = true;
      return;
    }
    const value = normalize(values[0] ?? '');
    if (!validate(value)) {
      rejected = true;
      return;
    }
    if (value) result[name] = value;
  };
  acceptOne(
    'query',
    (value) => value.length <= 128 && !containsAsciiControl(value),
    (value) => value.trim(),
  );
  acceptOne('cursor', isSafeDirectoryCursor);
  acceptOne('status', (value) => userStatuses.has(value));
  acceptOne('registrationSource', (value) => registrationSources.has(value));
  acceptOne('spendingTier', (value) => spendingTiers.has(value));
  acceptOne('tag', (value) => TAG.test(value));
  acceptOne('notice', (value) => value === SENSITIVE_QUERY_NOTICE);
  for (const name of byName.keys()) {
    if (
      ![
        'query',
        'cursor',
        'status',
        'registrationSource',
        'spendingTier',
        'tag',
        'notice',
      ].includes(name) &&
      byName.get(name)?.some(containsSensitivePhoneLikeValue)
    )
      rejected = true;
  }
  return { params: result, rejected };
}

export function usersSearchParamsToString(params: SanitizedUsersSearchParams): string {
  return new URLSearchParams({
    ...(params.query ? { query: params.query } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.tag ? { tag: params.tag } : {}),
    ...(params.registrationSource ? { registrationSource: params.registrationSource } : {}),
    ...(params.spendingTier ? { spendingTier: params.spendingTier } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    ...(params.notice ? { notice: params.notice } : {}),
  }).toString();
}
