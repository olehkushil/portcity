import { currentLegalDocuments, withCurrentVersions } from './legal';

const config = {
  LEGAL_PROGRAM_VERSION: '2026-11',
  LEGAL_PROGRAM_URL: 'https://example.ua/rules',
  LEGAL_MARKETING_VERSION: 'm-3',
  LEGAL_MARKETING_URL: 'https://example.ua/marketing',
  LEGAL_PROFILING_VERSION: 'p-2',
  LEGAL_PROFILING_URL: 'https://example.ua/profiling',
};

describe('legal documents', () => {
  it('lists the three consent purposes with versions and URLs from configuration', () => {
    expect(currentLegalDocuments(config)).toEqual([
      expect.objectContaining({
        purpose: 'program',
        version: '2026-11',
        url: 'https://example.ua/rules',
        required: true,
      }),
      expect.objectContaining({ purpose: 'marketing', version: 'm-3', required: false }),
      expect.objectContaining({ purpose: 'profiling', version: 'p-2', required: false }),
    ]);
  });

  it('fills the current version into grants sent without one and keeps the rest', () => {
    expect(
      withCurrentVersions(
        [
          { purpose: 'program', granted: true },
          { purpose: 'marketing', granted: true, version: 'm-1' },
          { purpose: 'profiling', granted: false },
        ],
        config,
      ),
    ).toEqual([
      { purpose: 'program', granted: true, version: '2026-11' },
      { purpose: 'marketing', granted: true, version: 'm-1' },
      { purpose: 'profiling', granted: false },
    ]);
  });
});
