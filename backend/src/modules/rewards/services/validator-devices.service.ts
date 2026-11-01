import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ValidatorDevice } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { hashPassword, randomToken, sha256Hex } from '../../../common/auth/crypto';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import {
  CONTENT_PORT,
  type ContentPort,
  type TenantSummary,
} from '../../../common/contracts/content';
import type { ActorRef } from '../../../common/contracts/shared';
import { CommonErrors } from '../../../common/errors/error-codes';
import { DomainError } from '../../../common/errors/domain-error';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { type CreatedAtCursor, createdAtCursorOf, isCreatedAtCursor } from '../domain/cursors';
import { RewardsErrors } from '../domain/errors';
import {
  type RedemptionLogWithVoucher,
  RewardsRepository,
  type ValidatorDevicePatch,
} from './rewards.repository';
import { tryPort } from './safe-port';

export interface DeviceListQuery {
  tenantId?: string | undefined;
  active?: boolean | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface CreateDeviceInput {
  name: string;
  tenantId?: string | null | undefined;
  pin: string;
}

export interface UpdateDeviceInput {
  name?: string | undefined;
  tenantId?: string | null | undefined;
  active?: boolean | undefined;
}

export interface AdminContext {
  actor: ActorRef;
  ip?: string | null | undefined;
  reason?: string | null | undefined;
}

/** The raw device key is returned exactly once (on create and on key rotation). */
export interface DeviceWithKey {
  device: ValidatorDevice;
  deviceKey: string;
}

/** Back-office management of validator devices (brief section 8, admin CRUD). */
@Injectable()
export class ValidatorDevicesService {
  private readonly logger = new Logger(ValidatorDevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: RewardsRepository,
    private readonly clock: Clock,
    @Inject(CONTENT_PORT) private readonly content: ContentPort,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  async list(query: DeviceListQuery): Promise<Page<ValidatorDevice>> {
    const cursor = decodeCursor<CreatedAtCursor>(query.cursor, isCreatedAtCursor);
    const rows = await this.repo.listDevices(
      this.prisma,
      { tenantId: query.tenantId, active: query.active },
      { cursor, limit: query.limit },
    );
    return toPage(rows, query.limit, createdAtCursorOf);
  }

  async get(deviceId: string): Promise<ValidatorDevice> {
    return this.requireDevice(deviceId);
  }

  async create(input: CreateDeviceInput, context: AdminContext): Promise<DeviceWithKey> {
    const tenantId = input.tenantId ?? null;
    await this.assertTenantExists(tenantId);
    const deviceKey = randomToken(32);
    const pinHash = await hashPassword(input.pin);
    const now = this.clock.now();
    const device = await this.prisma.withTx(async (tx) => {
      const created = await this.repo.createDevice(tx, {
        id: uuidv7(),
        tenantId,
        name: input.name.trim(),
        pinHash,
        deviceKeyHash: sha256Hex(deviceKey),
        active: true,
        createdAt: now,
      });
      await this.audit.audit(
        {
          actor: context.actor,
          action: 'validator_device.create',
          entityType: 'validator_device',
          entityId: created.id,
          after: this.auditView(created),
          reason: context.reason ?? null,
          ip: context.ip ?? null,
        },
        tx,
      );
      return created;
    });
    return { device, deviceKey };
  }

  async update(
    deviceId: string,
    input: UpdateDeviceInput,
    context: AdminContext,
  ): Promise<ValidatorDevice> {
    const before = await this.requireDevice(deviceId);
    const patch: ValidatorDevicePatch = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.tenantId !== undefined) {
      await this.assertTenantExists(input.tenantId);
      patch.tenantId = input.tenantId;
    }
    if (input.active !== undefined) {
      patch.active = input.active;
      if (input.active) {
        patch.revokedAt = null;
      }
    }
    return this.prisma.withTx(async (tx) => {
      const updated = await this.repo.updateDevice(tx, deviceId, patch);
      await this.audit.audit(
        {
          actor: context.actor,
          action: 'validator_device.update',
          entityType: 'validator_device',
          entityId: deviceId,
          before: this.auditView(before),
          after: this.auditView(updated),
          reason: context.reason ?? null,
          ip: context.ip ?? null,
        },
        tx,
      );
      return updated;
    });
  }

