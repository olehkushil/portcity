export const AUTH_KIND_METADATA = 'portcity:auth:kind';
export const ROLES_METADATA = 'portcity:auth:roles';
export const PUBLIC_METADATA = 'portcity:auth:public';
/** Handler accepts anonymous calls but attaches the member when a valid token is sent. */
export const OPTIONAL_AUTH_METADATA = 'portcity:auth:optional';

/** OpenAPI vendor extensions on every operation: `member | admin | public` and the admin roles. */
export const AUTH_KIND_EXTENSION = 'x-auth';
export const ROLES_EXTENSION = 'x-roles';

/** Swagger security scheme names registered in buildOpenApiDocument(). */
export const BEARER_SECURITY = 'bearer';
export const VALIDATOR_KEY_SECURITY = 'validator-key';
export const VALIDATOR_KEY_HEADER = 'X-Validator-Key';
/** Shift token returned by POST /validator/shift, required on every other validator route. */
export const VALIDATOR_SHIFT_SECURITY = 'validator-shift';
export const VALIDATOR_SHIFT_HEADER = 'X-Validator-Shift';
/**
 * Retired header: the cashier's PIN is accepted only in the body of POST /validator/shift. Not an
 * OpenAPI security scheme and not a CORS allowed header any more; the validator guard only
 * recognises it to explain the 401, and the request logger still redacts it.
 */
export const VALIDATOR_PIN_HEADER = 'X-Validator-Pin';
