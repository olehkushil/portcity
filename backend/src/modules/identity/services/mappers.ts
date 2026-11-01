import type {
  AccountDeletionRequest,
  AdminUser,
  Child,
  Consent,
  Device,
  RefreshToken,
  User,
} from '@prisma/client';
import type { DeviceSummary, UserSummary } from '../../../common/contracts/identity';
import { maskPhone } from '../../../common/phone/phone';
import { type ConsentState, currentConsents } from '../domain/consents';
import { deletionRequestState, isAnonymisedPhone } from '../domain/deletion';
import { formatMemberCode } from '../domain/member-code';
import { formatBirthDate, isProfileComplete } from '../domain/profile';
import { isActiveSession } from '../domain/refresh-rotation';
import type {
  AdminUserDto,
  ConsentStateDto,
  DeletionRequestDto,
  DeviceDto,
  SessionDto,
  UserDto,
} from '../dto/common.dto';
import type { ChildDto } from '../dto/me.dto';

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

// -- contract summaries (IdentityPort) -----------------------------------------------------

export function toUserSummary(user: User): UserSummary {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    birthDate: formatBirthDate(user.birthDate),
    status: user.status,
    memberCode: user.memberCode,
    profileCompletedAt: user.profileCompletedAt,
    createdAt: user.createdAt,
    deletedAt: user.deletedAt,
  };
}

export function toDeviceSummary(device: Device): DeviceSummary {
  return {
    id: device.id,
    userId: device.userId,
    platform: device.platform,
    model: device.model,
    appVersion: device.appVersion,
    fingerprint: device.fingerprint,
    pushToken: device.pushToken,
    pushEnabled: device.pushEnabled,
    lastSeenAt: device.lastSeenAt,
  };
}

// -- HTTP DTOs -----------------------------------------------------------------------------

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    birthDate: formatBirthDate(user.birthDate),
    gender: user.gender,
    city: user.city,
    status: user.status,
    memberCode: user.memberCode,
    memberCodeFormatted: formatMemberCode(user.memberCode),
    profileCompleted: isProfileComplete(user),
    profileCompletedAt: iso(user.profileCompletedAt),
    createdAt: user.createdAt.toISOString(),
    deletedAt: iso(user.deletedAt),
  };
}

/** Phone as shown in the back office: `+380 50 *** ** 67`; anonymised placeholders stay as they are. */
export function maskMemberPhone(phone: string): string {
  return isAnonymisedPhone(phone) ? phone : maskPhone(phone);
}

/** Back-office view of a member (GET /admin/users, /admin/users/:id): the phone is masked. */
export function toAdminMemberDto(user: User): UserDto {
  return { ...toUserDto(user), phone: maskMemberPhone(user.phone) };
}

export function toChildDto(child: Child): ChildDto {
  return {
    id: child.id,
    birthMonth: child.birthMonth,
    birthYear: child.birthYear,
    gender: child.gender,
    createdAt: child.createdAt.toISOString(),
  };
}

export function toDeviceDto(device: Device, currentDeviceId?: string): DeviceDto {
  return {
    id: device.id,
    platform: device.platform,
    model: device.model,
    appVersion: device.appVersion,
    pushEnabled: device.pushEnabled,
    hasPushToken: device.pushToken !== null,
    lastSeenAt: iso(device.lastSeenAt),
    createdAt: device.createdAt.toISOString(),
    current: currentDeviceId !== undefined && device.id === currentDeviceId,
  };
}

export function toConsentStateDto(state: ConsentState): ConsentStateDto {
  return {
    purpose: state.purpose,
    granted: state.granted,
    version: state.version,
    grantedAt: iso(state.grantedAt),
    revokedAt: iso(state.revokedAt),
  };
}

export function toConsentDtos(rows: readonly Consent[]): ConsentStateDto[] {
  return currentConsents(rows).map(toConsentStateDto);
}

export function toDeletionRequestDto(request: AccountDeletionRequest): DeletionRequestDto {
  return {
    id: request.id,
    status: deletionRequestState(request),
    requestedAt: request.requestedAt.toISOString(),
    executeAfter: request.executeAfter.toISOString(),
    executedAt: iso(request.executedAt),
    cancelledAt: iso(request.cancelledAt),
    reason: request.reason,
  };
}

export function toSessionDto(token: RefreshToken, now: Date): SessionDto {
  return {
    id: token.id,
    deviceId: token.deviceId,
    createdAt: token.createdAt.toISOString(),
    expiresAt: token.expiresAt.toISOString(),
    revokedAt: iso(token.revokedAt),
    active: isActiveSession(token, now),
  };
}

export function toAdminUserDto(admin: AdminUser): AdminUserDto {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    active: admin.active,
    totpEnabled: admin.totpSecret !== null,
    lastLoginAt: iso(admin.lastLoginAt),
    createdAt: admin.createdAt.toISOString(),
  };
}
