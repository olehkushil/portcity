/**
 * Back-office roles of the content endpoints (`owner` passes every check, see RolesGuard).
 *   read:          tenants, fiscal numbers, rules, import runs
 *   write:         tenants, tenant rules, content import
 *   fiscal write:  create, map, confirm, block and delete fiscal numbers (moderators map the
 *                  numbers discovered from receipts while moderating them)
 */
export const CONTENT_READ_ROLES: readonly string[] = ['manager', 'moderator', 'support'];
export const CONTENT_WRITE_ROLES: readonly string[] = ['manager'];
export const FISCAL_NUMBER_WRITE_ROLES: readonly string[] = ['manager', 'moderator'];
