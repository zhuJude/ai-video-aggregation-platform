'use client';

import Link from 'next/link';
import { useState } from 'react';

import { completeUploadAction, createUploadSessionAction } from '../../app/commerce-actions';
import {
  changeTicketStatusAction,
  createTicketAction,
  replyTicketAction,
  submitFeedbackAction,
  submitTicketSatisfactionAction,
} from '../../app/support-actions';
import { runCommerceActionWithRefresh } from '../../lib/commerce/client-command';
import { uploadAssetBytesWithSessionRefresh } from '../../lib/commerce/upload-client';
import { runSupportActionWithRefresh } from '../../lib/support/client-command';
import { formatSupportDate } from '../../lib/support/runtime';
import { createUuidV7 } from '../../lib/tasks/identifiers';
import type {
  FeedbackKind,
  SupportActionResult,
  TicketPage,
  TicketView,
} from '../../lib/support/types';
import type { AssetListItem } from '../../lib/commerce/types';
import { AccessibleDialog } from '../commerce/accessible-dialog';

const statusLabel: Record<string, string> = {
  OPEN: '待处理',
  IN_PROGRESS: '处理中',
  WAITING_USER: '待你回复',
  RESOLVED: '已解决',
  CLOSED: '已关闭',
};
const categoryLabel: Record<TicketView['category'], string> = {
  TASK: '任务问题',
  PAYMENT: '支付问题',
  ACCOUNT: '账号问题',
  SUGGESTION: '意见建议',
  OTHER: '其他',
};

export function TicketCenter({
  initial,
  onCreateTicket,
}: {
  readonly initial: TicketPage;
  readonly onCreateTicket?: (
    input: {
      subject: string;
      category: TicketView['category'];
      body: string;
      attachmentIds: readonly string[];
    },
    key: string,
  ) => Promise<SupportActionResult<TicketView>>;
}) {
  const [items, setItems] = useState(initial.items);
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<TicketView['category']>('TASK');
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<readonly AssetListItem[]>([]);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string>();
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const create = async () => {
    if (pending || uncertain) return;
    const normalizedSubject = subject.trim();
    const normalizedBody = body.trim();
    if (
      normalizedSubject.length < 4 ||
      normalizedSubject.length > 120 ||
      normalizedBody.length < 10 ||
      normalizedBody.length > 4_000
    ) {
      setError('标题须为 4–120 字，问题描述须为 10–4000 字。');
      return;
    }
    setPending(true);
    setError(undefined);
    const key = createUuidV7();
    const input = {
      subject: normalizedSubject,
      category,
      body: normalizedBody,
      attachmentIds: attachments.map(({ id }) => id),
    };
    const result = onCreateTicket
      ? await onCreateTicket(input, key)
      : await runSupportActionWithRefresh(key, (sameKey) => createTicketAction(input, sameKey));
    setPending(false);
    if (result.ok) {
      setItems((current) => [result.data, ...current]);
      setOpen(false);
      setSubject('');
      setBody('');
      setAttachments([]);
    } else if (result.outcome === 'UNCERTAIN') {
      setUncertain(true);
      setError('提交结果待确认。请先刷新工单列表核对，避免重复创建。');
    } else {
      setError('工单未提交，请检查内容和附件。');
    }
  };

  return (
    <section className="support-panel" aria-labelledby="tickets-title">
      <div className="settings-heading">
        <div>
          <p className="section-kicker">客户支持</p>
          <h1 id="tickets-title">我的工单</h1>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
        >
          创建新工单
        </button>
        <button
          type="button"
          onClick={() => {
            setFeedbackOpen(true);
          }}
        >
          提交产品反馈
        </button>
      </div>
      {items.length === 0 ? (
        <div className="commerce-empty" role="status">
          <h2>暂无工单</h2>
          <p>遇到任务、支付或账号问题时可创建工单。</p>
        </div>
      ) : (
        <div className="ticket-list">
          {items.map((ticket) => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              onChange={(next) => {
                setItems((current) => current.map((item) => (item.id === next.id ? next : item)));
              }}
            />
          ))}
        </div>
      )}
      {open ? (
        <AccessibleDialog
          labelledBy="new-ticket-title"
          onClose={() => {
            if (!pending) setOpen(false);
          }}
          busy={pending}
        >
          <h2 id="new-ticket-title">创建新工单</h2>
          <div className="settings-form">
            <label htmlFor="ticket-subject">工单标题</label>
            <input
              id="ticket-subject"
              value={subject}
              maxLength={120}
              minLength={4}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'ticket-create-error' : undefined}
              onChange={(event) => {
                setSubject(event.target.value);
              }}
            />
            <label htmlFor="ticket-category">问题类型</label>
            <select
              id="ticket-category"
              value={category}
              onChange={(event) => {
                setCategory(event.target.value as TicketView['category']);
              }}
            >
              {Object.entries(categoryLabel).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <label htmlFor="ticket-body">问题描述</label>
            <textarea
              id="ticket-body"
              value={body}
              maxLength={4_000}
              rows={5}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'ticket-create-error' : undefined}
              onChange={(event) => {
                setBody(event.target.value);
              }}
            />
            <AttachmentPicker
              id="new-ticket-attachments"
              items={attachments}
              onChange={setAttachments}
              disabled={pending || uncertain}
            />
          </div>
          {error ? (
            <p id="ticket-create-error" role="alert">
              {error}
            </p>
          ) : null}
          {uncertain ? <Link href="/tickets">刷新工单列表核对</Link> : null}
          <div className="dialog-actions">
            <button type="button" disabled={pending || uncertain} onClick={() => void create()}>
              {pending ? '正在提交…' : '提交工单'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setOpen(false);
              }}
            >
              取消
            </button>
          </div>
        </AccessibleDialog>
      ) : null}
      {feedbackOpen ? (
        <FeedbackDialog
          onClose={() => {
            setFeedbackOpen(false);
          }}
        />
      ) : null}
    </section>
  );
}

