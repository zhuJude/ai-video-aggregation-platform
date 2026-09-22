'use client';

import { Button, MessageBar, MessageBarBody, Title2 } from '@fluentui/react-components';

export default function OverviewError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  return (
    <section aria-labelledby="overview-error-heading">
      <Title2 id="overview-error-heading">运营总览</Title2>
      <MessageBar intent="error">
        <MessageBarBody>
          权威运营数据暂时不可用。为避免展示不可靠指标，本页未显示任何汇总数值。
        </MessageBarBody>
      </MessageBar>
      <Button appearance="primary" onClick={reset}>
        重新读取
      </Button>
    </section>
  );
}
