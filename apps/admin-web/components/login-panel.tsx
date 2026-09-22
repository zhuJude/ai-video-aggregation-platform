'use client';

import {
  Button,
  Card,
  Field,
  FluentProvider,
  Input,
  Text,
  Title1,
  makeStyles,
  mergeClasses,
  tokens,
  webLightTheme,
} from '@fluentui/react-components';
import { LockClosed24Regular, ShieldKeyhole24Regular } from '@fluentui/react-icons';
import { useActionState, useEffect, useRef, useState } from 'react';

import type { TotpActionResult } from '../lib/admin-auth-actions';
import type { PasswordStepResult } from '../lib/login-flow';

export type LoginPanelProps = Readonly<{
  preflightAction: (identifier: string) => Promise<Readonly<{ status: 'READY' | 'ERROR' }>>;
  passwordAction: (
    previousState: PasswordStepResult | null,
    formData: FormData,
  ) => Promise<PasswordStepResult>;
  totpAction: (
    previousState: TotpActionResult | null,
    formData: FormData,
  ) => Promise<TotpActionResult>;
}>;

const useStyles = makeStyles({
  root: {
    minHeight: '100vh',
    backgroundColor: '#071726',
    color: '#ffffff',
    display: 'grid',
    gridTemplateColumns: 'minmax(280px, 0.9fr) minmax(360px, 1.1fr)',
    '@media (max-width: 760px)': {
      gridTemplateColumns: '1fr',
    },
  },
  identity: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    minHeight: 'calc(100vh - 80px)',
    padding: '40px',
    backgroundColor: '#0b2740',
    borderRight: '1px solid #2a4f6e',
    '@media (max-width: 760px)': {
      minHeight: 'auto',
      padding: '24px',
      borderRightStyle: 'none',
      borderBottom: '1px solid #2a4f6e',
    },
  },
  identityKicker: {
    color: '#9dc7e8',
    letterSpacing: '0.08em',
  },
  identityTitle: {
    color: '#ffffff',
    marginTop: '10px',
    marginBottom: '12px',
  },
  identityCopy: {
    color: '#cfdeea',
    maxWidth: '420px',
    lineHeight: tokens.lineHeightBase400,
  },
  domain: {
    color: '#9dc7e8',
    fontFamily: 'Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
  },
  formRegion: {
    display: 'grid',
    placeItems: 'center',
    padding: '32px',
    backgroundColor: tokens.colorNeutralBackground2,
    '@media (max-width: 760px)': {
      padding: '24px 16px',
    },
  },
  card: {
    width: 'min(100%, 420px)',
    padding: '28px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow8,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  heading: {
    marginBottom: '2px',
  },
  supportingCopy: {
    color: tokens.colorNeutralForeground2,
    lineHeight: tokens.lineHeightBase300,
    marginBottom: '6px',
  },
  status: {
    display: 'block',
    padding: '10px 12px',
    marginBottom: '4px',
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground3,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
  },
  errorStatus: {
    color: tokens.colorPaletteRedForeground1,
    backgroundColor: tokens.colorPaletteRedBackground1,
    borderLeftColor: tokens.colorPaletteRedBorder1,
  },
  submit: {
    marginTop: '4px',
  },
});

