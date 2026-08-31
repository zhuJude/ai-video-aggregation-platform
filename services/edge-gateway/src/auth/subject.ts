export type DataScope = 'ALL' | 'OWN' | 'ASSIGNED';

export interface UserSubject {
  readonly kind: 'user';
  readonly sessionId: string;
  readonly subjectId: string;
}

export interface AdminSubject {
  readonly dataScope: DataScope;
  readonly kind: 'admin';
  readonly permissions: readonly string[];
  readonly sessionId: string;
  readonly subjectId: string;
}

export type AuthenticatedSubject = AdminSubject | UserSubject;

export interface RequestContext {
  readonly correlationId: string;
  readonly traceId: string;
}
