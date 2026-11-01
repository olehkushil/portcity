import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { APP_CONFIG, type AppConfig } from '../config';

/** An open interactive transaction. */
export type Tx = Prisma.TransactionClient;
/** Either the root client or an open transaction: repository methods should accept this. */
export type DbClient = PrismaClient | Tx;

export interface WithTxOptions {
  /** Max time (ms) to wait for a connection from the pool. Default 5000. */
  maxWait?: number;
  /** Max time (ms) the transaction may run. Default 15000. */
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

type PrismaLogLevel = 'query' | 'warn' | 'error';

/**
 * Used when DATABASE_URL is absent and PRISMA_LAZY_CONNECT=true (tests, openapi generation):
 * the client is constructed but never connects unless a query is issued.
 */
const PLACEHOLDER_DATABASE_URL =
  'postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder?schema=public';

@Injectable()
export class PrismaService
  extends PrismaClient<Prisma.PrismaClientOptions, PrismaLogLevel>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly lazy: boolean;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const log: Prisma.LogDefinition[] = [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ];
    if (config.PRISMA_LOG_QUERIES) {
      log.push({ emit: 'event', level: 'query' });
    }
    super({ datasourceUrl: config.DATABASE_URL ?? PLACEHOLDER_DATABASE_URL, log });
    this.lazy = config.PRISMA_LAZY_CONNECT;

    this.$on('warn', (event) => this.logger.warn(event.message));
    this.$on('error', (event) => this.logger.error(event.message));
    if (config.PRISMA_LOG_QUERIES) {
      this.$on('query', (event) =>
        this.logger.debug(`${event.query} -- params ${event.params} (${event.duration} ms)`),
      );
    }
  }

  async onModuleInit(): Promise<void> {
    if (this.lazy) {
      this.logger.log('PRISMA_LAZY_CONNECT=true: database connection deferred until first query');
      return;
    }
    await this.$connect();
    this.logger.log('Database connection established');
    await this.checkUnicodeCaseMapping();
  }

  /**
   * Case-insensitive search (admin member search, tenant search) relies on PostgreSQL folding
   * Cyrillic case. A database created with the plain `C`/`POSIX` locale does not, and searches
   * for «олег» then miss «Олег». Use a UTF-8 locale (en_US.UTF-8, uk_UA.UTF-8 or the PostgreSQL 17
   * builtin C.UTF-8); see docs/RUNBOOK.md. Logged, not fatal: the rest of the API still works.
   */
  async checkUnicodeCaseMapping(): Promise<boolean> {
    try {
      const rows = await this.$queryRaw<Array<{ ok: boolean }>>`
        SELECT lower(chr(1054)) = chr(1086) AND upper(chr(1111)) = chr(1031) AS ok`;
      const ok = rows[0]?.ok === true;
      if (!ok) {
        this.logger.error(
          'Database locale does not fold Cyrillic case (lower/ILIKE): case-insensitive searches ' +
            'will miss Ukrainian names. Create the database with a UTF-8 locale (see docs/RUNBOOK.md).',
        );
      }
      return ok;
    } catch (error) {
      this.logger.warn(`Could not check the database locale: ${(error as Error).message}`);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Runs `fn` inside an interactive transaction with sane defaults. */
  withTx<T>(fn: (tx: Tx) => Promise<T>, options: WithTxOptions = {}): Promise<T> {
    return this.$transaction((tx) => fn(tx), {
      maxWait: options.maxWait ?? 5_000,
      timeout: options.timeout ?? 15_000,
      isolationLevel: options.isolationLevel,
    });
  }

  /** Reuses `tx` when the caller is already inside a transaction, otherwise opens a new one. */
  runInTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>, options?: WithTxOptions): Promise<T> {
    return tx ? fn(tx) : this.withTx(fn, options);
  }

  /** Cheap connectivity probe used by the readiness endpoint. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
