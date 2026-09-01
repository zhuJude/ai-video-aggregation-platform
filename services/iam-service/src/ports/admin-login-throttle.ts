export interface AdminLoginAttemptPermit {
  readonly subject: string;
  readonly token: string;
}

export interface AdminLoginThrottle {
  reserve(subject: string, now: Date): Promise<AdminLoginAttemptPermit | null>;
  commitFailure(permit: AdminLoginAttemptPermit, now: Date): Promise<void>;
  commitSuccess(permit: AdminLoginAttemptPermit): Promise<void>;
  release(permit: AdminLoginAttemptPermit): Promise<void>;
}
