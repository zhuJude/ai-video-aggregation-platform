import { z } from 'zod';

export const UuidSchema = z.uuid();
export const UtcDateTimeSchema = z.iso.datetime({ offset: true });
export const PointsStringSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const MinorAmountSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const CurrencySchema = z.literal('CNY');

export type PointsString = z.infer<typeof PointsStringSchema>;
