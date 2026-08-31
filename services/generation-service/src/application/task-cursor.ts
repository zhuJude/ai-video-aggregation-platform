import { GenerationApplicationError } from './errors.js';

export interface TaskCursor {
  readonly createdAt: Date;
  readonly id: string;
}

interface EncodedTaskCursor {
  readonly createdAt: string;
  readonly id: string;
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class TaskCursorCodec {
  encode(cursor: TaskCursor): string {
    const value: EncodedTaskCursor = {
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    };
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  }

  decode(encoded: string): TaskCursor {
    try {
      const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null) throw new Error('INVALID');
      if (!('createdAt' in parsed) || typeof parsed.createdAt !== 'string') {
        throw new Error('INVALID');
      }
      if (!('id' in parsed) || typeof parsed.id !== 'string' || !uuidV7.test(parsed.id)) {
        throw new Error('INVALID');
      }
      const createdAt = new Date(parsed.createdAt);
      if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== parsed.createdAt) {
        throw new Error('INVALID');
      }
      return { createdAt, id: parsed.id };
    } catch {
      throw new GenerationApplicationError('INVALID_CURSOR');
    }
  }
}
