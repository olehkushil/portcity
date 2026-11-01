/**
 * Error capture helpers for specs: `expect(captureError(() => fn())).toMatchObject({ code })`
 * keeps assertions typed (no `expect.objectContaining` passed where an Error is expected).
 */

/** Runs `fn` and returns what it threw (fails the test when it does not throw). */
export function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the function to throw');
}

/** Awaits `promise` and returns its rejection reason (fails the test when it resolves). */
export async function captureAsyncError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}
