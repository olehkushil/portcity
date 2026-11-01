export {
  isDatabaseUnavailable,
  isForeignKeyViolation,
  isPrismaKnownError,
  isRecordNotFound,
  isUniqueViolation,
} from './prisma.errors';
export { PrismaModule } from './prisma.module';
export { PrismaService } from './prisma.service';
export type { DbClient, Tx, WithTxOptions } from './prisma.service';
