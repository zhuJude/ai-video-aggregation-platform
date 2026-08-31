'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  auditCapabilityDocument,
  prepareCapabilityParameters,
  type PreparedCapabilityParameters,
} from '../../lib/studio/capability';
import { studioGateway as defaultGateway } from '../../lib/studio/gateway';
import {
  assertCatalogConsistency,
  parseCapability,
  parseModels,
  parseProviders,
  parseQuote,
} from '../../lib/studio/runtime';
import type {
  ProSelection,
  SmartPreferences,
  StudioCapabilityDocument,
  StudioGateway,
  StudioModelOption,
  StudioProviderOption,
  StudioQuote,
  StudioQuoteRequest,
} from '../../lib/studio/types';
import type { RetryDraft } from '../../lib/tasks/types';
import { CapabilityForm } from './capability-form';
import { ProMode } from './pro-mode';
import { QuoteConfirmation } from './quote-confirmation';
import { SmartMode } from './smart-mode';

interface StudioWorkspaceProps {
  readonly gateway?: StudioGateway;
  readonly retryDraft?: RetryDraft | undefined;
  readonly retryDraftRequested?: boolean | undefined;
}

const INITIAL_SMART_PREFERENCES: SmartPreferences = {
  generationMode: 'IMAGE_TO_VIDEO',
  quality: 'BALANCED',
  speed: 'BALANCED',
  budgetPoints: 300,
  goal: '',
};

const INITIAL_PRO_SELECTION: ProSelection = {
  providerId: '',
  modelId: '',
  allowEquivalentFallback: false,
};

