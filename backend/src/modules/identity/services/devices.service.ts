import { Injectable, Logger } from '@nestjs/common';
import type { Device } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import type { Platform } from '../../../common/contracts/identity';
import {
  IDENTITY_EVENTS,
  OUTBOX_AGGREGATES,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { IdentityErrors } from '../domain/errors';
import type { DeviceDto } from '../dto/common.dto';
import type { DevicesResponseDto, RemoveDeviceResponseDto } from '../dto/me.dto';
import { type DeviceUpdateData, IdentityStore, type IdentityUow } from './identity.store';
import { toDeviceDto } from './mappers';

/** What the app reports about itself at login (OtpVerifyDto.device). */
export interface LoginDeviceInfo {
  platform: Platform;
  model?: string;
  appVersion?: string;
  fingerprint?: string;
  pushToken?: string;
}

/** PATCH-like update of the current device (POST /me/devices). */
export interface DeviceUpdateInput {
  /** `null` removes the token and disables push. */
  pushToken?: string | null;
  pushEnabled?: boolean;
  model?: string;
  appVersion?: string;
}

const clean = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/**
 * Installed app instances of a member. A device row is reused on re-login when the app sends
 * the same installation fingerprint; push tokens are unique per installation, so registering a
 * token removes it from every other row (another member who used the same phone).
 */
@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly store: IdentityStore,
    private readonly clock: Clock,
  ) {}

  async upsertLoginDevice(
    uow: IdentityUow,
    userId: string,
    info: LoginDeviceInfo,
    now: Date,
  ): Promise<{ device: Device; created: boolean }> {
    const fingerprint = clean(info.fingerprint);
    const pushToken = clean(info.pushToken);
    const existing = fingerprint ? await uow.findDeviceByFingerprint(userId, fingerprint) : null;

    let device: Device;
    if (existing) {
      const data: DeviceUpdateData = { lastSeenAt: now };
      if (info.model !== undefined) {
        data.model = clean(info.model);
      }
      if (info.appVersion !== undefined) {
        data.appVersion = clean(info.appVersion);
      }
      if (pushToken) {
        data.pushToken = pushToken;
        data.pushEnabled = true;
      }
      device = await uow.updateDevice(existing.id, data);
    } else {
      device = await uow.createDevice({
        id: uuidv7(),
        userId,
        platform: info.platform,
        model: clean(info.model),
        appVersion: clean(info.appVersion),
        fingerprint,
        pushToken,
        pushEnabled: pushToken !== null,
        lastSeenAt: now,
        createdAt: now,
      });
    }
    if (pushToken) {
      await this.detachFromOtherDevices(uow, pushToken, device);
    }
    if (!existing || (pushToken !== null && existing.pushToken !== pushToken)) {
      await this.publishRegistered(uow, device);
    }
    return { device, created: !existing };
  }

  /** POST /me/devices: push token and app details of the device bound to the access token. */
  async updateCurrentDevice(
    userId: string,
    deviceId: string | undefined,
    input: DeviceUpdateInput,
  ): Promise<DeviceDto> {
    const device = await this.requireOwnDevice(userId, deviceId);
    const now = this.clock.now();
    const data: DeviceUpdateData = { lastSeenAt: now };
    if (input.model !== undefined) {
      data.model = clean(input.model);
    }
    if (input.appVersion !== undefined) {
      data.appVersion = clean(input.appVersion);
    }
    let nextToken = device.pushToken;
    if (input.pushToken !== undefined) {
      nextToken = input.pushToken === null ? null : clean(input.pushToken);
      data.pushToken = nextToken;
      data.pushEnabled = nextToken === null ? false : (input.pushEnabled ?? true);
    } else if (input.pushEnabled !== undefined) {
      data.pushEnabled = input.pushEnabled && device.pushToken !== null;
    }

    const updated = await this.store.run(async (uow) => {
      const row = await uow.updateDevice(device.id, data);
      if (nextToken !== null && nextToken !== device.pushToken) {
        await this.detachFromOtherDevices(uow, nextToken, row);
      }
      if (row.pushToken !== device.pushToken || row.pushEnabled !== device.pushEnabled) {
        await this.publishRegistered(uow, row);
      }
      return row;
    });
    return toDeviceDto(updated, device.id);
  }

  async listDevices(
    userId: string,
    currentDeviceId: string | undefined,
  ): Promise<DevicesResponseDto> {
    const devices = await this.store.listDevices(userId);
    return { devices: devices.map((device) => toDeviceDto(device, currentDeviceId)) };
  }

  /** Signs a device out: its sessions are revoked and it stops receiving push. The row stays (receipts reference it). */
  async removeDevice(userId: string, deviceId: string): Promise<RemoveDeviceResponseDto> {
    const device = await this.requireOwnDevice(userId, deviceId);
    const now = this.clock.now();
    const revokedSessions = await this.store.run(async (uow) => {
      const revoked = await uow.revokeRefreshTokens({ userId, deviceId: device.id }, now);
      await uow.clearPushTokens({ userId, deviceId: device.id });
      return revoked;
    });
    return { deviceId: device.id, revokedSessions };
  }

  private async requireOwnDevice(userId: string, deviceId: string | undefined): Promise<Device> {
    if (!deviceId) {
      throw new DomainError(
        IdentityErrors.PC_DEVICE_NOT_FOUND,
        'The access token is not bound to a device; log in again from the app',
      );
    }
    const device = await this.store.findDeviceById(deviceId);
    if (!device || device.userId !== userId) {
      throw new DomainError(IdentityErrors.PC_DEVICE_NOT_FOUND, 'Device not found');
    }
    return device;
  }

  /**
   * A push token identifies one app installation, and only the installation itself can read it
   * from FCM/APNs, so presenting it proves possession: the token moves to this device and every
   * other row (typically another member who used the same phone earlier) loses it. The move is
   * audited and logged with this device only; the other rows' owners never appear anywhere.
   */
  private async detachFromOtherDevices(
    uow: IdentityUow,
    pushToken: string,
    device: Device,
  ): Promise<void> {
    const detached = await uow.detachPushToken(pushToken, device.id);
    if (detached === 0) {
      return;
    }
    await uow.audit({
      actor: { type: 'user', id: device.userId },
      action: 'device.push_token_moved',
      entityType: 'device',
      entityId: device.id,
      after: { detachedFromOtherDevices: detached },
    });
    this.logger.log(
      `Push token registered on device ${device.id} was detached from ${detached} other device(s)`,
    );
  }

  private async publishRegistered(uow: IdentityUow, device: Device): Promise<void> {
    await uow.publish(
      buildOutboxEvent(IDENTITY_EVENTS.deviceRegistered, OUTBOX_AGGREGATES.device, device.id, {
        userId: device.userId,
        deviceId: device.id,
        platform: device.platform,
        pushEnabled: device.pushEnabled && device.pushToken !== null,
      }),
    );
  }
}
