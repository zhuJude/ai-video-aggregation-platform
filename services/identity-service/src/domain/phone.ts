const INVALID_PHONE = 'INVALID_PHONE';

export class Phone {
  private constructor(readonly e164: string) {}

  static parse(input: string): Phone {
    const digits = input.replace(/[\s-]/g, '');

    if (!/^1[3-9]\d{9}$/.test(digits)) {
      throw Object.assign(new Error(INVALID_PHONE), { code: INVALID_PHONE });
    }

    return new Phone(`+86${digits}`);
  }

  masked(): string {
    return `${this.e164.slice(0, 6)}****${this.e164.slice(-4)}`;
  }
}
