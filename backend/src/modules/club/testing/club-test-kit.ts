import type { AdminAuditPort, AuditEntry } from '../../../common/contracts/admin';
import type {
  AdminAccess,
  IdentityPort,
  MarketingAudiencePage,
  UserSummary,
} from '../../../common/contracts/identity';
import type { OutboxEventType, TypedOutboxEventInput } from '../../../common/contracts/events';
import type { ModuleRef } from '@nestjs/core';
import type { AppConfig } from '../../../common/config';
import { RECEIPTS_PORT } from '../../../common/contracts/receipts';
import type { OutboxService } from '../../../common/outbox/outbox.service';
import { FakeClock } from '../../../common/time/clock';
import { type ClubConfig, DEFAULT_CLUB_CONFIG } from '../club.config';
import { ClubAccountService } from '../services/club-account.service';
import { ClubJobsService } from '../services/club-jobs.service';
import { LedgerService } from '../services/ledger.service';
import {
  PendingModerationReader,
  type PendingSummaryCapablePort,
} from '../services/pending-moderation.reader';
import { RuleSetsService } from '../services/rule-sets.service';
import { InMemoryClubRepository } from './in-memory-club.repository';

export const TEST_MEMBER_QR_SECRET = 'test-only-member-qr-secret';

/** Records what the club publishes instead of writing outbox rows. */
export class RecordingOutbox {
  readonly events: TypedOutboxEventInput[] = [];

  async publish(_tx: unknown, event: TypedOutboxEventInput): Promise<string> {
    this.events.push(event);
    return `event-${this.events.length}`;
  }

  ofType<T extends OutboxEventType>(type: T): Array<TypedOutboxEventInput<T>> {
    return this.events.filter((event): event is TypedOutboxEventInput<T> => event.type === type);
  }

  clear(): void {
    this.events.length = 0;
  }
}

export class RecordingAudit implements AdminAuditPort {
  readonly entries: AuditEntry[] = [];

  async audit(entry: AuditEntry): Promise<string> {
    this.entries.push(entry);
    return `audit-${this.entries.length}`;
  }
}

/** Identity fake: users registered with `add()`, everyone else is unknown. */
export class FakeIdentity implements IdentityPort {
  readonly users = new Map<string, UserSummary>();

  add(userId: string, memberCode: string, overrides: Partial<UserSummary> = {}): UserSummary {
    const user: UserSummary = {
      id: userId,
      phone: '+380501234567',
      email: null,
      firstName: 'Олег',
      lastName: null,
      birthDate: null,
      status: 'active',
      memberCode,
      profileCompletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
      ...overrides,
    };
    this.users.set(userId, user);
    return user;
  }

  async getUser(userId: string): Promise<UserSummary | null> {
    return this.users.get(userId) ?? null;
  }

  async getUsers(userIds: readonly string[]): Promise<UserSummary[]> {
    return userIds.flatMap((id) => {
      const user = this.users.get(id);
      return user ? [user] : [];
    });
  }

  async getDevice(): Promise<null> {
    return null;
  }

  async resolveMemberCode(memberCode: string): Promise<UserSummary | null> {
    return [...this.users.values()].find((user) => user.memberCode === memberCode) ?? null;
  }

  async listPushDevices(): Promise<[]> {
    return [];
  }

  async hasConsent(): Promise<boolean> {
    return true;
  }

  async listMarketingAudience(): Promise<MarketingAudiencePage> {
    return { userIds: [], nextCursor: null };
  }

  async getAdminAccess(): Promise<AdminAccess | null> {
    return null;
  }
}

/**
 * Stands in for the application container that PendingModerationReader searches for
 * RECEIPTS_PORT: `receipts` is what the lookup returns (null = no receipts module).
 */
export class FakePortLocator {
  receipts: PendingSummaryCapablePort | null = null;

  get<T = unknown>(token: symbol): T {
    if (token === RECEIPTS_PORT && this.receipts) {
      return this.receipts as T;
    }
    throw new Error(`Nest could not find ${String(token)} element`);
  }

  asModuleRef(): ModuleRef {
    return this as unknown as ModuleRef;
  }
}

export interface ClubTestKit {
  clock: FakeClock;
  repo: InMemoryClubRepository;
  outbox: RecordingOutbox;
  audit: RecordingAudit;
  identity: FakeIdentity;
  ports: FakePortLocator;
  clubConfig: ClubConfig;
  ruleSets: RuleSetsService;
  ledger: LedgerService;
  accounts: ClubAccountService;
  jobs: ClubJobsService;
}

/** Club services wired over the in-memory repository, a recording outbox and a fake clock. */
export function createClubTestKit(
  now: string | Date = '2026-11-01T10:00:00.000Z',
  clubConfig: Partial<ClubConfig> = {},
): ClubTestKit {
  const clock = new FakeClock(now);
  const repo = new InMemoryClubRepository();
  const outbox = new RecordingOutbox();
  const audit = new RecordingAudit();
  const identity = new FakeIdentity();
  const ports = new FakePortLocator();
  const config: ClubConfig = { ...DEFAULT_CLUB_CONFIG, ...clubConfig };
  const outboxService = outbox as unknown as OutboxService;
  const ruleSets = new RuleSetsService(repo, clock, audit);
  const ledger = new LedgerService(repo, ruleSets, outboxService, clock);
  const appConfig = { MEMBER_QR_SECRET: TEST_MEMBER_QR_SECRET } as AppConfig;
  const accounts = new ClubAccountService(
    repo,
    ledger,
    ruleSets,
    clock,
    identity,
    appConfig,
    config,
    new PendingModerationReader(ports.asModuleRef()),
  );
  const jobs = new ClubJobsService(repo, ledger, ruleSets, outboxService, clock);
  return {
    clock,
    repo,
    outbox,
    audit,
    identity,
    ports,
    clubConfig: config,
    ruleSets,
    ledger,
    accounts,
    jobs,
  };
}
