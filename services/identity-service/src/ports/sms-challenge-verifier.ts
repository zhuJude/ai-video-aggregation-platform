import type { VerifySmsChallengeInput } from '../application/sms-challenge.service.js';

export interface SmsChallengeVerifier {
  verify(input: VerifySmsChallengeInput): Promise<boolean>;
}
