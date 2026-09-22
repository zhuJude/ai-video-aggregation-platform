export interface ChallengeSecretProvider {
  getSecret(kmsKeyReference: string): Promise<Uint8Array>;
}

export interface ChallengeCodeHasher {
  hash(phoneHash: string, code: string): Promise<string>;
}
