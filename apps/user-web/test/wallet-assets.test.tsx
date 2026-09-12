import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { AssetLibrary } from '../components/commerce/asset-library';
import { InvoiceCenter } from '../components/commerce/invoice-center';
import { OrderCenter } from '../components/commerce/order-center';
import { WalletSummary } from '../components/commerce/wallet-summary';
import { commerceGateway } from '../lib/commerce/gateway';
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

const OWNER = '+8613800138000';
const OTHER_OWNER = '+8613900139000';
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
    uploadAsset: vi.fn().mockResolvedValue(assets.items[0]),
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
        kind: 'QR_CODE',
        qrCodeUrl: 'https://pay.weixin.qq.com/pay/example',
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  authState.value = {
    kind: 'active',
    session: { ownerId: OWNER },
  };
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
            type: 'RECHARGE',
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
  });

  it('aborts an upload and announces cancellation', async () => {
    const uploadAsset = vi.fn<CommerceGateway['uploadAsset']>(
      (_file, options) =>
        new Promise(() => {
          options.onProgress(25);
        }),
    );
    const user = userEvent.setup();
    render(<AssetLibrary initial={assets} gateway={gateway({ uploadAsset })} ownerId={OWNER} />);
    const file = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
    await user.upload(screen.getByLabelText('上传图片或视频'), file);
    expect(await screen.findByText('25%')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '取消上传' }));
    expect(await screen.findByRole('status')).toHaveTextContent('上传已取消');
    expect(uploadAsset.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it('requires an explicit dialog confirmation before deletion', async () => {
    const deleteAsset = vi.fn<CommerceGateway['deleteAsset']>().mockResolvedValue({
      accepted: true,
    });
    const api = gateway({ deleteAsset });
    const user = userEvent.setup();
    render(<AssetLibrary initial={assets} gateway={api} ownerId={OWNER} />);
    await user.click(screen.getByRole('button', { name: '删除海边公路.mp4' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('可在 7 天内恢复');
    expect(deleteAsset).not.toHaveBeenCalled();
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
    expect(await screen.findByText('微信支付')).toBeVisible();
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
          kind: 'QR_CODE',
          qrCodeUrl: 'javascript:alert(1)',
          expiresAt: '2026-09-12T10:15:00.000Z',
          html: '<script>steal()</script>',
        },
      }),
    ).toThrow('INVALID_PAYMENT_PAYLOAD');
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
