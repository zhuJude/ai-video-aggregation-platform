'use client';

import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Select,
  Text,
} from '@fluentui/react-components';
import { useEffect, useRef, useState } from 'react';
import { isPointsString, isUtcIso8601Z } from '../lib/frozen-scalars';
import type {
  WalletAdjustmentDirection,
  WalletAdjustmentPreview,
} from '../lib/user-operation-actions';
import { createUuidV7 } from '../lib/uuid-v7';

export type AdjustmentRequestDraft = Readonly<{
  approverId: string;
  currentActorId: string;
  direction: string;
  points: string;
  reason: string;
}>;

export type AdjustmentValidation =
  | Readonly<{ direction: WalletAdjustmentDirection; ok: true; points: bigint }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

const MAX_REASON_LENGTH = 200;

export function validateAdjustmentRequest(draft: AdjustmentRequestDraft): AdjustmentValidation {
  const errors: string[] = [];
  const reason = draft.reason.trim();
  if (!reason) {
    errors.push('请填写调整原因');
  } else if (reason.length > MAX_REASON_LENGTH) {
    errors.push('调整原因不得超过 200 个字符');
  }
  if (draft.direction !== 'CREDIT' && draft.direction !== 'DEBIT') {
    errors.push('请选择调整方向');
  }
  if (!isPointsString(draft.points) || draft.points === '0') {
    errors.push('调整点数格式无效');
  }
  if (!draft.approverId) {
    errors.push('请选择复核人');
  } else if (draft.approverId === draft.currentActorId) {
    errors.push('复核人不得与申请人相同');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    direction: draft.direction as WalletAdjustmentDirection,
    ok: true,
    points: BigInt(draft.points),
  };
}

export type AdjustmentDialogProps = Readonly<{
  currentActorId?: string;
  eligibleApprovers?: readonly Readonly<{ displayName: string; id: string }>[];
  onOpenChange?: (open: boolean) => void;
  onPreview: (formData: FormData) => Promise<WalletAdjustmentPreview>;
  onRequest: (
    formData: FormData,
  ) => Promise<
    Readonly<{ auditRecordId: string; ok: true; requestId: string; status: 'PENDING_APPROVAL' }>
  >;
  open?: boolean;
  userId: string;
}>;

