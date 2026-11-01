import type { ConsentPurpose } from '../../../common/contracts/identity';
import type { ConsentChange } from './consents';

/** One consent text the app shows and the member accepts (GET /legal/documents). */
export interface LegalDocument {
  purpose: ConsentPurpose;
  title: string;
  version: string;
  url: string;
  /** `program` is required to join; marketing and profiling are optional. */
  required: boolean;
}

export interface LegalConfig {
  LEGAL_PROGRAM_VERSION: string;
  LEGAL_PROGRAM_URL: string;
  LEGAL_MARKETING_VERSION: string;
  LEGAL_MARKETING_URL: string;
  LEGAL_PROFILING_VERSION: string;
  LEGAL_PROFILING_URL: string;
}

/** Current consent documents from configuration, in CONSENT_PURPOSES order. */
export function currentLegalDocuments(config: LegalConfig): LegalDocument[] {
  return [
    {
      purpose: 'program',
      title: 'Правила програми лояльності та згода на участь',
      version: config.LEGAL_PROGRAM_VERSION,
      url: config.LEGAL_PROGRAM_URL,
      required: true,
    },
    {
      purpose: 'marketing',
      title: 'Згода на маркетингові повідомлення',
      version: config.LEGAL_MARKETING_VERSION,
      url: config.LEGAL_MARKETING_URL,
      required: false,
    },
    {
      purpose: 'profiling',
      title: 'Згода на персоналізацію пропозицій',
      version: config.LEGAL_PROFILING_VERSION,
      url: config.LEGAL_PROFILING_URL,
      required: false,
    },
  ];
}

/**
 * Grants sent without a version (`{ purpose, granted: true }`) accept the current text from
 * configuration, so the app does not have to hard-code versions; explicit versions are kept as
 * sent (the member may have read an older cached text).
 */
export function withCurrentVersions(
  changes: readonly ConsentChange[],
  config: LegalConfig,
): ConsentChange[] {
  const current = new Map(
    currentLegalDocuments(config).map((document) => [document.purpose, document.version]),
  );
  return changes.map((change) =>
    change.granted && (change.version === undefined || change.version.trim() === '')
      ? { ...change, version: current.get(change.purpose) ?? '' }
      : change,
  );
}