export function LoginPanel({ passwordAction, preflightAction, totpAction }: LoginPanelProps) {
  const styles = useStyles();
  const [passwordState, passwordFormAction, passwordPending] = useActionState(passwordAction, null);
  const [totpState, totpFormAction, totpPending] = useActionState(totpAction, null);
  const [remainingCooldown, setRemainingCooldown] = useState(0);
  const [identifier, setIdentifier] = useState('');
  const [readyIdentifier, setReadyIdentifier] = useState<string | null>(null);
  const [preflightPending, setPreflightPending] = useState(false);
  const [preflightError, setPreflightError] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const generationRef = useRef(0);
  const identifierRef = useRef('');
  const pendingRef = useRef(false);
  const queuedGenerationRef = useRef<number | null>(null);
  const step = passwordState?.step ?? 'password';
  const normalizedIdentifier = identifier.trim();
  const preflightReady =
    readyIdentifier === normalizedIdentifier && normalizedIdentifier.length > 0;

  function startPreflight(generation: number, snapshot: string): void {
    if (!snapshot) {
      setPreflightPending(false);
      return;
    }
    if (pendingRef.current) {
      queuedGenerationRef.current = generation;
      return;
    }
    pendingRef.current = true;
    setPreflightPending(true);
    setPreflightError(false);
    void preflightAction(snapshot)
      .then((result) => {
        if (generation !== generationRef.current || snapshot !== identifierRef.current) return;
        setReadyIdentifier(result.status === 'READY' ? snapshot : null);
        setPreflightError(result.status !== 'READY');
        if (result.status === 'READY') setRecoveryRequired(false);
      })
      .catch(() => {
        if (generation !== generationRef.current || snapshot !== identifierRef.current) return;
        setReadyIdentifier(null);
        setPreflightError(true);
      })
      .finally(() => {
        pendingRef.current = false;
        const queuedGeneration = queuedGenerationRef.current;
        queuedGenerationRef.current = null;
        if (queuedGeneration !== null && queuedGeneration === generationRef.current) {
          startPreflight(queuedGeneration, identifierRef.current);
          return;
        }
        if (generation === generationRef.current) setPreflightPending(false);
      });
  }

  useEffect(() => {
    setRemainingCooldown(totpState?.status === 'LOCKED' ? totpState.cooldownSeconds : 0);
  }, [totpState]);

  useEffect(() => {
    if (totpState?.status === 'AUTHENTICATED') {
      window.location.assign(totpState.redirectTo);
    }
  }, [totpState]);

  useEffect(() => {
    if (!passwordState?.requiresPreflight) return;
    generationRef.current += 1;
    queuedGenerationRef.current = pendingRef.current ? generationRef.current : null;
    setReadyIdentifier(null);
    setRecoveryRequired(true);
  }, [passwordState]);

  useEffect(() => {
    if (remainingCooldown <= 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      setRemainingCooldown((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [remainingCooldown]);

  const isLocked = remainingCooldown > 0;

  return (
    <FluentProvider theme={webLightTheme}>
      <div className={styles.root}>
        <section className={styles.identity} aria-labelledby="admin-brand-heading">
          <div>
            <Text className={styles.identityKicker} weight="semibold">
              ADMIN OPERATIONS
            </Text>
            <Title1 className={styles.identityTitle} id="admin-brand-heading">
              镜界运营控制台
            </Title1>
            <Text block className={styles.identityCopy}>
              用于风险操作、资金核对与系统治理的独立管理域。
            </Text>
          </div>
          <Text className={styles.domain}>admin.ai-video.internal</Text>
        </section>

        <main className={styles.formRegion}>
          <Card className={styles.card}>
            {step === 'password' ? (
              <form
                action={passwordFormAction}
                className={styles.form}
                onSubmit={(event) => {
                  if (
                    !preflightReady ||
                    pendingRef.current ||
                    readyIdentifier !== identifierRef.current
                  )
                    event.preventDefault();
                }}
              >
                <LockClosed24Regular aria-hidden />
                <Title1 className={styles.heading}>管理员登录</Title1>
                <Text className={styles.supportingCopy}>
                  使用独立管理员账号。系统不会透露账户是否存在。
                </Text>
                <Field label="管理员账号" required>
                  <Input
                    aria-label="管理员账号"
                    autoComplete="username"
                    onChange={(_event, data) => {
                      setIdentifier(data.value);
                      const nextIdentifier = data.value.trim();
                      identifierRef.current = nextIdentifier;
                      generationRef.current += 1;
                      setReadyIdentifier(null);
                      setPreflightError(false);
                      setRecoveryRequired(false);
                      if (pendingRef.current) queuedGenerationRef.current = generationRef.current;
                    }}
                    required
                    value={identifier}
                  />
                </Field>
                <input name="identifier" type="hidden" value={normalizedIdentifier} />
                <Field label="密码" required>
                  <Input
                    aria-label="密码"
                    autoComplete="current-password"
                    name="password"
                    required
                    type="password"
                  />
                </Field>
                {preflightError ? (
                  <Text className={mergeClasses(styles.status, styles.errorStatus)} role="alert">
                    无法建立安全登录，请重试
                  </Text>
                ) : null}
                {passwordState?.step === 'password' ? (
                  <Text className={mergeClasses(styles.status, styles.errorStatus)} role="alert">
                    {passwordState.message}
                  </Text>
                ) : null}
                <Button
                  appearance="primary"
                  className={styles.submit}
                  disabled={passwordPending || preflightPending}
                  onClick={
                    preflightReady
                      ? undefined
                      : () => {
                          if (!normalizedIdentifier || pendingRef.current) return;
                          startPreflight(generationRef.current, normalizedIdentifier);
                        }
                  }
                  type={preflightReady ? 'submit' : 'button'}
                >
                  {preflightPending
                    ? '正在建立安全登录'
                    : preflightReady
                      ? '继续验证'
                      : recoveryRequired
                        ? '重新建立安全登录'
                        : '准备安全登录'}
                </Button>
              </form>
            ) : (
              <form action={totpFormAction} className={styles.form}>
                <ShieldKeyhole24Regular aria-hidden />
                <Title1 className={styles.heading}>双因素验证</Title1>
                <Text className={styles.supportingCopy}>请输入身份验证器中的 6 位动态验证码。</Text>
                {passwordState?.message ? (
                  <Text className={styles.status} role="status">
                    {passwordState.message}
                  </Text>
                ) : null}
                {isLocked ? (
                  <Text className={`${styles.status} ${styles.errorStatus}`} role="alert">
                    请在 {remainingCooldown} 秒后重试
                  </Text>
                ) : null}
                {totpState?.status === 'INVALID_TOTP' ? (
                  <Text className={mergeClasses(styles.status, styles.errorStatus)} role="alert">
                    {totpState.message}
                  </Text>
                ) : null}
                <Field label="六位验证码" required>
                  <Input
                    aria-label="六位验证码"
                    autoComplete="one-time-code"
                    disabled={isLocked}
                    inputMode="numeric"
                    maxLength={6}
                    name="totp"
                    pattern="[0-9]{6}"
                    required
                  />
                </Field>
                <Button
                  appearance="primary"
                  className={styles.submit}
                  disabled={isLocked || totpPending}
                  type="submit"
                >
                  验证并登录
                </Button>
              </form>
            )}
          </Card>
        </main>
      </div>
    </FluentProvider>
  );
}
