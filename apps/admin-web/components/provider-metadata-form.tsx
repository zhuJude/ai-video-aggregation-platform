'use client';

import {
  Button,
  Checkbox,
  Field,
  Input,
  Text,
  Title3,
  makeStyles,
} from '@fluentui/react-components';
import { useRef, useState, type SyntheticEvent } from 'react';

import type { ProviderActionReceipt, ProviderDetail } from '../lib/provider-operations';
import { createUuidV7 } from '../lib/uuid-v7';

const useStyles = makeStyles({
  root: {
    display: 'grid',
    gap: '12px',
    maxWidth: '760px',
    paddingBlock: '16px',
  },
  columns: {
    display: 'grid',
    gap: '12px',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  },
});

type MetadataAction = (formData: FormData) => Promise<ProviderActionReceipt>;

type ProviderMetadataEditableView = Pick<
  ProviderDetail,
  | 'auth'
  | 'callback'
  | 'id'
  | 'interface'
  | 'maintenanceWindow'
  | 'name'
  | 'ownerAdminId'
  | 'version'
>;

type ProviderMetadataFormProps = Readonly<{
  actorId: string;
  mode: 'CREATE' | 'EDIT';
  onSubmit: MetadataAction;
  provider?: ProviderMetadataEditableView;
}>;

