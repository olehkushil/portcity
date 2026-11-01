import { Injectable } from '@nestjs/common';
import type { MallInfo, Prisma } from '@prisma/client';
import { type DbClient, PrismaService, type Tx } from '../../../common/prisma/prisma.service';
import {
  MALL_INFO_ID,
  type StoredMallInfo,
  readFloorMaps,
  readLegalDocuments,
} from '../domain/mall-info';

export interface StoredMallInfoRow extends StoredMallInfo {
  updatedById: string | null;
  updatedAt: Date;
}

function toStored(row: MallInfo): StoredMallInfoRow {
  return {
    address: row.address,
    hours: row.hours,
    telegramUrl: row.telegramUrl,
    infoDeskLocation: row.infoDeskLocation,
    infoDeskHours: row.infoDeskHours,
    parkingOperatorName: row.parkingOperatorName,
    parkingOperatorPhone: row.parkingOperatorPhone,
    parkingOperatorHours: row.parkingOperatorHours,
    rulesPdfUrl: row.rulesPdfUrl,
    legalDocuments: readLegalDocuments(row.legalDocuments),
    floorMapUrls: readFloorMaps(row.floorMapUrls),
    parkingMapUrl: row.parkingMapUrl,
    supportPhone: row.supportPhone,
    supportEmail: row.supportEmail,
    updatedById: row.updatedById,
    updatedAt: row.updatedAt,
  };
}

/** Prisma access to the singleton mall_info table (id = 1). */
@Injectable()
export class MallInfoRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(db: DbClient = this.prisma): Promise<StoredMallInfoRow | null> {
    const row = await db.mallInfo.findUnique({ where: { id: MALL_INFO_ID } });
    return row ? toStored(row) : null;
  }

  async save(
    tx: Tx,
    data: StoredMallInfo,
    updatedById: string,
    now: Date,
  ): Promise<StoredMallInfoRow> {
    const columns = {
      ...data,
      legalDocuments: data.legalDocuments.map((doc) => ({ ...doc })) as Prisma.InputJsonArray,
      floorMapUrls: data.floorMapUrls.map((map) => ({ ...map })) as Prisma.InputJsonArray,
      updatedById,
      updatedAt: now,
    };
    const row = await tx.mallInfo.upsert({
      where: { id: MALL_INFO_ID },
      create: { id: MALL_INFO_ID, ...columns },
      update: columns,
    });
    return toStored(row);
  }

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.withTx(fn);
  }
}
