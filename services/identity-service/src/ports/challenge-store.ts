export interface ChallengeRecord {
  codeDigest: string;
  issuedAtMs: number;
  expiresAtMs: number;
  failedAttempts: number;
}

export interface RateLimitRule {
  key: string;
  limit: number;
  windowMs: number;
}

export interface ChallengeIssue {
  phoneHash: string;
  nowMs: number;
  record: ChallengeRecord;
  rateLimits: RateLimitRule[];
}

export type ChallengeIssueResult = 'issued' | 'rate_limited';

export interface ChallengeVerification {
  phoneHash: string;
  codeDigest: string;
  nowMs: number;
  maxAttempts: number;
}

export type ChallengeVerificationResult = 'verified' | 'invalid' | 'missing' | 'expired' | 'locked';

export interface ChallengeRemoval {
  phoneHash: string;
  codeDigest: string;
  issuedAtMs: number;
}

export interface ChallengeStore {
  issue(input: ChallengeIssue): Promise<ChallengeIssueResult>;
  verify(input: ChallengeVerification): Promise<ChallengeVerificationResult>;
  remove(input: ChallengeRemoval): Promise<void>;
}
