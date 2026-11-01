import { createVerify, generateKeyPairSync } from 'node:crypto';
import { FakeClock } from '../../../../common/time/clock';
import { notificationsEnvSchema } from '../notifications.config';
import {
  ServiceAccountTokenProvider,
  StaticAccessTokenProvider,
  parseServiceAccount,
  signJwtRs256,
} from './fcm-access-token';
import {
  FcmPushAdapter,
  buildFcmRequestBody,
  extractFcmErrorCode,
  mapFcmFailure,
} from './fcm-push.adapter';
import { createPushAdapter } from './push.factory';
import type { PushMessage } from './push.port';
import { StubPushAdapter, maskToken } from './stub-push.adapter';

const MESSAGE: PushMessage = {
  token: 'device-token-123456',
  title: 'До сплати 60 грн',
  body: 'Оплатіть паркінг',
  data: { notificationId: 'n1', kind: 'parking_payable' },
  collapseKey: 'parking_payable',
};

interface FetchCall {
  url: string;
  init: RequestInit;
  /** Request body when it was a string (both adapters send strings). */
  body: string;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function fakeFetch(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url: urlOf(url), init: init ?? {}, body });
    const next = queue.shift() ?? { status: 200, body: {} };
    if (next instanceof Error) {
      throw next;
    }
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl: impl, calls };
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('FcmPushAdapter', () => {
  it('posts an FCM HTTP v1 message with the bearer token and returns the message name', async () => {
    const fetch = fakeFetch([{ status: 200, body: { name: 'projects/portcity/messages/1' } }]);
    const adapter = new FcmPushAdapter({
      projectId: 'portcity',
      tokens: new StaticAccessTokenProvider('ya29.token'),
      endpoint: 'https://fcm.test/',
      fetchImpl: fetch.impl,
    });

    const result = await adapter.send(MESSAGE);

    expect(result).toEqual({ ok: true, providerMessageId: 'projects/portcity/messages/1' });
    expect(fetch.calls[0]?.url).toBe('https://fcm.test/v1/projects/portcity/messages:send');
    expect(fetch.calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer ya29.token' });
    expect(JSON.parse(fetch.calls[0]?.body ?? '')).toEqual(buildFcmRequestBody(MESSAGE));
  });

  it('reports not_configured instead of calling FCM without credentials', async () => {
    const fetch = fakeFetch([]);
    const adapter = new FcmPushAdapter({
      projectId: null,
      tokens: new StaticAccessTokenProvider(null),
      fetchImpl: fetch.impl,
    });
    expect(adapter.configured).toBe(false);
    await expect(adapter.send(MESSAGE)).resolves.toMatchObject({
      ok: false,
      code: 'not_configured',
    });
    expect(fetch.calls).toHaveLength(0);
  });

  it('maps FCM errors and network failures', async () => {
    const fetch = fakeFetch([
      {
        status: 404,
        body: {
          error: { status: 'NOT_FOUND', details: [{ '@type': 'x', errorCode: 'UNREGISTERED' }] },
        },
      },
      new Error('socket hang up'),
    ]);
    const tokens = new StaticAccessTokenProvider('t');
    const invalidate = jest.spyOn(tokens, 'invalidate');
    const adapter = new FcmPushAdapter({ projectId: 'p', tokens, fetchImpl: fetch.impl });

    await expect(adapter.send(MESSAGE)).resolves.toEqual({
      ok: false,
      code: 'unregistered',
      retryable: false,
      message: '404 UNREGISTERED',
    });
    await expect(adapter.send(MESSAGE)).resolves.toMatchObject({
      ok: false,
      code: 'provider_error',
      retryable: true,
      message: 'socket hang up',
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'INVALID_ARGUMENT', 'invalid_token', false],
    [429, 'QUOTA_EXCEEDED', 'rate_limited', true],
    [401, null, 'provider_error', true],
    [403, 'THIRD_PARTY_AUTH_ERROR', 'provider_error', false],
    [503, 'UNAVAILABLE', 'provider_error', true],
    [418, null, 'provider_error', false],
  ])('maps HTTP %s / %s to %s (retryable %s)', (status, code, expected, retryable) => {
    expect(mapFcmFailure(status, code)).toMatchObject({ ok: false, code: expected, retryable });
  });

  it('extracts the FCM error code from detail or status', () => {
    expect(extractFcmErrorCode({ error: { status: 'INTERNAL' } })).toBe('INTERNAL');
    expect(extractFcmErrorCode({ error: { details: [{ errorCode: 'UNREGISTERED' }] } })).toBe(
      'UNREGISTERED',
    );
    expect(extractFcmErrorCode('nope')).toBeNull();
  });
});

describe('ServiceAccountTokenProvider', () => {
  it('signs an RS256 assertion, caches the token and refreshes it after invalidate()', async () => {
    const clock = new FakeClock('2026-11-01T10:00:00.000Z');
    const fetch = fakeFetch([
      { status: 200, body: { access_token: 'tok-1', expires_in: 3600 } },
      { status: 200, body: { access_token: 'tok-2', expires_in: 3600 } },
    ]);
    const provider = new ServiceAccountTokenProvider(
      { client_email: 'push@portcity.iam.gserviceaccount.com', private_key: privateKey },
      { fetchImpl: fetch.impl, now: () => clock.now() },
    );

    await expect(provider.getAccessToken()).resolves.toBe('tok-1');
    await expect(provider.getAccessToken()).resolves.toBe('tok-1');
    expect(fetch.calls).toHaveLength(1);

    const form = new URLSearchParams(fetch.calls[0]?.body ?? '');
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, payload, signature] = (form.get('assertion') ?? '').split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature ?? '', 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'))).toMatchObject({
      iss: 'push@portcity.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
    });

    provider.invalidate();
    await expect(provider.getAccessToken()).resolves.toBe('tok-2');
  });

  it('refreshes shortly before expiry and fails on a bad token response', async () => {
    const clock = new FakeClock('2026-11-01T10:00:00.000Z');
    const fetch = fakeFetch([
      { status: 200, body: { access_token: 'tok-1', expires_in: 120 } },
      { status: 500, body: {} },
    ]);
    const provider = new ServiceAccountTokenProvider(
      { client_email: 'a@b', private_key: privateKey },
      { fetchImpl: fetch.impl, now: () => clock.now() },
    );
    await provider.getAccessToken();
    clock.advanceSeconds(61);
    await expect(provider.getAccessToken()).rejects.toThrow('Google token endpoint answered 500');
  });

  it('parses raw, base64 and one-line service account JSON', () => {
    const raw = JSON.stringify({
      client_email: 'a@b',
      private_key: 'line1\\nline2',
      project_id: 'p',
    });
    expect(parseServiceAccount(raw)).toMatchObject({
      private_key: 'line1\nline2',
      project_id: 'p',
    });
    expect(parseServiceAccount(Buffer.from(raw).toString('base64')).client_email).toBe('a@b');
    expect(() => parseServiceAccount('{"client_email":1}')).toThrow('needs client_email');
    expect(() => parseServiceAccount('%%%')).toThrow();
  });

  it('produces verifiable RS256 JWTs', () => {
    const jwt = signJwtRs256({ sub: 'x' }, privateKey);
    expect(jwt.split('.')).toHaveLength(3);
  });
});

describe('push adapter selection', () => {
  it('uses the stub by default and records messages', async () => {
    const adapter = createPushAdapter(notificationsEnvSchema.parse({}), new FakeClock());
    expect(adapter).toBeInstanceOf(StubPushAdapter);
    await expect(adapter.send(MESSAGE)).resolves.toEqual({ ok: true, providerMessageId: 'stub-1' });
    expect((adapter as StubPushAdapter).sent).toHaveLength(1);
  });

  it('builds the FCM adapter from the environment', () => {
    const adapter = createPushAdapter(
      notificationsEnvSchema.parse({
        PUSH_PROVIDER: 'fcm',
        FCM_PROJECT_ID: 'portcity',
        FCM_ACCESS_TOKEN: 'static',
      }),
      new FakeClock(),
    );
    expect(adapter).toBeInstanceOf(FcmPushAdapter);
    expect((adapter as FcmPushAdapter).configured).toBe(true);
  });

  it('masks tokens in logs', () => {
    expect(maskToken('abcdefghijkl')).toBe('abcd...ijkl');
    expect(maskToken('short')).toBe('****');
  });
});
