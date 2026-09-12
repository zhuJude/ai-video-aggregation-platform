export type TicketPolicyStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';

export function canTransitionTicket(
  from: TicketPolicyStatus,
  to: TicketPolicyStatus,
  resolvedAt: string | null,
  hasAdminPublicReply: boolean,
  now = Date.now(),
): boolean {
  if (from === 'OPEN') return to === 'IN_PROGRESS';
  if (from === 'IN_PROGRESS') return to === 'RESOLVED' && hasAdminPublicReply;
  if (from === 'RESOLVED' && to === 'IN_PROGRESS' && resolvedAt) {
    const resolved = Date.parse(resolvedAt);
    return Number.isFinite(resolved) && now >= resolved && now - resolved <= 7 * 24 * 60 * 60 * 1000;
  }
  if (from === 'RESOLVED') return to === 'CLOSED';
  return false;
}
