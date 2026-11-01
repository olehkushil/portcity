import { tryNormalizeUaPhone } from '../../../common/phone/phone';
import { isWellFormedMemberCode } from './member-code';

/**
 * Interpretation of the back-office search box (`GET /admin/users?q=`):
 * - contains `@` -> e-mail (case-insensitive substring);
 * - digits (with optional +, spaces, dashes, brackets) -> a full Ukrainian phone becomes an
 *   exact E.164 match, otherwise a digit fragment matched against phone and member code;
 *   nine digits are also tried as an exact member code;
 * - anything else -> first/last name substring (case-insensitive).
 */
export interface UserSearchTerms {
  email?: string;
  phoneExact?: string;
  digitFragment?: string;
  memberCode?: string;
  name?: string;
}

export const MAX_SEARCH_QUERY_LENGTH = 100;

export function parseUserSearchQuery(raw: string | undefined | null): UserSearchTerms | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const query = raw.trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
  if (query === '') {
    return null;
  }
  if (query.includes('@')) {
    return { email: query.toLowerCase() };
  }
  const compact = query.replace(/[\s\-().]/g, '');
  if (/^\+?\d+$/.test(compact)) {
    const terms: UserSearchTerms = {};
    const normalized = tryNormalizeUaPhone(compact);
    const digits = compact.replace(/\D/g, '');
    if (normalized) {
      terms.phoneExact = normalized;
    }
    if (isWellFormedMemberCode(digits)) {
      terms.memberCode = digits;
    }
    if (!normalized) {
      terms.digitFragment = digits;
    }
    return terms;
  }
  return { name: query };
}
