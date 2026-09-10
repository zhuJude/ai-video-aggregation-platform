'use client';

import { Button, Text, Title2 } from '@fluentui/react-components';

export default function CapabilityError({ reset }: Readonly<{ error: Error; reset: () => void }>) {
  return (
    <section role="alert">
      <Title2>模型能力暂不可用</Title2>
      <Text>能力版本读取失败，未使用本地草稿覆盖权威状态。</Text>
      <Button onClick={reset}>重试</Button>
    </section>
  );
}