  /** Replaces the device key; the old key stops working immediately. */
  async rotateKey(deviceId: string, context: AdminContext): Promise<DeviceWithKey> {
    await this.requireDevice(deviceId);
    const deviceKey = randomToken(32);
    const device = await this.prisma.withTx(async (tx) => {
      const updated = await this.repo.updateDevice(tx, deviceId, {
        deviceKeyHash: sha256Hex(deviceKey),
      });
      await this.audit.audit(
        {
          actor: context.actor,
          action: 'validator_device.rotate_key',
          entityType: 'validator_device',
          entityId: deviceId,
          reason: context.reason ?? null,
          ip: context.ip ?? null,
        },
        tx,
      );
      return updated;
    });
    return { device, deviceKey };
  }

  /**
   * Sets a new shift PIN; open shifts are closed because the token binds the PIN hash. A PIN
   * lock (5 wrong PINs) and the failure counter are cleared.
   */
  async setPin(deviceId: string, pin: string, context: AdminContext): Promise<ValidatorDevice> {
    await this.requireDevice(deviceId);
    const pinHash = await hashPassword(pin);
    return this.prisma.withTx(async (tx) => {
      const updated = await this.repo.updateDevice(tx, deviceId, {
        pinHash,
        failedPinAttempts: 0,
        pinLockedUntil: null,
      });
      await this.audit.audit(
        {
          actor: context.actor,
          action: 'validator_device.set_pin',
          entityType: 'validator_device',
          entityId: deviceId,
          reason: context.reason ?? null,
          ip: context.ip ?? null,
        },
        tx,
      );
      return updated;
    });
  }

  /** Remote revocation: the device stops authenticating on its next request. */
  async revoke(deviceId: string, context: AdminContext): Promise<ValidatorDevice> {
    const before = await this.requireDevice(deviceId);
    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      const updated =
        before.revokedAt !== null && !before.active
          ? before
          : await this.repo.updateDevice(tx, deviceId, { active: false, revokedAt: now });
      await this.audit.audit(
        {
          actor: context.actor,
          action: 'validator_device.revoke',
          entityType: 'validator_device',
          entityId: deviceId,
          before: this.auditView(before),
          after: this.auditView(updated),
          reason: context.reason ?? null,
          ip: context.ip ?? null,
        },
        tx,
      );
      return updated;
    });
  }

  async listLog(
    deviceId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<RedemptionLogWithVoucher>> {
    await this.requireDevice(deviceId);
    const decoded = decodeCursor<CreatedAtCursor>(cursor, isCreatedAtCursor);
    const rows = await this.repo.listRedemptionLogs(
      this.prisma,
      { deviceId },
      { cursor: decoded, limit },
    );
    return toPage(rows, limit, createdAtCursorOf);
  }

  private async requireDevice(deviceId: string): Promise<ValidatorDevice> {
    const device = await this.repo.findDeviceById(this.prisma, deviceId);
    if (!device) {
      throw new DomainError(
        RewardsErrors.PC_VALIDATOR_NOT_FOUND,
        `Validator device ${deviceId} not found`,
      );
    }
    return device;
  }

  /** Hashes never reach the audit log. */
  private auditView(device: ValidatorDevice): Record<string, unknown> {
    return {
      id: device.id,
      name: device.name,
      tenantId: device.tenantId,
      active: device.active,
      revokedAt: device.revokedAt,
    };
  }

  private async assertTenantExists(tenantId: string | null): Promise<void> {
    if (tenantId === null) {
      return;
    }
    // 'unknown' means the content port could not answer: the check is skipped, not failed.
    const tenant = await tryPort<TenantSummary | null | 'unknown'>(
      this.logger,
      'content.getTenant',
      () => this.content.getTenant(tenantId),
      'unknown',
    );
    if (tenant === null) {
      throw new DomainError(
        CommonErrors.PC_COMMON_VALIDATION,
        `Tenant ${tenantId} does not exist`,
        {
          details: [{ path: 'tenantId', messages: ['tenant does not exist'] }],
        },
      );
    }
  }
}
