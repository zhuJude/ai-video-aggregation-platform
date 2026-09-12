export type AccountCommandOutcome = 'DEFINITIVE_FAILURE' | 'UNCERTAIN' | 'SESSION_REFRESH_REQUIRED';

export type AccountActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly outcome: AccountCommandOutcome;
      readonly retryAfterSeconds?: number;
    };

export interface SecuritySessionView {
  readonly handle: string;
  readonly deviceName: string;
  readonly locationMasked: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly current: boolean;
}

export interface ProfileView {
  readonly nickname: string;
  readonly phoneMasked: string;
  readonly avatarPreset: 'AMBER' | 'BLUE' | 'GREEN' | 'PLUM';
  readonly updatedAt: string;
}

export interface PhoneCodeRequestResult {
  readonly cooldownSeconds: number;
  readonly message: string;
}

export interface AccountGatewayContext {
  readonly ownerId: string;
  readonly currentSessionId: string;
  readonly verifiedPhone: string;
}

export interface AccountCommandContext extends AccountGatewayContext {
  readonly idempotencyKey: string;
}

export interface AccountGateway {
  getProfile(context: AccountGatewayContext): Promise<unknown>;
  updateProfile(
    input: { readonly nickname: string; readonly avatarPreset: ProfileView['avatarPreset'] },
    context: AccountCommandContext,
  ): Promise<unknown>;
  listSessions(context: AccountGatewayContext): Promise<unknown>;
  revokeSession(handle: string, context: AccountCommandContext): Promise<unknown>;
  exitAll(context: AccountCommandContext): Promise<unknown>;
  requestPhoneChangeCodes(
    input: { readonly newPhoneE164: string; readonly deviceId: string },
    context: AccountCommandContext,
  ): Promise<unknown>;
  verifyPhoneChange(
    input: {
      readonly currentPhoneCode: string;
      readonly newPhoneE164: string;
      readonly newPhoneCode: string;
      readonly operationId: string;
    },
    context: AccountCommandContext,
  ): Promise<unknown>;
  closeAccount(
    input: { readonly code: string; readonly operationId: string },
    context: AccountCommandContext,
  ): Promise<unknown>;
}
