import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  value: {
    kind: 'active' as 'active' | 'invalid' | 'needs-refresh',
    session: { ownerId: '+8613800138000' },
  },
}));

vi.mock('../lib/auth/server-session', () => {
  class AuthenticationRequiredError extends Error {}
  class SessionRefreshRequiredError extends Error {}
  return {
    AuthenticationRequiredError,
    SessionRefreshRequiredError,
    readAuthenticatedServerSessionState: () => Promise.resolve(authState.value),
    requireMutableAuthenticatedServerSession: () => Promise.resolve({ ownerId: '+8613800138000' }),
  };
});

vi.mock('next/navigation', () => ({
  redirect: (location: string) => {
    throw new Error(`NEXT_REDIRECT:${location}`);
  },
}));

import AssetsPage from '../app/assets/page';
import { requestAssetAccessAction } from '../app/commerce-actions';
import { AssetLibrary } from '../components/commerce/asset-library';
import { InvoiceCenter } from '../components/commerce/invoice-center';
import { OrderCenter } from '../components/commerce/order-center';
import { WalletSummary } from '../components/commerce/wallet-summary';
import { commerceGateway } from '../lib/commerce/gateway';
import { commerceOwnerIdFromPhone } from '../lib/commerce/identity';
import {
  formatMinorAmount,
  parseInvoiceCandidatePage,
  parseOrderCreateResult,
  parseWalletPage,
  usableSignedUrl,
} from '../lib/commerce/runtime';
import type {
  AssetPage,
  CommerceGateway,
  InvoiceCandidatePage,
  OrderCreateResult,
  OrderPage,
  WalletPage,
} from '../lib/commerce/types';

const PHONE = '+8613800138000';
let OWNER = '';
const OTHER_OWNER = '0198f4d4-21c2-7b7d-8a03-08a0da2a6199';
const ASSET_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a7101';
const ORDER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a7201';

const assets: AssetPage = {
  items: [
    {
      id: ASSET_ID,
      kind: 'RESULT',
      name: '海边公路.mp4',
      mimeType: 'video/mp4',
      sizeBytes: '2097152',
      createdAt: '2026-08-31T10:00:00.000Z',
      posterAlt: '海边公路视频封面',
    },
  ],
  pageInfo: {},
};

const wallet: WalletPage = {
  balance: {
    available: '9007199254740993',
    frozen: '1200',
    totalRecharged: '9007199254742193',
    totalConsumed: '800',
  },
  transactions: [],
  pageInfo: {},
};

const orders: OrderPage = {
  packages: [{ id: 'starter', amountMinor: '9900', currency: 'CNY', points: '10000' }],
  customAmount: { minMinor: '100', maxMinor: '500000', stepMinor: '100' },
  items: [],
  pageInfo: {},
};

const candidates: InvoiceCandidatePage = {
  items: [
    {
      orderId: ORDER_ID,
      paidAt: '2026-08-31T10:00:00.000Z',
      amountMinor: '10001',
      currency: 'CNY',
      points: '9007199254740993',
    },
  ],
  history: [],
};

function gateway(overrides: Partial<CommerceGateway> = {}): CommerceGateway {
  return {
    listAssets: vi.fn().mockResolvedValue(assets),
    requestAssetAccess: vi.fn().mockResolvedValue({
      url: 'https://private-cdn.example/assets/a.mp4?signature=redacted',
      expiresAt: '2026-09-12T10:05:00.000Z',
    }),
    completeUpload: vi.fn().mockResolvedValue(assets.items[0]),
    renameAsset: vi.fn().mockResolvedValue({ ...assets.items[0], name: '新名称.mp4' }),
    deleteAsset: vi.fn().mockResolvedValue({ accepted: true }),
    getWallet: vi.fn().mockResolvedValue(wallet),
    listOrders: vi.fn().mockResolvedValue(orders),
    createOrder: vi.fn().mockResolvedValue({
      order: {
        id: ORDER_ID,
        amountMinor: '9900',
        currency: 'CNY',
        points: '10000',
        status: 'PENDING',
        createdAt: '2026-09-12T10:00:00.000Z',
        expiresAt: '2026-09-12T10:15:00.000Z',
      },
      payment: {
        environment: 'MOCK',
        kind: 'DISPLAY_ONLY',
        expiresAt: '2026-09-12T10:15:00.000Z',
      },
    }),
    requestOrderPayment: vi.fn().mockResolvedValue({
      order: {
        id: ORDER_ID,
        amountMinor: '9900',
        currency: 'CNY',
        points: '10000',
        status: 'PENDING',
        createdAt: '2026-09-12T10:00:00.000Z',
        expiresAt: '2026-09-12T10:15:00.000Z',
      },
      payment: {
        environment: 'MOCK',
        kind: 'DISPLAY_ONLY',
        expiresAt: '2026-09-12T10:15:00.000Z',
      },
    }),
    listInvoiceCandidates: vi.fn().mockResolvedValue(candidates),
    createInvoice: vi.fn().mockResolvedValue({
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a7301',
      status: 'SUBMITTED',
    }),
    ...overrides,
  };
}