function TicketCard({
  ticket,
  onChange,
}: {
  readonly ticket: TicketView;
  readonly onChange: (ticket: TicketView) => void;
}) {
  const [reply, setReply] = useState('');
  const [attachments, setAttachments] = useState<readonly AssetListItem[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [ratingOpen, setRatingOpen] = useState(false);
  const run = async (operation: (key: string) => Promise<SupportActionResult<TicketView>>) => {
    if (pending) return false;
    setPending(true);
    setError(undefined);
    const key = createUuidV7();
    const result = await runSupportActionWithRefresh(key, operation);
    setPending(false);
    if (result.ok) {
      onChange(result.data);
      return true;
    }
    setError(
      result.outcome === 'UNCERTAIN' ? '结果待确认，请刷新后核对。' : '操作失败，请稍后重试。',
    );
    return false;
  };
  return (
    <article className="ticket-card">
      <header>
        <div>
          <span className="status-chip">{statusLabel[ticket.status] ?? ticket.status}</span>
          <h2>{ticket.subject}</h2>
        </div>
        <time dateTime={ticket.updatedAt}>{formatSupportDate(ticket.updatedAt)}</time>
      </header>
      <ol className="ticket-history" aria-label="状态历史">
        {ticket.statusHistory.map((entry, index) => (
          <li key={`${entry.occurredAt}-${String(index)}`}>
            <strong>{entry.label}</strong>
            <time dateTime={entry.occurredAt}>{formatSupportDate(entry.occurredAt)}</time>
          </li>
        ))}
      </ol>
      <div className="ticket-replies">
        {ticket.replies.map((entry) => (
          <article key={entry.id}>
            <strong>{entry.author === 'USER' ? '你' : '客服'}</strong>
            <p data-ticket-body>{entry.body}</p>
            {entry.attachments.length > 0 ? (
              <ul data-ticket-attachment aria-label="附件">
                {entry.attachments.map((attachment) => (
                  <li key={attachment.id}>
                    {attachment.name}（{attachment.mimeType}）
                  </li>
                ))}
              </ul>
            ) : null}
            <time dateTime={entry.createdAt}>{formatSupportDate(entry.createdAt)}</time>
          </article>
        ))}
      </div>
      {ticket.status !== 'CLOSED' ? (
        <div className="settings-form">
          <label htmlFor={`reply-${ticket.id}`}>公开回复</label>
          <textarea
            id={`reply-${ticket.id}`}
            rows={3}
            value={reply}
            maxLength={4_000}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `ticket-reply-error-${ticket.id}` : undefined}
            onChange={(event) => {
              setReply(event.target.value);
            }}
          />
          <AttachmentPicker
            id={`reply-attachments-${ticket.id}`}
            items={attachments}
            onChange={setAttachments}
            disabled={pending}
          />
          <button
            type="button"
            disabled={pending || !reply.trim()}
            onClick={() =>
              void run((key) =>
                replyTicketAction(
                  ticket.id,
                  { body: reply.trim(), attachmentIds: attachments.map(({ id }) => id) },
                  key,
                ),
              ).then((succeeded) => {
                if (succeeded) {
                  setReply('');
                  setAttachments([]);
                }
              })
            }
          >
            发送回复
          </button>
        </div>
      ) : null}
      <div className="dialog-actions">
        {ticket.canClose ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void run((key) => changeTicketStatusAction(ticket.id, 'CLOSE', key))}
          >
            关闭工单
          </button>
        ) : null}
        {ticket.canReopen ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void run((key) => changeTicketStatusAction(ticket.id, 'REOPEN', key))}
          >
            重新打开
          </button>
        ) : null}
        {(ticket.status === 'RESOLVED' || ticket.status === 'CLOSED') && !ticket.satisfaction ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setRatingOpen(true);
            }}
          >
            评价本次服务
          </button>
        ) : null}
      </div>
      {error ? (
        <p id={`ticket-reply-error-${ticket.id}`} role="alert">
          {error}
        </p>
      ) : null}
      {ratingOpen ? (
        <SatisfactionDialog
          ticket={ticket}
          onSaved={(satisfaction) => {
            onChange({ ...ticket, satisfaction });
            setRatingOpen(false);
          }}
          onClose={() => {
            setRatingOpen(false);
          }}
        />
      ) : null}
    </article>
  );
}

