import { DomainError } from '../errors/domain-error';
import { CommonErrors } from '../errors/error-codes';

/**
 * Placeholder implementation of a port for a module that is still a stub.
 * Every listed method throws `PC_COMMON_NOT_IMPLEMENTED` (501) when called, so the whole
 * AppModule boots and e2e tests can `overrideProvider(TOKEN).useValue(fake)` while the owning
 * module is being built. The `methods` object must list every method of `T` (type-checked).
 *
 *   providers: [{ provide: CLUB_LEDGER_PORT, useValue: unimplementedPort<ClubLedgerPort>('club', { credit: true, ... }) }]
 */
export function unimplementedPort<T extends object>(
  portName: string,
  methods: { readonly [K in keyof T]-?: true },
): T {
  const stub: Record<string, unknown> = {};
  for (const method of Object.keys(methods)) {
    stub[method] = (): never => {
      throw new DomainError(
        CommonErrors.PC_COMMON_NOT_IMPLEMENTED,
        `${portName}.${method}() is not implemented: the ${portName} module is still a stub`,
        { details: { port: portName, method } },
      );
    };
  }
  return stub as T;
}
