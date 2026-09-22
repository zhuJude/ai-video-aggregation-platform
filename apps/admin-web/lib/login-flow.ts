export type PasswordStepResult = Readonly<{
  step: 'password' | 'totp';
  message: string;
  requiresPreflight?: true;
}>;

const GENERIC_PASSWORD_RESULT: PasswordStepResult = Object.freeze({
  step: 'totp',
  message: '如果凭据有效，请继续完成验证',
});

export function publicPasswordStepResult(): PasswordStepResult {
  return GENERIC_PASSWORD_RESULT;
}

export function passwordPreflightFailure(): PasswordStepResult {
  return { step: 'password', message: '无法建立安全登录，请重试' };
}

export function passwordPreflightRequired(): PasswordStepResult {
  return { ...passwordPreflightFailure(), requiresPreflight: true };
}

export type TotpValidationResult =
  Readonly<{ ok: true; code: string }> | Readonly<{ ok: false; message: string }>;

export function validateTotpInput(value: string): TotpValidationResult {
  if (!/^[0-9]{6}$/.test(value)) {
    return { ok: false, message: '请输入 6 位数字验证码' };
  }

  return { ok: true, code: value };
}
