'use client';

import { Button, MessageBar, MessageBarBody, Title2 } from '@fluentui/react-components';

export default function ProvidersError({ reset }: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  return (
    <section aria-labelledby="providers-error-heading">
      <Title2 id="providers-error-heading">供应商数据暂不可用</Title2>
      <MessageBar intent="error">
        <MessageBarBody>权威供应商状态未能通过校验，本页不会展示缓存或不完整的敏感配置。</MessageBarBody>
      </MessageBar>
      <Button appearance="primary" onClick={reset}>重新读取</Button>
    </section>
  );
}