function SatisfactionDialog({
  ticket,
  onSaved,
  onClose,
}: {
  readonly ticket: TicketView;
  readonly onSaved: (satisfaction: NonNullable<TicketView['satisfaction']>) => void;
  readonly onClose: () => void;
}) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setPending(true);
    setError(undefined);
    const key = createUuidV7();
    const result = await runSupportActionWithRefresh(key, (sameKey) =>
      submitTicketSatisfactionAction(
        ticket.id,
        { rating, ...(comment.trim() ? { comment: comment.trim() } : {}) },
        sameKey,
      ),
    );
    setPending(false);
    if (result.ok) onSaved(result.data);
    else setError(result.outcome === 'UNCERTAIN' ? '评价结果待确认，请刷新核对。' : '评价未提交。');
  };
  return (
    <AccessibleDialog
      labelledBy={`satisfaction-title-${ticket.id}`}
      onClose={onClose}
      busy={pending}
    >
      <h2 id={`satisfaction-title-${ticket.id}`}>评价本次服务</h2>
      <div className="settings-form">
        <label htmlFor={`satisfaction-rating-${ticket.id}`}>满意度</label>
        <select
          id={`satisfaction-rating-${ticket.id}`}
          value={rating}
          onChange={(event) => {
            setRating(Number(event.target.value));
          }}
        >
          {[5, 4, 3, 2, 1].map((value) => (
            <option key={value} value={value}>
              {value} 星
            </option>
          ))}
        </select>
        <label htmlFor={`satisfaction-comment-${ticket.id}`}>补充说明（可选）</label>
        <textarea
          id={`satisfaction-comment-${ticket.id}`}
          maxLength={500}
          value={comment}
          onChange={(event) => {
            setComment(event.target.value);
          }}
        />
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="dialog-actions">
        <button type="button" disabled={pending} onClick={() => void submit()}>
          提交评价
        </button>
        <button type="button" disabled={pending} onClick={onClose}>
          取消
        </button>
      </div>
    </AccessibleDialog>
  );
}

