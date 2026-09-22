'use client';

import { useEffect, useRef, useState } from 'react';

import type {
  StudioCreateTaskRequest,
  StudioGateway,
  StudioQuote,
  StudioTaskAccepted,
} from '../../lib/studio/types';
import { parseTaskAccepted } from '../../lib/studio/runtime';
import { createUuidV7 } from '../../lib/tasks/identifiers';

interface QuoteConfirmationProps {
  readonly quote: StudioQuote;
  readonly gateway: Pick<StudioGateway, 'createTask'>;
  readonly request: StudioCreateTaskRequest;
  readonly now?: () => number;
  readonly uuidFactory?: () => string;
  readonly onAccepted?: (task: StudioTaskAccepted) => void;
  readonly onRequote?: () => void;
}

function browserUuid(): string {
  return createUuidV7();
}

function currentTime(): number {
  return Date.now();
}

function isDefinitiveFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'outcome' in error &&
    error.outcome === 'DEFINITIVE_FAILURE'
  );
}

function formatPoints(points: string): string {
  try {
    return BigInt(points).toLocaleString('zh-CN');
  } catch {
    return points;
  }
}

function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function QuoteConfirmation({
  gateway,
  now = currentTime,
  onAccepted,
  onRequote,
  quote,
  request,
  uuidFactory = browserUuid,
}: QuoteConfirmationProps) {
  const [, refreshCountdown] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const [accepted, setAccepted] = useState<StudioTaskAccepted>();
  const pendingRef = useRef(false);
  const attemptKeyRef = useRef<string | undefined>(undefined);
  const submissionGenerationRef = useRef(0);
  const expiresAt = Date.parse(quote.expiresAt);
  const remaining = Number.isNaN(expiresAt) ? 0 : expiresAt - now();
  const expired = remaining <= 0;

  useEffect(() => {
    const timer = setInterval(() => {
      refreshCountdown((value) => value + 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    submissionGenerationRef.current += 1;
    pendingRef.current = false;
    attemptKeyRef.current = undefined;
    setSubmitting(false);
    setSubmitError(undefined);
    setUncertain(false);
    setAccepted(undefined);
  }, [
    quote.id,
    request.capabilityVersion,
    request.parameters,
    request.quoteId,
    request.quotedPoints,
  ]);

  const submit = async () => {
    if (expired || pendingRef.current || accepted) return;
    pendingRef.current = true;
    setSubmitting(true);
    setSubmitError(undefined);
    const submissionGeneration = submissionGenerationRef.current;
    const idempotencyKey = attemptKeyRef.current ?? uuidFactory();
    attemptKeyRef.current = idempotencyKey;

    try {
      const result = parseTaskAccepted(await gateway.createTask(request, { idempotencyKey }));
      if (submissionGeneration !== submissionGenerationRef.current) return;
      setAccepted(result);
      setUncertain(false);
      onAccepted?.(result);
    } catch (error) {
      if (submissionGeneration !== submissionGenerationRef.current) return;
      if (isDefinitiveFailure(error)) {
        attemptKeyRef.current = undefined;
        setUncertain(false);
        setSubmitError('任务创建已明确失败，未创建任务；你可以重新提交。');
      } else {
        setUncertain(true);
        setSubmitError('提交结果尚未确认。安全查询会复用原请求标识，不会重复创建任务。');
      }
    } finally {
      if (submissionGeneration === submissionGenerationRef.current) {
        pendingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  return (
    <section className="quote-confirmation" aria-labelledby="quote-title">
      <header>
        <div>
          <p className="section-kicker">提交前确认</p>
          <h2 id="quote-title">本次报价与任务规则</h2>
        </div>
        <div className="quote-countdown" data-expired={expired ? 'true' : undefined}>
          <span>{expired ? '报价状态' : '剩余有效期'}</span>
          <strong>{expired ? '已过期' : formatCountdown(remaining)}</strong>
        </div>
      </header>

      <div className="quote-model">
        <span>{quote.routing.kind === 'EXACT_MODEL' ? '本次模型' : '路由承诺'}</span>
        <strong>
          {quote.routing.kind === 'EXACT_MODEL' ? quote.routing.modelName : quote.routing.promise}
        </strong>
      </div>

      <div className="quote-body">
        <section aria-labelledby="parameter-summary-title">
          <h3 id="parameter-summary-title">参数摘要</h3>
          <div className="parameter-summary">
            {quote.parameterSummary.map((item) => (
              <p key={item.key}>
                {item.label} {item.value}
                {item.unit ? ` ${item.unit}` : ''}
              </p>
            ))}
          </div>
        </section>

        <section className="quoted-points" aria-label="报价点数">
          <span>预计冻结</span>
          <strong>{formatPoints(quote.quotedPoints)}</strong>
          <small>点</small>
        </section>
      </div>

      <dl className="quote-rules">
        <div>
          <dt>失败退款</dt>
          <dd>{quote.failureRefundRule}</dd>
        </div>
        <div>
          <dt>受理后取消</dt>
          <dd>{quote.cancellationRule}</dd>
        </div>
      </dl>

      {expired ? (
        <p className="quote-expired-message" role="alert">
          报价已失效，请重新报价后再创建任务。
        </p>
      ) : null}
      {submitError ? (
        <p className="form-feedback form-error" role="alert">
          {submitError}
        </p>
      ) : null}
      {accepted ? (
        <div className="form-feedback" role="status">
          <p>任务已创建，编号 {accepted.taskId}</p>
          <a href={`/tasks/${encodeURIComponent(accepted.taskId)}`}>查看任务进度</a>
        </div>
      ) : null}

      <div className="quote-actions">
        <button
          className="button-link button-primary"
          disabled={expired || submitting || Boolean(accepted)}
          type="button"
          onClick={() => void submit()}
        >
          {expired
            ? '报价已过期'
            : submitting
              ? uncertain
                ? '正在查询原提交'
                : '正在创建任务'
              : accepted
                ? '任务已创建'
                : uncertain
                  ? '安全查询原提交'
                  : '确认并创建任务'}
        </button>
        {expired && onRequote ? (
          <button className="button-link button-secondary" type="button" onClick={onRequote}>
            重新报价
          </button>
        ) : null}
      </div>
    </section>
  );
}
