'use client';

import { Button, Text, Title2 } from '@fluentui/react-components';

export default function ModelsError({ reset }: Readonly<{ error: Error; reset: () => void }>) {
  return (
    <section role="alert">
      <Title2>模型能力暂不可用</Title2>
      <Text>目录读取失败，未使用过期数据替代。</Text>
      <Button onClick={reset}>重试</Button>
    </section>
  );
}
