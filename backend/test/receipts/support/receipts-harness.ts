import { uuidv7 } from 'uuidv7';
import { InMemoryQueue } from '../../../src/common/queue/in-memory-queue';
import { QUEUES } from '../../../src/common/queue/queue.constants';
import { InMemoryStorageAdapter } from '../../../src/common/storage/in-memory-storage.adapter';
import { FakeClock } from '../../../src/common/time/clock';
import { formatKyiv } from '../../../src/common/time/kyiv';
import {
  DEFAULT_RECEIPTS_CONFIG,
  type ReceiptsConfig,
} from '../../../src/modules/receipts/receipts.config';
import { ReceiptModerationService } from '../../../src/modules/receipts/services/receipt-moderation.service';
import { ReceiptPhotoService } from '../../../src/modules/receipts/services/receipt-photo.service';
import { ReceiptPipelineService } from '../../../src/modules/receipts/services/receipt-pipeline.service';
import { ReceiptProcessQueue } from '../../../src/modules/receipts/services/receipt-process.queue';
import {
  type MemberContext,
  ReceiptSubmissionService,
} from '../../../src/modules/receipts/services/receipt-submission.service';
import { ExpectedPointsService } from '../../../src/modules/receipts/services/expected-points.service';
import { ReceiptVerificationService } from '../../../src/modules/receipts/services/receipt-verification.service';
import { ReceiptsPortService } from '../../../src/modules/receipts/services/receipts-port.service';
import { createFakePrisma } from './fake-tx';
import {
  FakeAudit,
  FakeContent,
  FakeFlags,
  FakeIdentity,
  FakeLedger,
  FakeOutbox,
  FakeTaxVerifier,
} from './fake-ports';
import { InMemoryReceiptsRepository } from './in-memory-receipts.repository';

/** 2026-01-15 12:00 Kyiv (UTC+2). */
export const HARNESS_NOW = '2026-01-15T10:00:00.000Z';
/** Registration of MEMBER and OTHER_MEMBER: a year before HARNESS_NOW (no new-account hold). */
export const ESTABLISHED_ACCOUNT_CREATED_AT = new Date('2025-01-15T10:00:00.000Z');

export const INTERTOP_ID = '0192f3a0-0000-7000-8000-000000000001';
export const TAMTAM_ID = '0192f3a0-0000-7000-8000-000000000002';
export const INTERTOP_FN = '4000100011';
export const TAMTAM_FN = '4000200022';
export const UNKNOWN_FN = '4999999999';

export const MEMBER: MemberContext = {
  userId: '0192f3a0-1111-7000-8000-000000000001',
  deviceId: '0192f3a0-2222-7000-8000-000000000001',
};
export const OTHER_MEMBER: MemberContext = {
  userId: '0192f3a0-1111-7000-8000-000000000002',
  deviceId: '0192f3a0-2222-7000-8000-000000000002',
};
export const MODERATOR = { adminId: '0192f3a0-3333-7000-8000-000000000001', ip: '10.0.0.7' };

export interface TaxQrInput {
  fn?: string;
  fiscalId?: string;
  issuedAt: Date;
  totalKopecks: number;
}

/** Builds a tax-service QR URL with the Kyiv wall-clock date and time of `issuedAt`. */
export function taxQr(input: TaxQrInput): string {
  const date = formatKyiv(input.issuedAt, 'yyyyMMdd');
  const time = formatKyiv(input.issuedAt, 'HHmmss');
  const sm = (input.totalKopecks / 100).toFixed(2);
  return `https://cabinet.tax.gov.ua/cashregs/check?fn=${input.fn ?? INTERTOP_FN}&id=${
    // The tail of a UUID v7 is random; its head is the millisecond timestamp, which collides
    // when two receipts are generated within the same millisecond.
    input.fiscalId ?? uuidv7().replace(/-/g, '').slice(-12)
  }&date=${date}&time=${time}&sm=${sm}`;
}