export function StudioWorkspace({
  gateway = defaultGateway,
  retryDraft,
  retryDraftRequested = false,
}: StudioWorkspaceProps) {
  const initialMode = retryDraft ? 'PRO' : 'SMART';
  const initialSmartPreferencesRef = useRef<SmartPreferences>(
    retryDraft
      ? { ...INITIAL_SMART_PREFERENCES, generationMode: retryDraft.generationMode }
      : INITIAL_SMART_PREFERENCES,
  );
  const initialSmartPreferences = initialSmartPreferencesRef.current;
  const initialProSelectionRef = useRef<ProSelection>(
    retryDraft ? { ...INITIAL_PRO_SELECTION, modelId: retryDraft.modelId } : INITIAL_PRO_SELECTION,
  );
  const initialProSelection = initialProSelectionRef.current;
  const [studioMode, setStudioMode] = useState<'SMART' | 'PRO'>(initialMode);
  const [smartPreferences, setSmartPreferences] = useState(initialSmartPreferences);
  const [proSelection, setProSelection] = useState(initialProSelection);
  const [providers, setProviders] = useState<readonly StudioProviderOption[]>([]);
  const [models, setModels] = useState<readonly StudioModelOption[]>([]);
  const [document, setDocument] = useState<StudioCapabilityDocument>();
  const [formValues, setFormValues] = useState<Readonly<Record<string, unknown>>>({});
  const [formValid, setFormValid] = useState(false);
  const [loadingCapability, setLoadingCapability] = useState(true);
  const [pageError, setPageError] = useState<string>();
  const [quote, setQuote] = useState<StudioQuote>();
  const [quoting, setQuoting] = useState(false);
  const studioModeRef = useRef<'SMART' | 'PRO'>(initialMode);
  const modelsRef = useRef<readonly StudioModelOption[]>([]);
  const capabilityRequestId = useRef(0);
  const quoteRequestId = useRef(0);

  const invalidateQuote = useCallback(() => {
    quoteRequestId.current += 1;
    setQuote(undefined);
    setQuoting(false);
  }, []);

  const loadSmartCapability = useCallback(
    async (preferences: SmartPreferences) => {
      const requestId = ++capabilityRequestId.current;
      setLoadingCapability(true);
      setDocument(undefined);
      setFormValid(false);
      setFormValues({});
      setPageError(undefined);
      invalidateQuote();
      try {
        const nextDocument = parseCapability(
          await gateway.getSmartCapability(preferences.generationMode),
        );
        if (nextDocument.mode !== preferences.generationMode) {
          throw new Error('SMART_CAPABILITY_MODE_MISMATCH');
        }
        if (requestId === capabilityRequestId.current) setDocument(nextDocument);
      } catch {
        if (requestId === capabilityRequestId.current) {
          setDocument(undefined);
          setPageError('暂时无法加载这类生成能力，请稍后重试。');
        }
      } finally {
        if (requestId === capabilityRequestId.current) setLoadingCapability(false);
      }
    },
    [gateway, invalidateQuote],
  );

  const loadProCapability = useCallback(
    async (modelId: string) => {
      const requestId = ++capabilityRequestId.current;
      setLoadingCapability(true);
      setDocument(undefined);
      setFormValid(false);
      setFormValues({});
      setPageError(undefined);
      invalidateQuote();
      if (!modelId) {
        setLoadingCapability(false);
        setPageError('当前平台没有可用模型，请选择其他平台或稍后重试。');
        return;
      }
      try {
        const selectedModel = modelsRef.current.find((model) => model.id === modelId);
        if (!selectedModel || selectedModel.status !== 'ACTIVE') {
          throw new Error('MODEL_UNAVAILABLE');
        }
        const nextDocument = parseCapability(await gateway.getCapability(modelId));
        if (nextDocument.capabilityVersion !== selectedModel.capabilityVersion) {
          throw new Error('CAPABILITY_VERSION_MISMATCH');
        }
        if (requestId === capabilityRequestId.current) setDocument(nextDocument);
      } catch {
        if (requestId === capabilityRequestId.current) {
          setDocument(undefined);
          setPageError('所选模型当前不可用，请选择其他可用模型。');
        }
      } finally {
        if (requestId === capabilityRequestId.current) setLoadingCapability(false);
      }
    },
    [gateway, invalidateQuote],
  );

  useEffect(() => {
    let active = true;
    void Promise.all([gateway.listProviders(), gateway.listModels()])
      .then(([providerPayload, modelPayload]) => {
        if (!active) return;
        const nextProviders = parseProviders(providerPayload);
        const nextModels = parseModels(modelPayload);
        assertCatalogConsistency(nextProviders, nextModels);
        modelsRef.current = nextModels;
        setProviders(nextProviders);
        setModels(nextModels);
        const draftModel = retryDraft
          ? nextModels.find((model) => model.id === retryDraft.modelId && model.status === 'ACTIVE')
          : undefined;
        const firstActive = draftModel ?? nextModels.find((model) => model.status === 'ACTIVE');
        setProSelection((current) => ({
          ...current,
          providerId: firstActive?.providerId ?? nextProviders[0]?.id ?? '',
          modelId: firstActive?.id ?? '',
        }));
        if (studioModeRef.current === 'PRO') {
          void loadProCapability(firstActive?.id ?? '');
        }
      })
      .catch(() => {
        if (active) {
          modelsRef.current = [];
          setProviders([]);
          setModels([]);
          setProSelection(INITIAL_PRO_SELECTION);
          if (studioModeRef.current === 'PRO') {
            capabilityRequestId.current += 1;
            setDocument(undefined);
            setFormValues({});
            setFormValid(false);
            setLoadingCapability(false);
            invalidateQuote();
          }
          setPageError('工作台配置加载失败，请稍后重试。');
        }
      });
    if (studioModeRef.current === 'SMART') void loadSmartCapability(initialSmartPreferences);
    return () => {
      active = false;
      capabilityRequestId.current += 1;
      quoteRequestId.current += 1;
    };
  }, [gateway, initialSmartPreferences, loadProCapability, loadSmartCapability, retryDraft]);

  const handleCapabilityChange = useCallback(
    (values: Readonly<Record<string, unknown>>, result: PreparedCapabilityParameters) => {
      setFormValues(values);
      setFormValid(result.valid);
      invalidateQuote();
    },
    [invalidateQuote],
  );
  const handleValid = useCallback(() => {
    setFormValid(true);
  }, []);

  const changeSmartPreferences = (next: SmartPreferences) => {
    const modeChanged = next.generationMode !== smartPreferences.generationMode;
    setSmartPreferences(next);
    invalidateQuote();
    if (modeChanged) void loadSmartCapability(next);
  };

  const changeProSelection = (next: ProSelection) => {
    const modelChanged = next.modelId !== proSelection.modelId;
    setProSelection(next);
    invalidateQuote();
    if (modelChanged) void loadProCapability(next.modelId);
  };

  const selectStudioMode = (nextMode: 'SMART' | 'PRO') => {
    if (nextMode === studioMode) return;
    studioModeRef.current = nextMode;
    setStudioMode(nextMode);
    invalidateQuote();
    if (nextMode === 'PRO') void loadProCapability(proSelection.modelId);
    else void loadSmartCapability(smartPreferences);
  };

  const requestQuote = async () => {
    if (!document || quoting) return;
    setPageError(undefined);
    const unsupported = auditCapabilityDocument(document);
    if (unsupported.length > 0) {
      setPageError(
        `模型配置暂不可用（Schema ${String(document.schemaVersion)}，能力版本 ${document.capabilityVersion}）。`,
      );
      return;
    }

    const prepared = prepareCapabilityParameters(document, formValues);
    if (!prepared.valid) {
      setFormValid(false);
      setPageError('请先修正可见参数中的错误，再获取报价。');
      return;
    }
    const selectedModel =
      studioMode === 'PRO' ? models.find((model) => model.id === proSelection.modelId) : undefined;
    if (studioMode === 'PRO') {
      if (!selectedModel || selectedModel.status !== 'ACTIVE') {
        setPageError('专业模式必须选择一个当前可用的精确模型。');
        return;
      }
    }

    const requestId = ++quoteRequestId.current;
    setQuoting(true);
    try {
      const quoteRequest: StudioQuoteRequest = {
        capabilityVersion: document.capabilityVersion,
        parameters: prepared.parameters,
        routing:
          studioMode === 'SMART'
            ? { kind: 'SMART', preferences: smartPreferences }
            : { kind: 'EXACT_MODEL', ...proSelection },
      };
      const nextQuote = parseQuote(
        await gateway.quote(quoteRequest),
        quoteRequest,
        document,
        selectedModel,
      );
      if (requestId === quoteRequestId.current) setQuote(nextQuote);
    } catch {
      if (requestId === quoteRequestId.current) {
        setPageError('报价未完成，未创建任务也未冻结点数，请稍后重试。');
      }
    } finally {
      if (requestId === quoteRequestId.current) setQuoting(false);
    }
  };

  return (
    <div className="studio-page">
      <header className="studio-intro">
        <p className="section-kicker">AI 视频生成</p>
        <h1>从能力配置到透明报价</h1>
        <p>参数由已发布能力 Schema 动态生成；确认报价前不会创建任务或冻结点数。</p>
      </header>

      {retryDraftRequested && !retryDraft ? (
        <p className="form-feedback form-error" role="alert">
          这个重试草稿已失效，请从原任务重新创建。
        </p>
      ) : null}

      <div className="studio-mode-switch" role="group" aria-label="生成模式">
        <button
          aria-pressed={studioMode === 'SMART'}
          type="button"
          onClick={() => {
            selectStudioMode('SMART');
          }}
        >
          智能模式
        </button>
        <button
          aria-pressed={studioMode === 'PRO'}
          type="button"
          onClick={() => {
            selectStudioMode('PRO');
          }}
        >
          专业模式
        </button>
      </div>

      {studioMode === 'SMART' ? (
        <SmartMode value={smartPreferences} onChange={changeSmartPreferences} />
      ) : (
        <ProMode
          models={models}
          providers={providers}
          value={proSelection}
          onChange={changeProSelection}
        />
      )}

      <section className="studio-capability" aria-labelledby="capability-title">
        <div className="studio-section-heading">
          <div>
            <h2 id="capability-title">生成参数</h2>
            <p>字段、顺序、依赖和校验全部来自当前能力版本。</p>
          </div>
          {document ? <span>能力版本 {document.capabilityVersion}</span> : null}
        </div>

        {loadingCapability ? (
          <div className="studio-loading" role="status">
            正在加载模型能力
          </div>
        ) : document ? (
          <CapabilityForm
            document={document}
            initialValues={
              retryDraft?.capabilityVersion === document.capabilityVersion
                ? retryDraft.parameters
                : undefined
            }
            onChange={handleCapabilityChange}
            onValid={handleValid}
          />
        ) : null}
      </section>

      {pageError ? (
        <p className="form-feedback form-error" role="alert">
          {pageError}
        </p>
      ) : null}

      {!quote ? (
        <div className="studio-quote-action">
          <p>提交报价时会重新执行完整 AJV 校验，包括未知字段和跨字段约束。</p>
          <button
            className="button-link button-primary"
            disabled={loadingCapability || quoting || !formValid}
            type="button"
            onClick={() => void requestQuote()}
          >
            {quoting ? '正在获取报价' : '获取准确报价'}
          </button>
        </div>
      ) : (
        <QuoteConfirmation
          key={quote.id}
          gateway={gateway}
          quote={quote}
          request={{
            quoteId: quote.id,
            capabilityVersion: quote.capabilityVersion,
            parameters: quote.parameters,
            quotedPoints: quote.quotedPoints,
          }}
          onRequote={invalidateQuote}
        />
      )}
    </div>
  );
}
