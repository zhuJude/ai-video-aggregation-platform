import { isIP } from 'node:net';

const MAX_IP_LENGTH = 45;
const DEVICE_ID = /^[a-z0-9._:-]{1,128}$/;
const TRUSTED_INGRESS_CAPABILITY: object = Object.freeze({});

export interface SmsRequestContextInput {
  ipAddress: string;
  deviceId: string;
}

export class SmsRequestContext {
  readonly #trustedContext: object;
  readonly #canonicalIp: string;
  readonly #canonicalDeviceId: string;
  readonly #mode: 'direct_socket' | 'trusted_proxy';

  private constructor(
    capability: object,
    canonicalIp: string,
    canonicalDeviceId: string,
    mode: 'direct_socket' | 'trusted_proxy',
  ) {
    if (capability !== TRUSTED_INGRESS_CAPABILITY) {
      throw stableError('UNTRUSTED_SMS_REQUEST_CONTEXT');
    }
    this.#trustedContext = capability;
    this.#canonicalIp = canonicalIp;
    this.#canonicalDeviceId = canonicalDeviceId;
    this.#mode = mode;
    Object.freeze(this);
  }

  get canonicalIp(): string {
    return this.#canonicalIp;
  }

  get canonicalDeviceId(): string {
    return this.#canonicalDeviceId;
  }

  get mode(): 'direct_socket' | 'trusted_proxy' {
    return this.#mode;
  }

  static fromDirectSocket(input: SmsRequestContextInput): SmsRequestContext {
    return SmsRequestContext.#fromTrustedIngress(input, 'direct_socket');
  }

  static fromTrustedProxy(input: SmsRequestContextInput): SmsRequestContext {
    return SmsRequestContext.#fromTrustedIngress(input, 'trusted_proxy');
  }

  static #fromTrustedIngress(
    input: unknown,
    mode: 'direct_socket' | 'trusted_proxy',
  ): SmsRequestContext {
    if (!isRecord(input)) throw stableError('INVALID_SMS_REQUEST_IP');

    let ipAddress: unknown;
    try {
      ipAddress = input.ipAddress;
    } catch {
      throw stableError('INVALID_SMS_REQUEST_IP');
    }
    if (typeof ipAddress !== 'string') throw stableError('INVALID_SMS_REQUEST_IP');

    let deviceId: unknown;
    try {
      deviceId = input.deviceId;
    } catch {
      throw stableError('INVALID_SMS_DEVICE_ID');
    }
    if (typeof deviceId !== 'string') throw stableError('INVALID_SMS_DEVICE_ID');

    const canonicalIp = canonicalizeIp(ipAddress);
    const canonicalDeviceId = deviceId.trim().toLowerCase();
    if (!DEVICE_ID.test(canonicalDeviceId)) throw stableError('INVALID_SMS_DEVICE_ID');
    return new SmsRequestContext(TRUSTED_INGRESS_CAPABILITY, canonicalIp, canonicalDeviceId, mode);
  }

  static assertTrusted(value: unknown): asserts value is SmsRequestContext {
    if (!SmsRequestContext.#hasTrustedBrand(value)) {
      throw stableError('UNTRUSTED_SMS_REQUEST_CONTEXT');
    }
  }

  static #hasTrustedBrand(value: unknown): boolean {
    try {
      return (
        typeof value === 'object' &&
        value !== null &&
        #trustedContext in value &&
        value.#trustedContext === TRUSTED_INGRESS_CAPABILITY &&
        Object.isFrozen(value)
      );
    } catch {
      return false;
    }
  }
}

Object.freeze(SmsRequestContext.prototype);
Object.freeze(SmsRequestContext);

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function canonicalizeIp(input: string): string {
  const candidate = input.trim().toLowerCase();
  if (candidate.includes('%')) throw stableError('INVALID_SMS_REQUEST_IP');
  const version = isIP(candidate);
  if (version === 0) throw stableError('INVALID_SMS_REQUEST_IP');
  const canonical =
    version === 6 ? new URL(`http://[${candidate}]/`).hostname.slice(1, -1) : candidate;
  if (canonical.length > MAX_IP_LENGTH) throw stableError('INVALID_SMS_REQUEST_IP');
  return canonical;
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
