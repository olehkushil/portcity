import type { IdentityPort } from '../../../common/contracts/identity';
import { MarketingAudience } from './marketing-audience.service';

describe('MarketingAudience', () => {
  it('reads the audience page by page from IDENTITY_PORT', async () => {
    const listMarketingAudience = jest.fn(async (cursor: string | null) =>
      cursor === null
        ? { userIds: ['u1', 'u2'], nextCursor: 'u2' }
        : { userIds: ['u3'], nextCursor: null },
    );
    const audience = new MarketingAudience({ listMarketingAudience } as unknown as IdentityPort);

    expect(await audience.page(null, 2)).toEqual({ userIds: ['u1', 'u2'], nextCursor: 'u2' });
    expect(await audience.page('u2', 2)).toEqual({ userIds: ['u3'], nextCursor: null });
    expect(listMarketingAudience.mock.calls).toEqual([
      [null, 2],
      ['u2', 2],
    ]);
  });
});