function FeedbackDialog({ onClose }: { readonly onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>('PRODUCT_SUGGESTION');
  const [referenceId, setReferenceId] = useState('');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string>();
  const submit = async () => {
    if (body.trim().length < 10 || pending) return;
    setPending(true);
    const key = createUuidV7();
    const result = await runSupportActionWithRefresh(key, (sameKey) =>
      submitFeedbackAction(
        {
          kind,
          body: body.trim(),
          ...(kind !== 'PRODUCT_SUGGESTION' ? { referenceId: referenceId.trim() } : {}),
        },
        sameKey,
      ),
    );
    setPending(false);
    if (result.ok) setStatus('反馈已提交，感谢你的建议。');
    else
      setStatus(
        result.outcome === 'UNCERTAIN'
          ? '反馈结果待确认，请勿重复提交。'
          : '反馈未提交，请检查内容。',
      );
  };
  return (
    <AccessibleDialog labelledBy="feedback-title" onClose={onClose} busy={pending}>
      <h2 id="feedback-title">提交产品反馈</h2>
      <div className="settings-form">
        <label htmlFor="feedback-kind">反馈类型</label>
        <select
          id="feedback-kind"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as FeedbackKind);
          }}
        >
          <option value="PRODUCT_SUGGESTION">产品建议</option>
          <option value="MODEL_RESULT">模型效果</option>
          <option value="FAILED_TASK">失败任务</option>
        </select>
        {kind !== 'PRODUCT_SUGGESTION' ? (
          <>
            <label htmlFor="feedback-reference">关联任务编号</label>
            <input
              id="feedback-reference"
              value={referenceId}
              onChange={(event) => {
                setReferenceId(event.target.value);
              }}
            />
          </>
        ) : null}
        <label htmlFor="feedback-body">反馈内容</label>
        <textarea
          id="feedback-body"
          minLength={10}
          maxLength={2_000}
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />
      </div>
      {status ? <p role={status.includes('感谢') ? 'status' : 'alert'}>{status}</p> : null}
      <div className="dialog-actions">
        <button
          type="button"
          disabled={pending || body.trim().length < 10}
          onClick={() => void submit()}
        >
          提交反馈
        </button>
        <button type="button" disabled={pending} onClick={onClose}>
          取消
        </button>
      </div>
    </AccessibleDialog>
  );
}

function AttachmentPicker({
  id,
  items,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly items: readonly AssetListItem[];
  readonly onChange: (items: readonly AssetListItem[]) => void;
  readonly disabled: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string>();
  const upload = async (files: FileList | null) => {
    if (!files || uploading) return;
    const selected = Array.from(files);
    if (
      selected.length + items.length > 5 ||
      selected.some(
        (file) =>
          !['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(file.type) ||
          file.size > 20 * 1024 * 1024 ||
          file.size <= 0,
      )
    ) {
      setError('最多 5 个附件，仅支持 JPG、PNG、WebP、MP4，单个不超过 20 MB。');
      return;
    }
    setUploading(true);
    setError(undefined);
    const completed = [...items];
    try {
      for (const file of selected) {
        const key = createUuidV7();
        const grantResult = await runCommerceActionWithRefresh(() =>
          createUploadSessionAction({ name: file.name, size: file.size, type: file.type }, key),
        );
        if (!grantResult.ok) throw new Error(grantResult.outcome);
        const receipt = await uploadAssetBytesWithSessionRefresh(grantResult.data, file, {
          signal: new AbortController().signal,
          onProgress: setProgress,
        });
        const completion = await runCommerceActionWithRefresh(() =>
          completeUploadAction(receipt, key),
        );
        if (!completion.ok) throw new Error(completion.outcome);
        completed.push(completion.data);
        onChange([...completed]);
      }
      setProgress(100);
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message === 'UNCERTAIN'
          ? '附件上传结果待确认，请到作品素材页核对后再提交。'
          : '附件上传失败，请检查格式后重试。',
      );
    } finally {
      setUploading(false);
    }
  };
  return (
    <div className="ticket-attachments">
      <label htmlFor={id}>公开附件</label>
      <input
        id={id}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,video/mp4"
        disabled={disabled || uploading || items.length >= 5}
        onChange={(event) => {
          void upload(event.target.files);
          event.target.value = '';
        }}
      />
      <p className="field-help">附件通过隔离上传通道保存，并与回复正文分开提交。</p>
      {uploading ? <progress max="100" value={progress} aria-label="附件上传进度" /> : null}
      {items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              {item.name}
              <button
                type="button"
                disabled={disabled || uploading}
                aria-label={`移除附件 ${item.name}`}
                onClick={() => {
                  onChange(items.filter(({ id: itemId }) => itemId !== item.id));
                }}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
