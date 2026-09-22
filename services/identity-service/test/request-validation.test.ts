import { describe, expect, it } from 'vitest';

import {
  parseCloseAccountBody,
  parsePhoneChangeRequestBody,
  parsePhoneChangeVerifyBody,
  parseProfileBody,
  parseSessionId,
  parseSmsRequestBody,
  parseSmsVerifyBody,
} from '../src/http/request-validation.js';

const operationId = '0198fabc-1234-7abc-8abc-111111111111';

describe('identity HTTP request validation', () => {
  it('parses every valid body and normalizes phone-change numbers', () => {
    expect(parseSmsRequestBody({ phone: '13800138000', deviceId: 'Browser-A' })).toEqual({
      phone: '13800138000',
      deviceId: 'Browser-A',
    });
    expect(
      parseSmsVerifyBody({ phone: '13800138000', code: '123456', deviceName: ' Chrome ' }),
    ).toEqual({ phone: '13800138000', code: '123456', deviceName: 'Chrome' });
    expect(parseProfileBody({ nickname: ' nickname ' })).toEqual({ nickname: 'nickname' });
    expect(
      parsePhoneChangeRequestBody({ newPhoneE164: '13900139000', deviceId: 'browser' }),
    ).toEqual({ newPhoneE164: '+8613900139000', deviceId: 'browser' });
    expect(
      parsePhoneChangeVerifyBody({
        currentPhoneCode: '111111',
        newPhoneE164: '+8613900139000',
        newPhoneCode: '222222',
        operationId,
      }),
    ).toMatchObject({ newPhoneE164: '+8613900139000', operationId });
    expect(parseCloseAccountBody({ code: '123456', operationId })).toEqual({
      code: '123456',
      operationId,
    });
    expect(parseSessionId(operationId)).toBe(operationId);
  });

  it.each([
    () => parseSmsRequestBody({ phone: 13800138000, deviceId: 'browser' }),
    () => parseSmsRequestBody({ phone: '13800138000', deviceId: 'x'.repeat(129) }),
    () => parseSmsVerifyBody({ phone: '13800138000', code: '12345', deviceName: 'Chrome' }),
    () => parseSmsVerifyBody({ phone: '13800138000', code: '123456' }),
    () => parseProfileBody({ nickname: 'x'.repeat(41) }),
    () => parsePhoneChangeRequestBody({ newPhoneE164: 'not-phone', deviceId: 'browser' }),
    () =>
      parsePhoneChangeVerifyBody({
        currentPhoneCode: '111111',
        newPhoneE164: '+8613900139000',
        newPhoneCode: '222222',
        operationId: 'not-uuid',
      }),
    () => parseCloseAccountBody({ code: null, operationId }),
    () => parseSessionId('not-uuid'),
  ])('rejects malformed body and path values without throwing a type error', (parse) => {
    expect(parse).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});
