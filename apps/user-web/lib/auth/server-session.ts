import 'server-only';

import { cookies } from 'next/headers';

const SESSION_COOKIE_NAME = '__Host-ai-video-session';

const FIXTURE_SESSIONS = new Map<string, FixtureServerSession>([
  ['fixture-session-a', { ownerId: 'fixture-user-a' }],
  ['fixture-session-b', { ownerId: 'fixture-user-b' }],
]);

export interface FixtureServerSession {
  readonly ownerId: string;
}

export async function readFixtureServerSession(): Promise<FixtureServerSession | undefined> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const session = token ? FIXTURE_SESSIONS.get(token) : undefined;

  return session ? { ...session } : undefined;
}

export async function requireFixtureServerSession(): Promise<FixtureServerSession> {
  const session = await readFixtureServerSession();

  if (!session) {
    throw new Error('AUTHENTICATION_REQUIRED');
  }

  return session;
}
