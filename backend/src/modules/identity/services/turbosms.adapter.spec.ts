import { LogSmsAdapter } from './sms.port';
import { createSmsAdapter } from './sms.factory';
import { TurboSmsAdapter, isTurboSmsSuccess } from './turbosms.adapter';
import { makeAppConfig, makeIdentityConfig } from '../testing/fixtures';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function adapterWith(fetchFn: jest.Mock): TurboSmsAdapter {
  return new TurboSmsAdapter({
    apiUrl: 'https://api.turbosms.ua/message/send.json',
    token: 'secret-token',
    sender: 'PortCity',
    timeoutMs: 1000,
    fetchFn: fetchFn,
  });
}

const message = { phone: '+380501234567', text: 'Порт City: ваш код 123456.' };

describe('isTurboSmsSuccess', () => {
  it.each([
    [0, true],
    [800, true],
    [802, true],
    [103, false],
    [999, false],
    [undefined, false],
    ['0', false],
  ])('%p -> %p', (code, expected) => {
    expect(isTurboSmsSuccess(code)).toBe(expected);
  });
});

describe('TurboSmsAdapter', () => {
  it('posts the message with the bearer token and the recipient without "+"', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        response_code: 0,
        response_status: 'OK',
        response_result: [{ phone: '380501234567', response_code: 0, message_id: 'm-1' }],
      }),
    );
    await adapterWith(fetchFn).send(message);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.turbosms.ua/message/send.json');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer secret-token' });
    expect(JSON.parse(init.body as string)).toEqual({
      recipients: ['380501234567'],
      sms: { sender: 'PortCity', text: message.text },
    });
  });

  it.each([
    [
      'provider error code',
      jsonResponse(200, { response_code: 103, response_status: 'REQUIRED_TOKEN' }),
    ],
    [
      'recipient rejected',
      jsonResponse(200, {
        response_code: 0,
        response_result: [{ response_code: 406, response_status: 'NOT_ALLOWED_RECIPIENT_COUNTRY' }],
      }),
    ],
    ['HTTP error without JSON', new Response('oops', { status: 502 })],
  ])('fails with PC_OTP_DELIVERY_FAILED on %s', async (_label, response) => {
    const fetchFn = jest.fn().mockResolvedValue(response);
    await expect(adapterWith(fetchFn).send(message)).rejects.toMatchObject({
      code: 'PC_OTP_DELIVERY_FAILED',
      details: expect.objectContaining({ provider: 'turbosms' }) as unknown,
    });
  });

  it('fails with PC_OTP_DELIVERY_FAILED when the gateway is unreachable', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(adapterWith(fetchFn).send(message)).rejects.toMatchObject({
      code: 'PC_OTP_DELIVERY_FAILED',
      details: { provider: 'turbosms', reason: 'gateway_unreachable' },
    });
  });
});

describe('createSmsAdapter', () => {
  it('uses the log adapter by default and TurboSMS when configured', () => {
    const app = makeAppConfig();
    expect(createSmsAdapter(makeIdentityConfig(), app)).toBeInstanceOf(LogSmsAdapter);
    expect(
      createSmsAdapter(
        makeIdentityConfig({ SMS_PROVIDER: 'turbosms', TURBOSMS_TOKEN: 'token' }),
        app,
      ),
    ).toBeInstanceOf(TurboSmsAdapter);
  });

  it('log adapter refuses to pretend in production', async () => {
    const adapter = new LogSmsAdapter(
      makeAppConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://x:x@localhost:5432/x',
        JWT_SECRET: 'Zr8v1yQb6m0kq3XwT9pL2sD7fH4jN5cA-jwt',
        OTP_PEPPER: 'n4Kx7Pq2Lw9Rt6Yz1Mb8Vc3Gd5Hf0Jsa-otp',
        VOUCHER_PEPPER: 'Qe5Wr8Ty1Ui4Op7As0Df3Gh6Jk9Lz2Xc-v',
        MEMBER_QR_SECRET: 'Bv6Nm9Qw2Er5Ty8Ui1Op4As7Df0Gh3Jk-qr',
        STORAGE_DRIVER: 's3',
        QUEUE_DRIVER: 'redis',
        PARKING_PROVIDER: 'vendor',
        PAYMENTS_PROVIDER: 'liqpay',
      }),
    );
    await expect(adapter.send(message)).rejects.toMatchObject({ code: 'PC_OTP_DELIVERY_FAILED' });
  });
});
