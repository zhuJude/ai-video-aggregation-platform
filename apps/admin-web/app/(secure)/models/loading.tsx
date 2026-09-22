import { Skeleton, SkeletonItem, Title2 } from '@fluentui/react-components';

export default function ModelsLoading() {
  return (
    <section aria-busy="true" aria-labelledby="models-loading-heading" role="status">
      <Title2 id="models-loading-heading">模型能力目录</Title2>
      <span className="sr-only">正在载入模型能力目录</span>
      <Skeleton>
        <SkeletonItem />
        <SkeletonItem />
        <SkeletonItem />
      </Skeleton>
    </section>
  );
}
