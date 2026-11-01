import type { Reward } from '@prisma/client';
import type { TenantSummary } from '../../../common/contracts/content';
import {
  type RewardUnavailableReason,
  checkRewardAvailability,
  isAffordable,
  remainingForUser,
} from '../domain/reward-rules';
import type { RewardDto, RewardTenantDto } from '../dto/reward.dto';
import { publicMediaUrl, toTenantView } from './media-url';

export interface RewardViewContext {
  now: Date;
  tenant: TenantSummary | null;
  /** S3_PUBLIC_BASE_URL; image and logo URLs are null without it. */
  publicBaseUrl?: string | null | undefined;
  /** Member context; omitted for back-office views and for guests (per-user fields are null). */
  member?: { userRedemptions: number; availableBalance: number | null } | undefined;
}

export function toRewardTenantDto(
  tenant: TenantSummary,
  publicBaseUrl?: string | null,
): RewardTenantDto {
  return {
    ...toTenantView(tenant, publicBaseUrl),
    logoKey: tenant.logoKey,
  };
}

export function toRewardDto(reward: Reward, context: RewardViewContext): RewardDto {
  const userRedemptions = context.member?.userRedemptions ?? 0;
  const availability = checkRewardAvailability(reward, context.now, userRedemptions);
  const unavailableReason: RewardUnavailableReason | null = availability.ok
    ? null
    : availability.reason;
  return {
    id: reward.id,
    title: reward.title,
    description: reward.description,
    costPoints: reward.costPoints,
    kind: reward.kind,
    tenantId: reward.tenantId,
    tenant: context.tenant ? toRewardTenantDto(context.tenant, context.publicBaseUrl) : null,
    stock: reward.stock,
    perUserLimit: reward.perUserLimit,
    remainingForUser: context.member
      ? remainingForUser(reward.perUserLimit, userRedemptions)
      : null,
    active: reward.active,
    validFrom: reward.validFrom,
    validTo: reward.validTo,
    imageKey: reward.imageKey,
    imageUrl: publicMediaUrl(context.publicBaseUrl, reward.imageKey),
    terms: reward.terms,
    sortOrder: reward.sortOrder,
    available: availability.ok,
    unavailableReason,
    affordable: context.member
      ? isAffordable(reward.costPoints, context.member.availableBalance)
      : null,
    createdAt: reward.createdAt,
    updatedAt: reward.updatedAt,
  };
}
