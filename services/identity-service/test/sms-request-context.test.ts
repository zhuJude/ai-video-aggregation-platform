import { describe, expect, it } from 'vitest';

import { SmsRequestContext } from '../src/domain/sms-request-context.js';

describe('SmsRequestContext', () => {
  it.each([
    ['canonicalIp', '198.51.100.9', '203.0.113.8'],
    ['canonicalDeviceId', 'attacker-device', 'device-a'],
    ['mode', 'trusted_proxy', 'direct_socket'],
  ] as const)(
    'freezes the trusted %s prototype getter against replacement',
    (property, replacement, expected) => {
      const descriptor = Object.getOwnPropertyDescriptor(SmsRequestContext.prototype, property);
      if (descriptor === undefined) throw new Error(`MISSING_${property.toUpperCase()}_DESCRIPTOR`);
      const context = SmsRequestContext.fromDirectSocket({
        ipAddress: '203.0.113.8',
        deviceId: 'device-a',
      });
      let mutationError: unknown;
      let observed: unknown;

      try {
        try {
          Object.defineProperty(SmsRequestContext.prototype, property, {
            configurable: true,
            value: replacement,
          });
        } catch (error: unknown) {
          mutationError = error;
        }
        observed = context[property];
      } finally {
        if (mutationError === undefined) {
          Object.defineProperty(SmsRequestContext.prototype, property, descriptor);
        }
      }

      expect(mutationError).toBeInstanceOf(TypeError);
      expect(observed).toBe(expected);
    },
  );

  it.each(['assignment', 'defineProperty'] as const)(
    'freezes the static trust assertion against %s replacement',
    (operation) => {
      const descriptor = Object.getOwnPropertyDescriptor(SmsRequestContext, 'assertTrusted');
      if (descriptor === undefined) throw new Error('MISSING_ASSERT_TRUSTED_DESCRIPTOR');
      const mutableClass = SmsRequestContext as unknown as Record<string, unknown>;
      const replacement = () => undefined;
      let mutationError: unknown;
      let trustError: unknown;

      try {
        try {
          if (operation === 'assignment') {
            mutableClass['assertTrusted'] = replacement;
          } else {
            Object.defineProperty(SmsRequestContext, 'assertTrusted', {
              configurable: true,
              value: replacement,
            });
          }
        } catch (error: unknown) {
          mutationError = error;
        }
        try {
          SmsRequestContext.assertTrusted({});
        } catch (error: unknown) {
          trustError = error;
        }
      } finally {
        if (mutationError === undefined) {
          Object.defineProperty(SmsRequestContext, 'assertTrusted', descriptor);
        }
      }

      expect(mutationError).toBeInstanceOf(TypeError);
      expect(trustError).toMatchObject({ message: 'UNTRUSTED_SMS_REQUEST_CONTEXT' });
    },
  );

  it.each([
    ['canonicalIp', '198.51.100.9'],
    ['canonicalDeviceId', 'attacker-device'],
    ['mode', 'trusted_proxy'],
  ] as const)('freezes the trusted %s value against runtime mutation', (property, replacement) => {
    const context = SmsRequestContext.fromDirectSocket({
      ipAddress: '203.0.113.8',
      deviceId: 'device-a',
    });
    const original = {
      canonicalIp: context.canonicalIp,
      canonicalDeviceId: context.canonicalDeviceId,
      mode: context.mode,
    };
    const mutable = context as unknown as Record<string, unknown>;

    expect(() => {
      mutable[property] = replacement;
    }).toThrow(TypeError);
    expect(Reflect.set(context, property, replacement)).toBe(false);
    expect(() => Object.defineProperty(context, property, { value: replacement })).toThrow(
      TypeError,
    );

    expect(Object.isFrozen(context)).toBe(true);
    expect(context.canonicalIp).toBe(original.canonicalIp);
    expect(context.canonicalDeviceId).toBe(original.canonicalDeviceId);
    expect(context.mode).toBe(original.mode);
    expect(() => {
      SmsRequestContext.assertTrusted(context);
    }).not.toThrow();
  });

  it('rejects runtime constructor forging without the module-private capability', () => {
    const RuntimeConstructor = SmsRequestContext as unknown as new (
      ...args: unknown[]
    ) => SmsRequestContext;

    expect(() => new RuntimeConstructor('203.0.113.8', 'device-a', 'direct_socket')).toThrow(
      'UNTRUSTED_SMS_REQUEST_CONTEXT',
    );
    expect(() => new RuntimeConstructor({}, '203.0.113.8', 'device-a', 'direct_socket')).toThrow(
      'UNTRUSTED_SMS_REQUEST_CONTEXT',
    );
  });

  it('rejects scoped IPv6 with a stable application error', () => {
    expect(() =>
      SmsRequestContext.fromDirectSocket({
        ipAddress: 'fe80::1%eth0',
        deviceId: 'device-a',
      }),
    ).toThrow('INVALID_SMS_REQUEST_IP');
  });

  it.each([
    [undefined, 'INVALID_SMS_REQUEST_IP'],
    [null, 'INVALID_SMS_REQUEST_IP'],
    [{}, 'INVALID_SMS_REQUEST_IP'],
    [{ ipAddress: 42, deviceId: 'device-a' }, 'INVALID_SMS_REQUEST_IP'],
    [{ ipAddress: '203.0.113.8', deviceId: 42 }, 'INVALID_SMS_DEVICE_ID'],
  ])('rejects runtime input types with a stable application error %#', (input, expectedCode) => {
    const fromRuntime = (runtimeInput: unknown) =>
      SmsRequestContext.fromDirectSocket(runtimeInput as never);

    expect(() => fromRuntime(input)).toThrow(expectedCode);
  });

  it.each([
    [
      new Proxy(
        {},
        {
          get(_target, property) {
            if (property === 'ipAddress') throw new Error('HOSTILE_IP_PROXY');
            return 'device-a';
          },
        },
      ),
      'INVALID_SMS_REQUEST_IP',
    ],
    [
      {
        get ipAddress(): never {
          throw new Error('HOSTILE_IP_GETTER');
        },
        deviceId: 'device-a',
      },
      'INVALID_SMS_REQUEST_IP',
    ],
    [
      new Proxy(
        { ipAddress: '203.0.113.8' },
        {
          get(target, property) {
            if (property === 'deviceId') throw new Error('HOSTILE_DEVICE_PROXY');
            return property === 'ipAddress' ? target.ipAddress : undefined;
          },
        },
      ),
      'INVALID_SMS_DEVICE_ID',
    ],
    [
      {
        ipAddress: '203.0.113.8',
        get deviceId(): never {
          throw new Error('HOSTILE_DEVICE_GETTER');
        },
      },
      'INVALID_SMS_DEVICE_ID',
    ],
  ])('maps hostile runtime property access to a stable application error %#', (input, code) => {
    expect(() => SmsRequestContext.fromDirectSocket(input as never)).toThrow(code);
  });

  it('snapshots a type-changing IP getter exactly once', () => {
    let reads = 0;
    const context = SmsRequestContext.fromDirectSocket({
      get ipAddress() {
        reads += 1;
        return reads === 1 ? '203.0.113.8' : (42 as unknown as string);
      },
      deviceId: 'device-a',
    });

    expect(reads).toBe(1);
    expect(context.canonicalIp).toBe('203.0.113.8');
  });

  it('snapshots a type-changing device getter exactly once', () => {
    let reads = 0;
    const context = SmsRequestContext.fromDirectSocket({
      ipAddress: '203.0.113.8',
      get deviceId() {
        reads += 1;
        return reads === 1 ? 'device-a' : (42 as unknown as string);
      },
    });

    expect(reads).toBe(1);
    expect(context.canonicalDeviceId).toBe('device-a');
  });

  it('rejects malformed branded-looking values with a stable trust error', () => {
    const trusted = SmsRequestContext.fromDirectSocket({
      ipAddress: '203.0.113.8',
      deviceId: 'device-a',
    });
    const prototypeOnly = Object.create(SmsRequestContext.prototype) as unknown;
    const proxiedTrusted = new Proxy(trusted, {});
    const hostileProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('HOSTILE_PROXY');
        },
      },
    );

    for (const value of [prototypeOnly, proxiedTrusted, hostileProxy, {}]) {
      expect(() => {
        SmsRequestContext.assertTrusted(value);
      }).toThrow('UNTRUSTED_SMS_REQUEST_CONTEXT');
    }
  });

  it('derives the ingress mode from the explicit trusted adapter factory path', () => {
    const direct = SmsRequestContext.fromDirectSocket({
      ipAddress: '203.0.113.8',
      deviceId: 'device-a',
    });
    const proxied = SmsRequestContext.fromTrustedProxy({
      ipAddress: '203.0.113.8',
      deviceId: 'device-a',
    });

    expect(direct.mode).toBe('direct_socket');
    expect(proxied.mode).toBe('trusted_proxy');
  });

  it('canonicalizes equivalent IPv6 spellings and normalizes device case/whitespace', () => {
    const expanded = SmsRequestContext.fromTrustedProxy({
      ipAddress: '2001:0DB8:0:0:0:0:0:1',
      deviceId: ' Device-A ',
    });
    const compressed = SmsRequestContext.fromTrustedProxy({
      ipAddress: '2001:db8::1',
      deviceId: 'device-a',
    });

    expect(expanded.canonicalIp).toBe('2001:db8::1');
    expect(expanded.canonicalIp).toBe(compressed.canonicalIp);
    expect(expanded.canonicalDeviceId).toBe(compressed.canonicalDeviceId);
  });

  it.each([
    [
      {
        ipAddress: 'not-an-ip',
        deviceId: 'd',
      },
      'INVALID_SMS_REQUEST_IP',
    ],
    [{ ipAddress: '203.0.113.8', deviceId: '' }, 'INVALID_SMS_DEVICE_ID'],
    [
      {
        ipAddress: '203.0.113.8',
        deviceId: 'a'.repeat(129),
      },
      'INVALID_SMS_DEVICE_ID',
    ],
    [
      {
        ipAddress: '203.0.113.8',
        deviceId: 'device with spaces',
      },
      'INVALID_SMS_DEVICE_ID',
    ],
  ])('rejects invalid bounded context %#', (input, expectedCode) => {
    expect(() => SmsRequestContext.fromDirectSocket(input)).toThrow(expectedCode);
  });
});
