import { Phone } from '../domain/phone.js';
import { isUuidV7 } from '../domain/uuid-v7.js';

const SMS_CODE = /^\d{6}$/;
const DEVICE_ID = /^[a-zA-Z0-9._:-]{1,128}$/;

export function parseSmsRequestBody(input: unknown): {
  readonly phone: string;
  readonly deviceId: string;
} {
  const body = record(input);
  return {
    phone: domesticPhone(body['phone']),
    deviceId: matchingString(body['deviceId'], DEVICE_ID),
  };
}

export function parseSmsVerifyBody(input: unknown): {
  readonly phone: string;
  readonly code: string;
  readonly deviceName: string;
} {
  const body = record(input);
  return {
    phone: domesticPhone(body['phone']),
    code: matchingString(body['code'], SMS_CODE),
    deviceName: boundedString(body['deviceName'], 1, 120),
  };
}

export function parseProfileBody(input: unknown): { readonly nickname: string } {
  const body = record(input);
  return { nickname: boundedString(body['nickname'], 1, 40) };
}

export function parsePhoneChangeRequestBody(input: unknown): {
  readonly newPhoneE164: string;
  readonly deviceId: string;
} {
  const body = record(input);
  return {
    newPhoneE164: normalizedPhone(body['newPhoneE164']),
    deviceId: matchingString(body['deviceId'], DEVICE_ID),
  };
}

export function parsePhoneChangeVerifyBody(input: unknown): {
  readonly currentPhoneCode: string;
  readonly newPhoneE164: string;
  readonly newPhoneCode: string;
  readonly operationId: string;
} {
  const body = record(input);
  return {
    currentPhoneCode: matchingString(body['currentPhoneCode'], SMS_CODE),
    newPhoneE164: normalizedPhone(body['newPhoneE164']),
    newPhoneCode: matchingString(body['newPhoneCode'], SMS_CODE),
    operationId: uuidV7(body['operationId']),
  };
}

export function parseCloseAccountBody(input: unknown): {
  readonly code: string;
  readonly operationId: string;
} {
  const body = record(input);
  return {
    code: matchingString(body['code'], SMS_CODE),
    operationId: uuidV7(body['operationId']),
  };
}

export function parseSessionId(input: unknown): string {
  return uuidV7(input);
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidRequest();
  return input as Record<string, unknown>;
}

function domesticPhone(input: unknown): string {
  if (typeof input !== 'string' || !/^1[3-9]\d{9}$/.test(input)) throw invalidRequest();
  return input;
}

function normalizedPhone(input: unknown): string {
  if (typeof input !== 'string') throw invalidRequest();
  const trimmed = input.trim();
  const domestic = trimmed.startsWith('+86') ? trimmed.slice(3) : trimmed;
  if (!/^1[3-9]\d{9}$/.test(domestic)) throw invalidRequest();
  return Phone.parse(domestic).e164;
}

function matchingString(input: unknown, pattern: RegExp): string {
  if (typeof input !== 'string' || !pattern.test(input)) throw invalidRequest();
  return input;
}

function boundedString(input: unknown, min: number, max: number): string {
  if (typeof input !== 'string') throw invalidRequest();
  const value = input.trim();
  if (value.length < min || value.length > max) throw invalidRequest();
  return value;
}

function uuidV7(input: unknown): string {
  if (typeof input !== 'string' || !isUuidV7(input)) throw invalidRequest();
  return input;
}

function invalidRequest(): Error & { code: 'INVALID_REQUEST' } {
  return Object.assign(new Error('INVALID_REQUEST'), { code: 'INVALID_REQUEST' as const });
}
