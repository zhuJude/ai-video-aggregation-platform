'use client';

import { Button, Checkbox, Field, Input, Text } from '@fluentui/react-components';
import { useRef, useState } from 'react';
import type { UserFilters } from '../lib/user-view-loaders';
import { createUuidV7 } from '../lib/uuid-v7';

export type CsvExportFormProps = Readonly<{
  canExport: boolean;
  filters?: UserFilters;
  onExport: (
    formData: FormData,
  ) => Promise<
    Readonly<{ auditRecordId: string; downloadUrl: string; expiresAt: string; ok: true }>
  >;
  query?: string;
  searchDescriptor?: string;
}>;

export function CsvExportForm({
  canExport,
  filters = {},
  onExport,
  query,
  searchDescriptor,
}: CsvExportFormProps) {
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string>();
  const [descriptor, setDescriptor] =
    useState<Readonly<{ auditRecordId: string; downloadUrl: string; expiresAt: string }>>();
  const [pending, setPending] = useState(false);
  const [intentId, setIntentId] = useState(() => createUuidV7());
  const pendingRef = useRef(false);
  if (!canExport) return null;
  async function submit() {
    if (pendingRef.current || descriptor) return;
    if (!reason.trim()) {
      setError('请填写导出原因');
      return;
    }
    if (!confirmed) {
      setError('请确认高风险导出');
      return;
    }
    pendingRef.current = true;
    setPending(true);
    const form = new FormData();
    form.set('reason', reason.trim());
    form.set('highRiskConfirmed', 'true');
    form.set('intentId', intentId);
    if (searchDescriptor) {
      form.set('searchDescriptor', searchDescriptor);
    } else {
      if (query) form.set('query', query);
      if (filters.status) form.set('status', filters.status);
      if (filters.tag) form.set('tag', filters.tag);
      if (filters.registrationSource) form.set('registrationSource', filters.registrationSource);
      if (filters.spendingTier) form.set('spendingTier', filters.spendingTier);
    }
    try {
      setDescriptor(await onExport(form));
      setError(undefined);
    } catch {
      setError('导出申请被拒绝或暂时不可用');
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <section aria-label="用户 CSV 导出">
      <Field label="导出原因">
        <Input
          aria-label="导出原因"
          disabled={pending || Boolean(descriptor)}
          maxLength={200}
          value={reason}
          onChange={(_event, data) => {
            if (data.value !== reason) setIntentId(createUuidV7());
            setReason(data.value);
          }}
        />
      </Field>
      <Checkbox
        checked={confirmed}
        disabled={pending || Boolean(descriptor)}
        label="我确认这是高风险数据导出"
        onChange={(_event, data) => {
          setConfirmed(Boolean(data.checked));
        }}
      />
      {error ? <Text role="alert">{error}</Text> : null}
      <Button
        disabled={pending || Boolean(descriptor)}
        onClick={() => {
          void submit();
        }}
      >
        导出 CSV
      </Button>
      {descriptor ? (
        <Text>
          导出已授权，审计 {descriptor.auditRecordId}，至 {descriptor.expiresAt} 有效：
          <a href={descriptor.downloadUrl}>下载 CSV</a>
        </Text>
      ) : null}
    </section>
  );
}
