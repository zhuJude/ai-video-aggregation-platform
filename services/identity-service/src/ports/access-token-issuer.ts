export interface AccessTokenClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly issuedAt: Date;
}

export interface AccessTokenIssuer {
  issue(claims: AccessTokenClaims): Promise<string>;
}
