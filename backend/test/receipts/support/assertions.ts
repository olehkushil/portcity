import { DomainError } from '../../../src/common/errors/domain-error';

/** Awaits `promise`, asserts it rejects with a DomainError of `code`, and returns the error. */
export async function expectDomainError(
  promise: Promise<unknown>,
  code: string,
  status?: number,
): Promise<DomainError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`expected DomainError ${code}, but the promise resolved`);
  }
  if (!DomainError.is(caught)) {
    throw caught instanceof Error
      ? caught
      : new Error(`non-error rejection: ${JSON.stringify(caught)}`);
  }
  expect(caught.code).toBe(code);
  if (status !== undefined) {
    expect(caught.status).toBe(status);
  }
  return caught;
}
