export interface PasswordVerification {
  readonly valid: boolean;
  readonly needsRehash: boolean;
}

export interface PasswordHasher {
  isPolicyDigest(digest: string): boolean;
  hash(password: string): Promise<string>;
  verify(digest: string, password: string): Promise<PasswordVerification>;
}