export function AdjustmentDialog({
  currentActorId = '',
  eligibleApprovers,
  onOpenChange,
  onPreview,
  onRequest,
  open = true,
  userId,
}: AdjustmentDialogProps) {
  const [direction, setDirection] = useState('');
  const [points, setPoints] = useState('');
  const [approverId, setApproverId] = useState('');
  const [reason, setReason] = useState('');
  const [highRiskConfirmed, setHighRiskConfirmed] = useState(false);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [preview, setPreview] = useState<WalletAdjustmentPreview>();
  const [outcome, setOutcome] = useState<Readonly<{ auditRecordId: string; requestId: string }>>();
  const [pending, setPending] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [intentId, setIntentId] = useState(() => createUuidV7());
  const [previewIntentId, setPreviewIntentId] = useState(() => createUuidV7());
  const pendingRef = useRef(false);
  const previewPendingRef = useRef(false);
  const previewIntentRef = useRef(previewIntentId);
  const previewIsCurrent = Boolean(
    preview && isUtcIso8601Z(preview.expiresAt) && Date.parse(preview.expiresAt) > Date.now(),
  );
  const pointsError = errors.find((error) => error === '调整点数格式无效');
  const directionError = errors.find((error) => error === '请选择调整方向');
  const reasonError = errors.find(
    (error) => error.startsWith('请填写调整原因') || error.startsWith('调整原因不得'),
  );
  const approverError = errors.find(
    (error) => error === '请选择复核人' || error.startsWith('复核人不得'),
  );
  function clearPreview() {
    const nextPreviewIntent = createUuidV7();
    previewIntentRef.current = nextPreviewIntent;
    setPreviewIntentId(nextPreviewIntent);
    setPreview(undefined);
    setHighRiskConfirmed(false);
    setOutcome(undefined);
    setIntentId(createUuidV7());
  }

  function resetDialogState() {
    const nextPreviewIntent = createUuidV7();
    previewIntentRef.current = nextPreviewIntent;
    pendingRef.current = false;
    previewPendingRef.current = false;
    setApproverId('');
    setDirection('');
    setErrors([]);
    setHighRiskConfirmed(false);
    setIntentId(createUuidV7());
    setOutcome(undefined);
    setPending(false);
    setPoints('');
    setPreview(undefined);
    setPreviewIntentId(nextPreviewIntent);
    setPreviewPending(false);
    setReason('');
  }

  function closeDialog() {
    if (pendingRef.current || previewPendingRef.current) return;
    resetDialogState();
    onOpenChange?.(false);
  }

  useEffect(() => {
    const nextPreviewIntent = createUuidV7();
    previewIntentRef.current = nextPreviewIntent;
    setPreviewIntentId(nextPreviewIntent);
    setPreview(undefined);
    setHighRiskConfirmed(false);
    setOutcome(undefined);
    setIntentId(createUuidV7());
  }, [userId]);

  async function submit() {
    if (pendingRef.current || outcome) return;
    const validation = validateAdjustmentRequest({
      approverId,
      currentActorId,
      direction,
      points,
      reason,
    });
    const nextErrors = validation.ok ? [] : [...validation.errors];
    if (
      validation.ok &&
      eligibleApprovers !== undefined &&
      !eligibleApprovers.some((approver) => approver.id === approverId)
    ) {
      nextErrors.push('复核人无效');
    }
    if (nextErrors.length > 0) {
      setErrors(nextErrors);
      return;
    }
    if (!preview) {
      setErrors(['请先获取权威预览']);
      return;
    }
    if (!isUtcIso8601Z(preview.expiresAt) || Date.parse(preview.expiresAt) <= Date.now()) {
      setPreview(undefined);
      setHighRiskConfirmed(false);
      setErrors(['预览已过期，请重新获取权威预览']);
      return;
    }
    if (!highRiskConfirmed) {
      setErrors(['请确认该申请将进入双人审批流程']);
      return;
    }
    const form = new FormData();
    form.set('userId', userId);
    form.set('direction', direction);
    form.set('points', points);
    form.set('approverId', approverId);
    form.set('reason', reason.trim());
    form.set('highRiskConfirmed', 'true');
    form.set('previewToken', preview.previewToken);
    form.set('intentId', intentId);
    pendingRef.current = true;
    setPending(true);
    try {
      const result = await onRequest(form);
      setOutcome({ auditRecordId: result.auditRecordId, requestId: result.requestId });
      setErrors([]);
    } catch {
      setOutcome(undefined);
      setErrors(['调整申请被拒绝或暂时不可用']);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function requestPreview() {
    if (previewPendingRef.current || outcome) return;
    const validation = validateAdjustmentRequest({
      approverId,
      currentActorId,
      direction,
      points,
      reason,
    });
    const nextErrors =
      validation.ok &&
      eligibleApprovers !== undefined &&
      !eligibleApprovers.some((approver) => approver.id === approverId)
        ? ['复核人无效']
        : validation.ok
          ? []
          : validation.errors;
    if (nextErrors.length > 0) {
      setErrors(nextErrors);
      return;
    }
    const submittedIntent = previewIntentId;
    const form = new FormData();
    form.set('userId', userId);
    form.set('direction', direction);
    form.set('points', points);
    form.set('approverId', approverId);
    form.set('reason', reason.trim());
    form.set('previewIntentId', submittedIntent);
    previewPendingRef.current = true;
    setPreviewPending(true);
    try {
      const result = await onPreview(form);
      if (previewIntentRef.current === submittedIntent) {
        setPreview(result);
        setHighRiskConfirmed(false);
        setErrors([]);
      }
    } catch {
      if (previewIntentRef.current === submittedIntent) setErrors(['权威预览不可用或已被拒绝']);
    } finally {
      previewPendingRef.current = false;
      setPreviewPending(false);
    }
  }

  return (
    <Dialog
      modalType="modal"
      open={open}
      onOpenChange={(_event, data) => {
        if (!data.open) closeDialog();
      }}
    >
      <DialogSurface aria-describedby="adjustment-impact">
        <DialogBody>
          <DialogTitle>申请调整点数</DialogTitle>
          <DialogContent>
            <Text id="adjustment-impact">
              此操作只创建申请，不会直接修改余额。请明确选择入账或扣减，点数仅接受正整数，需由不同管理员复核。
            </Text>
            <Field
              label="调整方向"
              {...(directionError ? { validationMessage: directionError } : {})}
            >
              <Select
                aria-label="调整方向"
                disabled={pending || previewPending || Boolean(outcome)}
                value={direction}
                onChange={(_event, data) => {
                  if (data.value !== direction) {
                    setDirection(data.value);
                    clearPreview();
                  }
                }}
              >
                <option value="">请选择调整方向</option>
                <option value="CREDIT">入账（CREDIT）</option>
                <option value="DEBIT">扣减（DEBIT）</option>
              </Select>
            </Field>
            <Field label="调整点数" {...(pointsError ? { validationMessage: pointsError } : {})}>
              <Input
                aria-label="调整点数"
                disabled={pending || previewPending || Boolean(outcome)}
                value={points}
                onChange={(_event, data) => {
                  if (data.value !== points) {
                    setPoints(data.value);
                    clearPreview();
                  }
                }}
              />
            </Field>
            <Field label="调整原因" {...(reasonError ? { validationMessage: reasonError } : {})}>
              <Input
                aria-label="调整原因"
                disabled={pending || previewPending || Boolean(outcome)}
                maxLength={MAX_REASON_LENGTH}
                value={reason}
                onChange={(_event, data) => {
                  if (data.value !== reason) {
                    setReason(data.value);
                    clearPreview();
                  }
                }}
              />
            </Field>
            <Field label="复核人" {...(approverError ? { validationMessage: approverError } : {})}>
              {eligibleApprovers === undefined ? (
                <Input
                  aria-label="复核人"
                  disabled={pending || previewPending || Boolean(outcome)}
                  value={approverId}
                  onChange={(_event, data) => {
                    if (data.value !== approverId) {
                      setApproverId(data.value);
                      clearPreview();
                    }
                  }}
                />
              ) : (
                <Select
                  aria-label="复核人"
                  disabled={pending || previewPending || Boolean(outcome)}
                  value={approverId}
                  onChange={(_event, data) => {
                    if (data.value !== approverId) {
                      setApproverId(data.value);
                      clearPreview();
                    }
                  }}
                >
                  <option value="">请选择复核人</option>
                  {eligibleApprovers.map((approver) => (
                    <option key={approver.id} value={approver.id}>
                      {approver.displayName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {preview ? (
              <Text>
                调整前：{preview.before}；方向：{preview.direction}；点数：{preview.points}
                ；调整后：{preview.after}；影响：{preview.impact}；策略：{preview.policy}
                ；预览到期：{preview.expiresAt}
              </Text>
            ) : null}
            <Checkbox
              checked={highRiskConfirmed}
              disabled={pending || previewPending || Boolean(outcome) || !previewIsCurrent}
              label="我已核对影响范围，并确认提交双人审批申请"
              onChange={(_event, data) => {
                setHighRiskConfirmed(Boolean(data.checked));
              }}
            />
            {errors.includes('请确认该申请将进入双人审批流程') ? (
              <Text role="alert">请确认该申请将进入双人审批流程</Text>
            ) : null}
            {errors.includes('预览已过期，请重新获取权威预览') ? (
              <Text role="alert">预览已过期，请重新获取权威预览</Text>
            ) : null}
            {errors.includes('权威预览不可用或已被拒绝') ? (
              <Text role="alert">权威预览不可用或已被拒绝</Text>
            ) : null}
            {errors.includes('调整申请被拒绝或暂时不可用') ? (
              <Text role="alert">调整申请被拒绝或暂时不可用</Text>
            ) : null}
            {outcome ? (
              <Text role="status">
                申请待审批：请求 {outcome.requestId}；审计 {outcome.auditRecordId}
              </Text>
            ) : null}
          </DialogContent>
          <DialogActions>
            {outcome ? (
              <Button appearance="primary" onClick={closeDialog}>
                完成并关闭
              </Button>
            ) : (
              <>
                <Button disabled={pending || previewPending} onClick={closeDialog}>
                  取消
                </Button>
                <Button
                  disabled={pending || previewPending}
                  onClick={() => {
                    void requestPreview();
                  }}
                >
                  获取权威预览
                </Button>
                <Button
                  appearance="primary"
                  disabled={pending || previewPending}
                  onClick={() => {
                    void submit();
                  }}
                >
                  提交申请
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
