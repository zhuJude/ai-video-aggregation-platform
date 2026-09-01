import { generateSecret, generateURI, verify } from 'otplib';

import type { TotpProvider } from '../ports/totp-provider.js';

const PERIOD_SECONDS = 30;
const WINDOW_SECONDS = 30;

export class OtplibTotpProvider implements TotpProvider {
  generateSecret(): string {
    return generateSecret({ length: 20 });
  }

  provisioningUri(label: string, secret: string): string {
    return generateURI({ issuer: 'AI Video Platform', label, secret, period: PERIOD_SECONDS });
  }

  async verify(
    secret: string,
    token: string,
    now: Date,
    afterTimeStep: number | null,
  ): Promise<number | null> {
    if (!/^\d{6}$/.test(token)) return null;
    const result = await verify({
      secret,
      token,
      period: PERIOD_SECONDS,
      epoch: Math.floor(now.getTime() / 1_000),
      epochTolerance: WINDOW_SECONDS,
      ...(afterTimeStep === null ? {} : { afterTimeStep }),
    });
    return result.valid && 'timeStep' in result ? result.timeStep : null;
  }
}
