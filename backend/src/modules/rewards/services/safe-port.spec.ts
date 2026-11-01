import type { Logger } from '@nestjs/common';
import { tryPort } from './safe-port';

describe('tryPort', () => {
  const logger = { warn: jest.fn() } as unknown as Logger & { warn: jest.Mock };

  it('returns the port result', async () => {
    await expect(tryPort(logger, 'content.getTenant', async () => 'tenant', null)).resolves.toBe(
      'tenant',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['an Error', new Error('boom'), 'Error: boom'],
    ['a string', 'down', 'down'],
  ])('falls back and logs when the port throws %s', async (_name, thrown, logged) => {
    const result = await tryPort(
      logger,
      'parking.getSessionForUser',
      async () => {
        // Ports may reject with non-Error values; the string case covers that branch.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw thrown;
      },
      'fallback',
    );
    expect(result).toBe('fallback');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('parking.getSessionForUser'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(logged));
  });
});
