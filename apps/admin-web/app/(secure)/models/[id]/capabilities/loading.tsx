import { Skeleton, SkeletonItem, Title2 } from '@fluentui/react-components';

export default function CapabilityLoading() {
  return (
    <section aria-busy="true" aria-labelledby="capability-loading-heading" role="status">
      <Title2 id="capability-loading-heading">模型能力</Title2>
      <span className="sr-only">正在载入模型能力</span>
      <Skeleton>
        <SkeletonItem />
        <SkeletonItem />
        <SkeletonItem />
      </Skeleton>
    </section>
  );
}
