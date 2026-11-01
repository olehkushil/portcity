import { validateEnv } from '../config/env.schema';
import { DomainError } from '../errors/domain-error';
import { FakeClock } from '../time/clock';
import { signJwtHs256 } from './jwt';
import { TokenService } from './token.service';

describe('TokenService', () => {
  const config = validateEnv({
    NODE_ENV: 'test',
    JWT_SECRET: 'unit-test-secret-0123456789abcdef',
    JWT_ACCESS_TTL_SECONDS: '900',
    REFRESH_TOKEN_TTL_DAYS: '60',
  });
  let clock: FakeClock;
  let service: TokenService;

  beforeEach(() => {
    clock = new FakeClock('2026-01-15T10:00:00Z');
    service = new TokenService(config, clock);
  });

  it('issues a member token with the expected claims', () => {
    const issued = service.signAccessToken({ sub: 'user-1', type: 'member', deviceId: 'dev-1' });
    expect(issued.expiresAt.toISOString()).toBe('2026-01-15T10:15:00.000Z');

    const claims = service.verifyAccessToken(issued.token);
    expect(claims).toMatchObject({
      sub: 'user-1',
      typ: 'member',
      roles: [],
      did: 'dev-1',
      iss: 'portcity',
      jti: issued.jti,
    });
    const user = service.toAuthenticatedUser(claims);
    expect(user).toMatchObject({
      id: 'user-1',
      type: 'member',
      deviceId: 'dev-1',
      tokenId: issued.jti,
    });
  });

  it('issues admin tokens with roles and custom ttl', () => {
    const issued = service.signAccessToken({
      sub: 'admin-1',
      type: 'admin',
      roles: ['manager'],
      ttlSeconds: 60,
    });
    expect(issued.expiresAt.toISOString()).toBe('2026-01-15T10:01:00.000Z');
    expect(service.verifyAccessToken(issued.token).roles).toEqual(['manager']);
  });

  it('reports expiry with PC_AUTH_TOKEN_EXPIRED', () => {
    const issued = service.signAccessToken({ sub: 'user-1', type: 'member' });
    clock.advanceMinutes(16);
    try {
      service.verifyAccessToken(issued.token);
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('PC_AUTH_TOKEN_EXPIRED');
      expect((error as DomainError).status).toBe(401);
    }
  });

  it('rejects foreign, tampered and malformed tokens with PC_AUTH_TOKEN_INVALID', () => {
    const foreign = signJwtHs256(
      { sub: 'user-1', typ: 'member', jti: 'x', iat: 1, exp: 4_102_444_800, iss: 'portcity' },
      'another-secret',
    );
    const wrongIssuer = signJwtHs256(
      { sub: 'user-1', typ: 'member', jti: 'x', iat: 1, exp: 4_102_444_800, iss: 'evil' },
      config.JWT_SECRET,
    );
    const badShape = signJwtHs256(
      { sub: 'user-1', typ: 'robot', jti: 'x', iat: 1, exp: 4_102_444_800, iss: 'portcity' },
      config.JWT_SECRET,
    );
    for (const token of [foreign, wrongIssuer, badShape, 'garbage']) {
      try {
        service.verifyAccessToken(token);
        throw new Error('expected failure');
      } catch (error) {
        expect((error as DomainError).code).toBe('PC_AUTH_TOKEN_INVALID');
      }
    }
  });

  it('generates and hashes refresh tokens', () => {
    const { raw, hash } = service.generateRefreshToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(service.hashRefreshToken(raw)).toBe(hash);
    expect(service.refreshTokenExpiresAt().toISOString()).toBe('2026-03-16T10:00:00.000Z');
  });
});
