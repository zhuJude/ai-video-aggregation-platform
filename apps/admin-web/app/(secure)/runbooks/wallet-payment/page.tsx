import { Link, Text, Title2, Title3 } from '@fluentui/react-components';

export default function WalletPaymentRunbookPage() {
  return (
    <article aria-labelledby="wallet-payment-runbook-heading">
      <Title2 as="h2" id="wallet-payment-runbook-heading">
        钱包与支付对账 Runbook
      </Title2>
      <Text>
        本页仅提供只读处置步骤。禁止修改历史订单、回调或账本分录；所有修复必须创建补偿申请并完成两名不同管理员复核。
      </Text>
      <section id="reconciliation">
        <Title3 as="h3">渠道差异处置</Title3>
        <ol>
          <li>核对平台订单、微信渠道账单、回调验签结果与钱包入账状态。</li>
          <li>确认差异分类，并保存关联 Trace ID、渠道退款号与失败摘要。</li>
          <li>使用权威影响预览创建补偿申请；申请人不得参与审批。</li>
          <li>两名不同审批人完成复核后，由钱包服务创建新的平衡分录。</li>
          <li>重新执行对账，差异归零后关闭案例；否则升级 P0 财务告警。</li>
        </ol>
      </section>
      <Link href="/finance/reconciliation">返回渠道对账</Link>
    </article>
  );
}