/**
 * Receipts services wired with in-memory fakes of every dependency (repository, ledger,
 * content, identity, tax checker, audit, flags, outbox, queue, storage) and a fake clock. Seeds
 * INTERTOP (whitelisted fn) and TamTam (excluded from the program); MEMBER and OTHER_MEMBER are
 * established accounts (registered a year ago), so small QR receipts are credited at once.
 */
export function createReceiptsHarness(configOverrides: Partial<ReceiptsConfig> = {}) {
  const clock = new FakeClock(HARNESS_NOW);
  const repo = new InMemoryReceiptsRepository(clock);
  const ledger = new FakeLedger(clock);
  const content = new FakeContent(clock);
  const identity = new FakeIdentity();
  const verifier = new FakeTaxVerifier();
  const audit = new FakeAudit();
  const flags = new FakeFlags();
  const outbox = new FakeOutbox();
  const prisma = createFakePrisma([repo, ledger, content, audit, outbox]);
  const queueBackend = new InMemoryQueue(QUEUES.receiptsProcess);
  const queue = new ReceiptProcessQueue(queueBackend);
  const storage = new InMemoryStorageAdapter('memory', clock);
  const config: ReceiptsConfig = { ...DEFAULT_RECEIPTS_CONFIG, ...configOverrides };
  const photos = new ReceiptPhotoService(storage, clock, config);
  // The in-memory repository mirrors ReceiptsRepository method by method.
  const repository = repo as unknown as ConstructorParameters<typeof ReceiptPipelineService>[1];
  const pipeline = new ReceiptPipelineService(
    prisma.service,
    repository,
    outbox.asService(),
    clock,
    content,
    ledger,
    identity.asPort(),
    verifier,
    config,
  );
  const expected = new ExpectedPointsService(clock, content, ledger);
  const submission = new ReceiptSubmissionService(
    prisma.service,
    repository,
    outbox.asService(),
    clock,
    pipeline,
    photos,
    queue,
    content,
    ledger,
    flags,
    expected,
  );
  const moderation = new ReceiptModerationService(
    prisma.service,
    repository,
    outbox.asService(),
    clock,
    pipeline,
    photos,
    queue,
    content,
    audit,
    expected,
  );
  const verification = new ReceiptVerificationService(
    prisma.service,
    repository,
    outbox.asService(),
    clock,
    pipeline,
    ledger,
  );
  const port = new ReceiptsPortService(prisma.service, repository, expected);

  identity.createdAt.set(MEMBER.userId, ESTABLISHED_ACCOUNT_CREATED_AT);
  identity.createdAt.set(OTHER_MEMBER.userId, ESTABLISHED_ACCOUNT_CREATED_AT);

  content.addTenant({ id: INTERTOP_ID, name: 'INTERTOP', category: 'fashion' });
  content.addTenant({
    id: TAMTAM_ID,
    name: 'ТамТам',
    category: 'hypermarket',
    excludedFromProgram: true,
  });
  content.addFiscalNumber(INTERTOP_FN, INTERTOP_ID, 'active');
  content.addFiscalNumber(TAMTAM_FN, TAMTAM_ID, 'active');

  /** Uploads a photo through the presigned flow and returns its key. */
  async function uploadPhoto(
    member: MemberContext = MEMBER,
    contentType: 'image/jpeg' | 'image/png' | 'image/heic' = 'image/jpeg',
    body: Buffer = Buffer.alloc(2_048, 1),
  ): Promise<string> {
    const upload = await submission.createPhotoUploadUrl(member.userId, {
      contentType,
      sizeBytes: body.length,
    });
    await storage.simulateUpload(upload.key, body, contentType);
    return upload.key;
  }

  return {
    clock,
    repo,
    ledger,
    content,
    identity,
    verifier,
    audit,
    flags,
    outbox,
    prisma,
    queueBackend,
    queue,
    storage,
    config,
    photos,
    pipeline,
    expected,
    submission,
    moderation,
    verification,
    port,
    uploadPhoto,
  };
}

export type ReceiptsHarness = ReturnType<typeof createReceiptsHarness>;
