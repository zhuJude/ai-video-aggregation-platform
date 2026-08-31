'use client';

import { Button, Field, Input, Select, Text } from '@fluentui/react-components';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';

import { containsSensitivePhoneLikeValue, REGISTRATION_SOURCES, SPENDING_TIERS, USER_STATUSES, usersSearchParamsToString, type UserFilters } from '../lib/sensitive-query';

export function UserDirectorySearchForm({ initialFilters, initialQuery }: Readonly<{ initialFilters: UserFilters; initialQuery: string }>) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState(initialFilters.status ?? '');
  const [tag, setTag] = useState(initialFilters.tag ?? '');
  const [registrationSource, setRegistrationSource] = useState(initialFilters.registrationSource ?? '');
  const [spendingTier, setSpendingTier] = useState(initialFilters.spendingTier ?? '');
  const [error, setError] = useState<string>();

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = [query, status, tag, registrationSource, spendingTier];
    if (values.some(containsSensitivePhoneLikeValue)) {
      setQuery(''); setTag(''); setError('手机号相关查询不得进入地址栏，请使用受保护的精确手机号查询');
      return;
    }
    setError(undefined);
    const search = usersSearchParamsToString({
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(status ? { status } : {}),
      ...(tag ? { tag } : {}),
      ...(registrationSource ? { registrationSource } : {}),
      ...(spendingTier ? { spendingTier } : {}),
    });
    router.push(search ? `/users?${search}` : '/users');
  }

  return <form method="post" onSubmit={submit}>
    <Field label="用户名、邮箱或用户标识"><Input name="query" value={query} onChange={(_event, data) => { setQuery(data.value); setError(undefined); }} /></Field>
    <Field label="账户状态"><Select aria-label="账户状态" name="status" value={status} onChange={(event) => { setStatus(event.target.value); }}><option value="">全部</option>{USER_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
    <Field label="用户标签"><Input aria-label="用户标签" name="tag" value={tag} onChange={(_event, data) => { setTag(data.value); setError(undefined); }} /></Field>
    <Field label="注册来源"><Select aria-label="注册来源" name="registrationSource" value={registrationSource} onChange={(event) => { setRegistrationSource(event.target.value); }}><option value="">全部</option>{REGISTRATION_SOURCES.map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
    <Field label="消费等级"><Select aria-label="消费等级" name="spendingTier" value={spendingTier} onChange={(event) => { setSpendingTier(event.target.value); }}><option value="">全部</option>{SPENDING_TIERS.map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
    {error ? <Text role="alert">{error}</Text> : null}
    <Button type="submit">服务端查询</Button>
  </form>;
}
