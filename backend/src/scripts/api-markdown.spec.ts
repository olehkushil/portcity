import { type OpenApiDocumentLike, describeAccess, renderApiMarkdown } from './api-markdown';

const document: OpenApiDocumentLike = {
  info: { title: 'PortCity Loyalty API', version: '0.1.0' },
  tags: [
    { name: 'ops', description: 'Health and readiness probes' },
    { name: 'receipts', description: 'Receipt submission and moderation' },
    { name: 'admin', description: 'Back-office endpoints (admin tokens)' },
  ],
  paths: {
    '/health': { get: { tags: ['ops'], summary: 'Liveness probe' } },
    '/api/v1/receipts/qr': {
      post: {
        tags: ['receipts'],
        summary: 'Submit a receipt | by QR',
        'x-auth': 'member',
        'x-roles': [],
        security: [{ bearer: [] }],
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true }],
      },
    },
    '/api/v1/receipts': {
      get: { tags: ['receipts'], summary: 'My receipts', 'x-auth': 'member' },
    },
    '/api/v1/admin/receipts/{id}/approve': {
      post: {
        tags: ['admin'],
        summary: 'Approve',
        'x-auth': 'admin',
        'x-roles': ['moderator', 'manager'],
      },
    },
    '/api/v1/admin/adjustments': {
      get: { tags: ['admin'], summary: 'List adjustments', 'x-auth': 'admin', 'x-roles': [] },
    },
    '/api/v1/webhooks/payments/{provider}': {
      post: { tags: ['payments'], summary: 'Payment provider webhook' },
    },
    '/api/v1/validator/redeem': {
      post: {
        tags: ['validator'],
        summary: 'Redeem',
        security: [{ 'validator-key': [], 'validator-shift': [] }],
      },
    },
  },
};

describe('renderApiMarkdown', () => {
  const markdown = renderApiMarkdown(document, { source: 'docs/openapi.json' });

  it('counts endpoints and lists declared tags first, then the rest', () => {
    expect(markdown).toContain('Ендпоїнтів: 7.');
    expect(markdown).toContain(
      '| POST | `/api/v1/webhooks/payments/{provider}` | Payment provider webhook | підпис провайдера |  |',
    );
    const order = ['## Службові', '## Чеки (receipts)', '## Бек-офіс', '## Валідатор'].map(
      (heading) => markdown.indexOf(heading),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('renders access, idempotency and escapes pipes', () => {
    expect(markdown).toContain(
      '| POST | `/api/v1/receipts/qr` | Submit a receipt \\| by QR | учасник | так |',
    );
    expect(markdown).toContain('| GET | `/api/v1/receipts` | My receipts | учасник |  |');
    expect(markdown).toContain('| GET | `/health` | Liveness probe | публічний |  |');
  });

  it('groups back-office endpoints by /admin segment with roles', () => {
    expect(markdown).toContain('### /admin/adjustments');
    expect(markdown).toContain('### /admin/receipts');
    expect(markdown).toContain('admin: moderator, manager');
    expect(markdown).toContain('admin: будь-яка роль');
  });
});

describe('describeAccess', () => {
  it.each([
    [{ 'x-auth': 'public' }, 'публічний'],
    [{ 'x-auth': 'member' }, 'учасник'],
    [{ 'x-auth': 'admin', 'x-roles': ['manager'] }, 'admin: manager'],
    [{ security: [{ 'validator-key': [] }] }, 'валідатор: ключ пристрою'],
    [
      { security: [{ 'validator-key': [], 'validator-shift': [] }] },
      'валідатор: ключ + токен зміни',
    ],
    [{ security: [{ bearer: [] }] }, 'токен'],
    [{}, 'публічний'],
  ])('%j -> %s', (operation, expected) => {
    expect(describeAccess(operation)).toBe(expected);
  });
});
