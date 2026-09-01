type DisableResult = 'disabled' | 'not_found' | 'last_super_admin';

interface ManagementParticipant {
  check(adminId: string): DisableResult;
  commit(adminId: string): void;
}
interface AuthParticipant {
  exists(adminId: string): boolean;
  commit(adminId: string, now: Date): void;
}

/**
 * One in-process transaction boundary shared by the memory IAM and auth adapters.
 * Both participants must be registered before disabling, so partial state cannot
 * be produced by a detached adapter.
 */
export class MemoryAdminAccessCoordinator {
  private management?: ManagementParticipant;
  private auth?: AuthParticipant;
  private tail: Promise<void> = Promise.resolve();

  registerManagement(participant: ManagementParticipant): void {
    if (this.management) throw stableError('MEMORY_DISABLE_PARTICIPANT_ALREADY_REGISTERED');
    this.management = participant;
  }

  registerAuth(participant: AuthParticipant): void {
    if (this.auth) throw stableError('MEMORY_DISABLE_PARTICIPANT_ALREADY_REGISTERED');
    this.auth = participant;
  }

  runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.lock(operation);
  }

  disableAdminAccess(
    adminId: string,
    now: Date,
    observe?: (result: DisableResult) => void,
  ): Promise<DisableResult> {
    return this.lock(() => this.disableAdminAccessLocked(adminId, now, observe));
  }

  disableAdminAccessGuarded(
    adminId: string,
    now: Date,
    authorize: () => boolean,
    onDenied: () => void,
    observe?: (result: DisableResult) => void,
  ): Promise<DisableResult | 'actor_denied'> {
    return this.lock(() => {
      if (!authorize()) {
        onDenied();
        return 'actor_denied';
      }
      return this.disableAdminAccessLocked(adminId, now, observe);
    });
  }

  private disableAdminAccessLocked(
    adminId: string,
    now: Date,
    observe?: (result: DisableResult) => void,
  ): DisableResult {
    if (!this.management || !this.auth) {
      throw stableError('ADMIN_DISABLE_COORDINATOR_UNAVAILABLE');
    }
    if (!this.auth.exists(adminId)) throw stableError('ADMIN_DISABLE_STATE_MISMATCH');
    const managementResult = this.management.check(adminId);
    if (managementResult !== 'disabled') {
      observe?.(managementResult);
      return managementResult;
    }
    this.management.commit(adminId);
    this.auth.commit(adminId, now);
    observe?.('disabled');
    return 'disabled';
  }

  private async lock<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
