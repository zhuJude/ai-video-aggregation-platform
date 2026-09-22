export interface SecretCipher {
  encrypt(adminId: string, plaintext: string): Promise<string>;
  decrypt(adminId: string, envelope: string): Promise<string>;
}
