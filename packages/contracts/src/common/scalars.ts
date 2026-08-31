import { z } from 'zod';

export const UuidSchema = z.uuidv7();
export const UtcDateTimeSchema = z.iso.datetime();
export const PointsStringSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const MinorAmountSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const CurrencySchema = z.literal('CNY');

export type PointsString = z.infer<typeof PointsStringSchema>;
