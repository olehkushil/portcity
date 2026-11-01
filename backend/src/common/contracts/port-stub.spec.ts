import { DomainError } from '../errors/domain-error';
import { unimplementedPort } from './port-stub';

interface DemoPort {
  ping(value: string): Promise<string>;
  count(): number;
}

describe('unimplementedPort', () => {
  const port = unimplementedPort<DemoPort>('demo', { ping: true, count: true });

  it('exposes every declared method', () => {
    expect(typeof port.ping).toBe('function');
    expect(typeof port.count).toBe('function');
  });

  it('throws a 501 domain error naming the port and the method', () => {
    expect(() => port.count()).toThrow(DomainError);
    try {
      port.count();
    } catch (error) {
      expect(DomainError.is(error)).toBe(true);
      if (DomainError.is(error)) {
        expect(error.code).toBe('PC_COMMON_NOT_IMPLEMENTED');
        expect(error.status).toBe(501);
        expect(error.message).toContain('demo.count()');
        expect(error.details).toEqual({ port: 'demo', method: 'count' });
      }
    }
  });

  it('rejects when awaited through an async caller', async () => {
    const call = async (): Promise<string> => port.ping('x');
    await expect(call()).rejects.toMatchObject({ code: 'PC_COMMON_NOT_IMPLEMENTED' });
  });
});
