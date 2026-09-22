export interface TotpProvider {
  generateSecret(): string;
  provisioningUri(label: string, secret: string): string;
  verify(
    secret: string,
    token: string,
    now: Date,
    afterTimeStep: number | null,
  ): Promise<number | null>;
}