export function ProviderMetadataForm({
  actorId,
  mode,
  onSubmit,
  provider,
}: ProviderMetadataFormProps) {
  const styles = useStyles();
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.interface.baseUrl ?? '');
  const [ownerAdminId, setOwnerAdminId] = useState(provider?.ownerAdminId ?? actorId);
  const [authMethod, setAuthMethod] = useState<ProviderDetail['auth']['method']>(
    provider?.auth.method ?? 'API_KEY',
  );
  const [callbackMode, setCallbackMode] = useState<ProviderDetail['callback']['mode']>(
    provider?.callback.mode ?? 'NONE',
  );
  const [maintenanceStartsAt, setMaintenanceStartsAt] = useState(
    provider?.maintenanceWindow?.startsAt ?? '',
  );
  const [maintenanceEndsAt, setMaintenanceEndsAt] = useState(
    provider?.maintenanceWindow?.endsAt ?? '',
  );
  const [maintenanceReason, setMaintenanceReason] = useState(
    provider?.maintenanceWindow?.reason ?? '',
  );
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [intentId, setIntentId] = useState(() => createUuidV7());
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const pendingRef = useRef(false);

  function changed(update: () => void) {
    update();
    if (!pendingRef.current) setIntentId(createUuidV7());
    setMessage(undefined);
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    if (!reason.trim()) {
      setMessage('请填写变更原因');
      return;
    }
    if (!confirmed) {
      setMessage('请确认提交供应商配置');
      return;
    }

    const formData = new FormData();
    formData.set('authMethod', authMethod);
    formData.set('baseUrl', baseUrl);
    formData.set('callbackMode', callbackMode);
    formData.set('confirmed', 'true');
    formData.set('intentId', intentId);
    formData.set('kind', mode);
    formData.set('name', name);
    formData.set('ownerAdminId', ownerAdminId);
    formData.set('reason', reason.trim());
    if (maintenanceStartsAt || maintenanceEndsAt || maintenanceReason) {
      formData.set('maintenanceStartsAt', maintenanceStartsAt);
      formData.set('maintenanceEndsAt', maintenanceEndsAt);
      formData.set('maintenanceReason', maintenanceReason);
    }
    if (mode === 'EDIT' && provider) {
      formData.set('expectedVersion', String(provider.version));
      formData.set('providerId', provider.id);
    }

    pendingRef.current = true;
    setPending(true);
    setMessage(undefined);
    try {
      const receipt = await onSubmit(formData);
      setMessage(`配置已受理：请求 ${receipt.requestId}；审计 ${receipt.auditRecordId}`);
    } catch {
      setMessage('配置提交被拒绝或权威版本已变化');
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <form
      className={styles.root}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <Title3>{mode === 'CREATE' ? '创建供应商元数据' : '编辑供应商元数据'}</Title3>
      <Text>此表单不接受任何原始凭证；鉴权材料只能通过受保护的凭证轮换流程写入 KMS。</Text>
      <div className={styles.columns}>
        <Field label="供应商名称" required>
          <Input
            aria-label="供应商名称"
            disabled={pending}
            maxLength={120}
            value={name}
            onChange={(_event, data) => {
              changed(() => {
                setName(data.value);
              });
            }}
          />
        </Field>
        <Field label="接口地址" required>
          <Input
            aria-label="接口地址"
            disabled={pending}
            type="url"
            value={baseUrl}
            onChange={(_event, data) => {
              changed(() => {
                setBaseUrl(data.value);
              });
            }}
          />
        </Field>
        <Field label="负责人管理员 ID" required>
          <Input
            aria-label="负责人管理员 ID"
            disabled={pending}
            value={ownerAdminId}
            onChange={(_event, data) => {
              changed(() => {
                setOwnerAdminId(data.value);
              });
            }}
          />
        </Field>
        <Field label="鉴权方式">
          <select
            aria-label="鉴权方式"
            disabled={pending}
            value={authMethod}
            onChange={(event) => {
              changed(() => {
                setAuthMethod(event.currentTarget.value as ProviderDetail['auth']['method']);
              });
            }}
          >
            <option value="API_KEY">API Key</option>
            <option value="BEARER">Bearer</option>
            <option value="HMAC_SHA256">HMAC SHA-256</option>
            <option value="OAUTH2_CLIENT">OAuth2 Client</option>
          </select>
        </Field>
        <Field label="回调模式">
          <select
            aria-label="回调模式"
            disabled={pending}
            value={callbackMode}
            onChange={(event) => {
              changed(() => {
                setCallbackMode(event.currentTarget.value as ProviderDetail['callback']['mode']);
              });
            }}
          >
            <option value="NONE">无</option>
            <option value="SIGNED_WEBHOOK">签名 Webhook</option>
            <option value="POLLING">轮询</option>
          </select>
        </Field>
      </div>
      <div className={styles.columns}>
        <Field label="维护开始时间（UTC ISO）">
          <Input
            aria-label="维护开始时间（UTC ISO）"
            disabled={pending}
            value={maintenanceStartsAt}
            onChange={(_event, data) => {
              changed(() => {
                setMaintenanceStartsAt(data.value);
              });
            }}
          />
        </Field>
        <Field label="维护结束时间（UTC ISO）">
          <Input
            aria-label="维护结束时间（UTC ISO）"
            disabled={pending}
            value={maintenanceEndsAt}
            onChange={(_event, data) => {
              changed(() => {
                setMaintenanceEndsAt(data.value);
              });
            }}
          />
        </Field>
        <Field label="维护原因">
          <Input
            aria-label="维护原因"
            disabled={pending}
            maxLength={256}
            value={maintenanceReason}
            onChange={(_event, data) => {
              changed(() => {
                setMaintenanceReason(data.value);
              });
            }}
          />
        </Field>
      </div>
      <Field label="变更原因" required>
        <Input
          aria-label="变更原因"
          disabled={pending}
          maxLength={200}
          value={reason}
          onChange={(_event, data) => {
            changed(() => {
              setReason(data.value);
            });
          }}
        />
      </Field>
      <Checkbox
        checked={confirmed}
        disabled={pending}
        label="我确认提交供应商配置"
        onChange={(_event, data) => {
          changed(() => {
            setConfirmed(Boolean(data.checked));
          });
        }}
      />
      {message ? (
        <Text role={message.includes('被拒绝') || message.includes('请') ? 'alert' : 'status'}>
          {message}
        </Text>
      ) : null}
      <Button appearance="primary" disabled={pending} type="submit">
        {mode === 'CREATE' ? '创建供应商' : '保存供应商'}
      </Button>
    </form>
  );
}
