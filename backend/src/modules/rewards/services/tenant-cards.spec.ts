import { Logger } from '@nestjs/common';
import {
  FAKE_CONTENT_LOGO_BASE,
  FakeContent,
  tenantSummary,
} from '../../../../test/rewards/support/fakes';
import type { ContentPort } from '../../../common/contracts/content';
import { loadTenantCards } from './tenant-cards';

describe('loadTenantCards', () => {
  const logger = new Logger('test');
  let content: FakeContent;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    content = new FakeContent();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('asks nothing for vouchers without a tenant', async () => {
    const batch = jest.spyOn(content, 'getTenants');
    const display = jest.spyOn(content, 'getTenantSummaryById');
    expect((await loadTenantCards(content, logger, [null, null])).size).toBe(0);
    expect(batch).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
  });

  it('prefers the display summary (content resolves logoUrl), once per tenant', async () => {
    const tenant = content.add(tenantSummary({ logoKey: 'aroma.png' }));
    const display = jest.spyOn(content, 'getTenantSummaryById');
    const cards = await loadTenantCards(content, logger, [tenant.id, tenant.id, null]);
    expect(display).toHaveBeenCalledTimes(1);
    expect(cards.get(tenant.id)).toMatchObject({ logoUrl: `${FAKE_CONTENT_LOGO_BASE}/aroma.png` });
  });

  it('falls back to the batch summaries when the display lookup fails', async () => {
    const tenant = content.add(tenantSummary());
    content.failDisplay = true;
    const cards = await loadTenantCards(content, logger, [tenant.id]);
    expect(cards.get(tenant.id)).toEqual(tenant);
  });

  it('falls back to the batch summaries when the port has no display lookup', async () => {
    const tenant = content.add(tenantSummary());
    const legacy = {
      getTenants: (ids: readonly string[]) => content.getTenants(ids),
    } as unknown as ContentPort;
    const cards = await loadTenantCards(legacy, logger, [tenant.id]);
    expect(cards.get(tenant.id)).toEqual(tenant);
  });

  it('returns no card when content is down', async () => {
    const tenant = content.add(tenantSummary());
    content.fail = true;
    expect((await loadTenantCards(content, logger, [tenant.id])).size).toBe(0);
  });
});
