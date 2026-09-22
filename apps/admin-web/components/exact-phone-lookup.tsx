'use client';

import {
  Button,
  Field,
  Input,
  Link,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} from '@fluentui/react-components';
import { useRef, useState } from 'react';
import type { UserRow } from '../lib/user-view-loaders';
import { CsvExportForm, type CsvExportFormProps } from './csv-export-form';

export type ExactLookupResult = Readonly<{
  expiresAt: string;
  items: readonly UserRow[];
  ok: true;
  searchDescriptor: string;
}>;

export type ExactPhoneLookupProps = Readonly<{
  canExport: boolean;
  onExport: CsvExportFormProps['onExport'];
  onLookup: (formData: FormData) => Promise<ExactLookupResult>;
}>;

export function ExactPhoneLookup({ canExport, onExport, onLookup }: ExactPhoneLookupProps) {
  const [phone, setPhone] = useState('');
  const [result, setResult] = useState<ExactLookupResult>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  async function submit() {
    if (pendingRef.current || !phone) return;
    pendingRef.current = true;
    setPending(true);
    const form = new FormData();
    form.set('phone', phone);
    try {
      setResult(await onLookup(form));
      setError(undefined);
    } catch {
      setResult(undefined);
      setError('精确手机号查询被拒绝或暂时不可用');
    } finally {
      setPhone('');
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-label="受保护的精确手机号查询">
      <Field label="精确手机号">
        <Input
          aria-label="精确手机号"
          autoComplete="off"
          disabled={pending}
          inputMode="numeric"
          maxLength={11}
          value={phone}
          onChange={(_event, data) => {
            setPhone(data.value);
            setResult(undefined);
          }}
        />
      </Field>
      <Button
        disabled={pending || phone.length === 0}
        onClick={() => {
          void submit();
        }}
      >
        受保护查询
      </Button>
      {error ? <Text role="alert">{error}</Text> : null}
      {result ? (
        <>
          <Text>查询授权至 {result.expiresAt}</Text>
          <Table aria-label="精确手机号查询结果">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>用户</TableHeaderCell>
                <TableHeaderCell>手机号</TableHeaderCell>
                <TableHeaderCell>账户状态</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Link href={`/users/${encodeURIComponent(item.id)}`}>{item.displayName}</Link>
                  </TableCell>
                  <TableCell>{item.phoneMasked}</TableCell>
                  <TableCell>{item.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <CsvExportForm
            canExport={canExport}
            onExport={onExport}
            searchDescriptor={result.searchDescriptor}
          />
        </>
      ) : null}
    </section>
  );
}