beforeEach(() => {
  process.env.USER_WEB_COMMERCE_MODE = 'mock';
  process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY = Buffer.alloc(32, 13).toString('base64url');
  OWNER = commerceOwnerIdFromPhone(PHONE);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  authState.value = {
    kind: 'active',
    session: { ownerId: PHONE },
  };
  delete process.env.USER_WEB_COMMERCE_MODE;
  delete process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY;
});

describe('commerce identity and mock isolation', () => {
  it('derives a stable UUID owner from the verified phone without exposing the phone', () => {
    const derived = commerceOwnerIdFromPhone(PHONE);
    expect(derived).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(commerceOwnerIdFromPhone(PHONE)).toBe(derived);
    expect(derived).not.toContain('13800138000');
  });

  it('fails closed when the server-only commerce mock gate is disabled', async () => {
    delete process.env.USER_WEB_COMMERCE_MODE;
    await expect(commerceGateway.listAssets({}, { ownerId: OWNER })).rejects.toThrow(
      'COMMERCE_SERVICE_UNAVAILABLE',
    );
  });

  it('maps the authenticated phone to a UUID owner inside server actions', async () => {
    await expect(requestAssetAccessAction(ASSET_ID, 'PREVIEW')).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe('wallet precision and immutable ledger', () => {
  it('renders available and frozen points separately and preserves exact integers', () => {
    render(<WalletSummary balance={wallet.balance} />);
    expect(screen.getByText('9,007,199,254,740,993')).toBeVisible();
    expect(screen.getByText('1,200')).toBeVisible();
  });

  it('fails closed on an unknown ledger field and formats in China Standard Time', () => {
    expect(() => parseWalletPage({ ...wallet, transactions: [{ injected: true }] })).toThrow(
      'INVALID_WALLET_TRANSACTION',
    );
    expect(
      parseWalletPage({
        ...wallet,
        transactions: [
          {
            id: 'ledger-1',
            type: 'CREDIT',
            direction: 'CREDIT',
            status: 'POSTED',
            points: '9007199254740993',
            occurredAt: '2026-08-31T16:00:00.000Z',
            reference: { kind: 'ORDER', id: ORDER_ID, label: '充值订单' },
          },
        ],
      }).transactions[0]?.occurredAt,
    ).toBe('2026-08-31T16:00:00.000Z');
  });

  it('accepts only the frozen wallet ledger kinds', () => {
    const credit = {
      id: 'credit-1',
      type: 'CREDIT',
      direction: 'CREDIT',
      status: 'POSTED',
      points: '100',
      occurredAt: '2026-08-31T09:00:00.000Z',
    };
    expect(parseWalletPage({ ...wallet, transactions: [credit] }).transactions[0]?.type).toBe(
      'CREDIT',
    );
    for (const internalOrInventedKind of ['RECHARGE', 'REPAIR', 'REFUND']) {
      expect(() =>
        parseWalletPage({
          ...wallet,
          transactions: [{ ...credit, type: internalOrInventedKind }],
        }),
      ).toThrow('INVALID_WALLET_TRANSACTION');
    }
  });
});

describe('private assets', () => {
  it('uses fixed refresh and login trampolines before any owner-scoped read', async () => {
    authState.value = { kind: 'needs-refresh', session: { ownerId: OWNER } };
    await expect(AssetsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_REDIRECT:/auth/session/refresh?returnTo=%2Fassets',
    );
    authState.value = { kind: 'invalid', session: { ownerId: OWNER } };
    await expect(AssetsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_REDIRECT:/login?returnTo=%2Fassets',
    );
  });

  it('never uses an expired or unsafe signed URL', () => {
    expect(
      usableSignedUrl(
        {
          url: 'https://private-cdn.example/video.mp4?signature=secret',
          expiresAt: '2026-09-12T10:00:00.000Z',
        },
        Date.parse('2026-09-12T10:00:01.000Z'),
      ),
    ).toBeUndefined();
    expect(
      usableSignedUrl(
        {
          url: 'javascript:alert(1)',
          expiresAt: '2026-09-12T10:05:00.000Z',
        },
        Date.parse('2026-09-12T10:00:00.000Z'),
      ),
    ).toBeUndefined();
    expect(
      usableSignedUrl(
        {
          url: '/api/commerce/mock-assets/../../auth/refresh',
          expiresAt: '2026-09-12T10:05:00.000Z',
        },
        Date.parse('2026-09-12T10:00:00.000Z'),
      ),
    ).toBeUndefined();
  });

  it('requires an explicit dialog confirmation before deletion', async () => {
    const deleteAsset = vi.fn<CommerceGateway['deleteAsset']>().mockResolvedValue({
      accepted: true,
    });
    const api = gateway({ deleteAsset });
    const user = userEvent.setup();
    render(<AssetLibrary initial={assets} gateway={api} ownerId={OWNER} />);
    const deleteTrigger = screen.getByRole('button', { name: '删除海边公路.mp4' });
    await user.click(deleteTrigger);
    expect(screen.getByRole('dialog')).toHaveTextContent('演示环境中的本机临时副本会同时删除');
    expect(deleteAsset).not.toHaveBeenCalled();
    const cancel = screen.getByRole('button', { name: '保留素材' });
    const confirmDelete = screen.getByRole('button', { name: '确认删除' });
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirmDelete).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirmDelete).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deleteTrigger).toHaveFocus();
    await user.click(deleteTrigger);
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(deleteAsset).toHaveBeenCalledTimes(1);
  });

  it('keeps fixture assets isolated by authenticated owner', async () => {
    await expect(commerceGateway.listAssets({}, { ownerId: OTHER_OWNER })).resolves.toMatchObject({
      items: [],
    });
    await expect(
      commerceGateway.requestAssetAccess(ASSET_ID, 'PREVIEW', { ownerId: OTHER_OWNER }),
    ).rejects.toMatchObject({ outcome: 'DEFINITIVE_FAILURE' });
    await expect(
      commerceGateway.requestAssetAccess(ASSET_ID, 'PREVIEW', { ownerId: '' }),
    ).rejects.toMatchObject({
      message: 'AUTHENTICATION_REQUIRED',
      outcome: 'DEFINITIVE_FAILURE',
    });
  });
});

describe('recharge orders', () => {
  it('locks duplicate submission while pending and reuses one UUIDv7 key', async () => {
    let resolve!: (value: OrderCreateResult) => void;
    const createOrder = vi.fn<CommerceGateway['createOrder']>(
      () => new Promise((done) => (resolve = done)),
    );
    const api = gateway({ createOrder });
    const user = userEvent.setup();
    render(<OrderCenter initial={orders} gateway={api} ownerId={OWNER} />);
    await user.click(screen.getByRole('radio', { name: /99\.00/ }));
    const submit = screen.getByRole('button', { name: '创建支付订单' });
    await user.click(submit);
    fireEvent.click(submit);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder.mock.calls[0]?.[1].idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    resolve(
      (await gateway().createOrder(
        { packageId: 'starter' },
        { ownerId: OWNER, idempotencyKey: '0198f4d4-21c2-7b7d-8a03-08a0da2a7999' },
      )) as OrderCreateResult,
    );
    expect(await screen.findByText('演示支付，不会扣款')).toBeVisible();
    expect(screen.queryByRole('link', { name: '打开微信支付' })).not.toBeInTheDocument();
  });

  it('distinguishes an uncertain outcome and does not invite a blind resubmit', async () => {
    const api = gateway({ createOrder: vi.fn().mockRejectedValue(new Error('network reset')) });
    const user = userEvent.setup();
    render(<OrderCenter initial={orders} gateway={api} ownerId={OWNER} />);
    await user.click(screen.getByRole('radio', { name: /99\.00/ }));
    await user.click(screen.getByRole('button', { name: '创建支付订单' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('结果待确认');
    expect(screen.queryByRole('button', { name: '创建支付订单' })).not.toBeInTheDocument();
  });

  it('strictly allowlists the payment payload and blocks HTML or redirects', () => {
    expect(() =>
      parseOrderCreateResult({
        order: {
          id: ORDER_ID,
          amountMinor: '9900',
          currency: 'CNY',
          points: '10000',
          status: 'PENDING',
          createdAt: '2026-09-12T10:00:00.000Z',
          expiresAt: '2026-09-12T10:15:00.000Z',
        },
        payment: {
          environment: 'LIVE',
          kind: 'QR_CODE',
          qrCodeUrl: 'javascript:alert(1)',
          expiresAt: '2026-09-12T10:15:00.000Z',
          html: '<script>steal()</script>',
        },
      }),
    ).toThrow('INVALID_PAYMENT_PAYLOAD');
  });

  it('keeps fixture payments explicitly mock-only and never emits a real payment host', async () => {
    const result = parseOrderCreateResult(
      await commerceGateway.createOrder(
        { packageId: 'creator' },
        { ownerId: OWNER, idempotencyKey: '0198f4d4-21c2-7b7d-8a03-08a0da2a7881' },
      ),
    );
    expect(result.payment).toMatchObject({ environment: 'MOCK', kind: 'DISPLAY_ONLY' });
    expect(JSON.stringify(result.payment)).not.toContain('weixin.qq.com');
  });

  it('does not render a payment entry after its server expiry', async () => {
    const api = gateway({
      createOrder: vi.fn().mockResolvedValue({
        order: {
          id: ORDER_ID,
          amountMinor: '9900',
          currency: 'CNY',
          points: '10000',
          status: 'PENDING',
          createdAt: '2026-09-12T08:00:00.000Z',
          expiresAt: '2026-09-12T08:15:00.000Z',
        },
        payment: {
          environment: 'LIVE',
          kind: 'QR_CODE',
          qrCodeUrl: 'https://pay.weixin.qq.com/pay/example',
          expiresAt: '2026-09-12T08:15:00.000Z',
        },
      }),
    });
    const user = userEvent.setup();
    render(<OrderCenter initial={orders} gateway={api} ownerId={OWNER} />);
    await user.click(screen.getByRole('radio', { name: /99\.00/ }));
    await user.click(screen.getByRole('button', { name: '创建支付订单' }));
    expect(await screen.findByText('支付入口已过期')).toBeVisible();
    expect(screen.queryByRole('link', { name: '打开微信支付' })).not.toBeInTheDocument();
  });

  it('requests a fresh owner-scoped payload when continuing a pending order', async () => {
    const pendingOrder = {
      id: ORDER_ID,
      amountMinor: '9900',
      currency: 'CNY' as const,
      points: '10000',
      status: 'PENDING' as const,
      createdAt: '2099-09-12T10:00:00.000Z',
      expiresAt: '2099-09-12T10:15:00.000Z',
    };
    const requestOrderPayment = vi.fn<CommerceGateway['requestOrderPayment']>().mockResolvedValue({
      order: pendingOrder,
      payment: {
        environment: 'MOCK',
        kind: 'DISPLAY_ONLY',
        expiresAt: pendingOrder.expiresAt,
      },
    });
    const user = userEvent.setup();
    render(
      <OrderCenter
        initial={{ ...orders, items: [pendingOrder] }}
        gateway={gateway({ requestOrderPayment })}
        ownerId={OWNER}
      />,
    );
    await user.click(screen.getByRole('button', { name: '继续支付' }));
    expect(requestOrderPayment).toHaveBeenCalledWith(ORDER_ID, { ownerId: OWNER });
    expect(await screen.findByText('演示支付，不会扣款')).toBeVisible();
  });

  it('removes a continue-payment entry when its server expiry is reached', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T10:00:00.000Z'));
    render(
      <OrderCenter
        initial={{
          ...orders,
          items: [
            {
              id: ORDER_ID,
              amountMinor: '9900',
              currency: 'CNY',
              points: '10000',
              status: 'PENDING',
              createdAt: '2026-09-12T09:59:00.000Z',
              expiresAt: '2026-09-12T10:00:10.000Z',
            },
          ],
        }}
        gateway={gateway()}
        ownerId={OWNER}
      />,
    );
    expect(screen.getByRole('button', { name: '继续支付' })).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(screen.queryByRole('button', { name: '继续支付' })).not.toBeInTheDocument();
  });

  it('fails closed for paid, expired, or foreign-owner payment requests', async () => {
    await expect(
      commerceGateway.requestOrderPayment(ORDER_ID, { ownerId: OWNER }),
    ).rejects.toMatchObject({ message: 'ORDER_NOT_PAYABLE', outcome: 'DEFINITIVE_FAILURE' });
    await expect(
      commerceGateway.requestOrderPayment('0198f4d4-21c2-7b7d-8a03-08a0da2a7202', {
        ownerId: OWNER,
      }),
    ).rejects.toMatchObject({ message: 'ORDER_NOT_PAYABLE', outcome: 'DEFINITIVE_FAILURE' });
    await expect(
      commerceGateway.requestOrderPayment('0198f4d4-21c2-7b7d-8a03-08a0da2a7202', {
        ownerId: OTHER_OWNER,
      }),
    ).rejects.toMatchObject({ message: 'ORDER_NOT_PAYABLE', outcome: 'DEFINITIVE_FAILURE' });
  });
});

describe('invoice applications', () => {
  it('keeps exact fen precision and rejects ineligible response shapes', () => {
    expect(formatMinorAmount('10001', 'CNY')).toBe('¥100.01');
    expect(formatMinorAmount('900719925474099301', 'CNY')).toBe('¥9,007,199,254,740,993.01');
    expect(() =>
      parseInvoiceCandidatePage({
        ...candidates,
        items: [{ ...candidates.items[0], eligible: true }],
      }),
    ).toThrow('INVALID_INVOICE_CANDIDATE');
  });

  it('prevents duplicate selection and duplicate application while pending', async () => {
    let resolve!: (value: { id: string; status: 'SUBMITTED' }) => void;
    const createInvoice = vi.fn<CommerceGateway['createInvoice']>(
      () => new Promise((done) => (resolve = done)),
    );
    const api = gateway({ createInvoice });
    const user = userEvent.setup();
    render(<InvoiceCenter initial={candidates} gateway={api} ownerId={OWNER} />);
    await user.click(screen.getByRole('checkbox', { name: /100\.01/ }));
    await user.type(screen.getByLabelText('发票抬头'), '上海光帧科技有限公司');
    await user.type(screen.getByLabelText('纳税人识别号'), '91310000MA1K12345X');
    await user.type(screen.getByLabelText('接收邮箱'), 'billing@example.cn');
    await user.click(screen.getByRole('button', { name: '核对开票信息' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('¥100.01');
    const confirm = screen.getByRole('button', { name: '确认申请' });
    await user.click(confirm);
    fireEvent.click(confirm);
    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(createInvoice.mock.calls[0]?.[0].orderIds).toEqual([ORDER_ID]);
    resolve({ id: '0198f4d4-21c2-7b7d-8a03-08a0da2a7301', status: 'SUBMITTED' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('checkbox', { name: /100\.01/ })).not.toBeInTheDocument();
    expect(screen.getByText('暂无可开票金额')).toBeVisible();
    expect(screen.getByText('合计 ¥0.00')).toBeVisible();
  });

  it('rechecks paid ownership server-side instead of trusting client eligibility', async () => {
    await expect(
      commerceGateway.createInvoice(
        {
          orderIds: [ORDER_ID],
          title: '伪造抬头',
          taxNumber: '91310000MA1K12345X',
          email: 'billing@example.cn',
        },
        {
          ownerId: OTHER_OWNER,
          idempotencyKey: '0198f4d4-21c2-7b7d-8a03-08a0da2a7998',
        },
      ),
    ).rejects.toMatchObject({ outcome: 'DEFINITIVE_FAILURE' });
  });

  it('replays one invoice idempotently but blocks a second application for the same order', async () => {
    const input = {
      orderIds: [ORDER_ID],
      title: '上海光帧科技有限公司',
      taxNumber: '91310000MA1K12345X',
      email: 'billing@example.cn',
    };
    const context = {
      ownerId: OWNER,
      idempotencyKey: '0198f4d4-21c2-7b7d-8a03-08a0da2a7997',
    };
    const first = await commerceGateway.createInvoice(input, context);
    await expect(commerceGateway.createInvoice(input, context)).resolves.toEqual(first);
    await expect(
      commerceGateway.createInvoice(input, {
        ...context,
        idempotencyKey: '0198f4d4-21c2-7b7d-8a03-08a0da2a7996',
      }),
    ).rejects.toMatchObject({
      message: 'ORDER_NOT_INVOICE_ELIGIBLE',
      outcome: 'DEFINITIVE_FAILURE',
    });
  });
});
