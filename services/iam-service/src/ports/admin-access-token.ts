export interface AdminAccessTokenClaims {
  readonly adminId: string;
  readonly sessionId: string;
  readonly issuedAt: Date;
}

export interface AdminAccessTokenIssuer {
  issue(claims: AdminAccessTokenClaims): Promise<string>;
}

export interface AdminSigningKeyProvider {
  getCurrentSigningKey(): Promise<{ readonly keyId: string; readonly signingKey: CryptoKey }>;
}
