export type GenerationErrorCode =
  | 'INVALID_TASK_REQUEST'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_MISMATCH'
  | 'QUOTE_EXPIRED'
  | 'ROUTING_UNAVAILABLE'
  | 'TASK_CREATION_FAILED'
  | 'TASK_CREATION_REPAIR_REQUIRED'
  | 'REPAIR_PERSISTENCE_UNAVAILABLE'
  | 'TASK_NOT_FOUND'
  | 'TASK_STATE_CONFLICT'
  | 'INVALID_CURSOR';

const messages: Record<GenerationErrorCode, string> = {
  INVALID_TASK_REQUEST: 'The task request is invalid.',
  INVALID_IDEMPOTENCY_KEY: 'A valid idempotency key is required.',
  IDEMPOTENCY_CONFLICT: 'The idempotency key was already used for another request.',
  IDEMPOTENCY_IN_PROGRESS: 'The original request is still being processed.',
  QUOTE_NOT_FOUND: 'The quote is unavailable.',
  QUOTE_MISMATCH: 'The quote does not match this request.',
  QUOTE_EXPIRED: 'The quote has expired.',
  ROUTING_UNAVAILABLE: 'Quote validation is temporarily unavailable.',
  TASK_CREATION_FAILED: 'The task could not be created. Reserved points were released.',
  TASK_CREATION_REPAIR_REQUIRED: 'The task could not be created and requires reconciliation.',
  REPAIR_PERSISTENCE_UNAVAILABLE:
    'The task operation requires reconciliation, but repair persistence is temporarily unavailable.',
  TASK_NOT_FOUND: 'The task was not found.',
  TASK_STATE_CONFLICT: 'The task cannot perform this operation in its current state.',
  INVALID_CURSOR: 'The pagination cursor is invalid.',
};

export class GenerationApplicationError extends Error {
  readonly code: GenerationErrorCode;
  readonly retryable: boolean;

  constructor(code: GenerationErrorCode, retryable = false) {
    super(messages[code]);
    this.name = 'GenerationApplicationError';
    this.code = code;
    this.retryable = retryable;
  }
}
