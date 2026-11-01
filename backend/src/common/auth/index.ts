export {
  AUTH_KIND_METADATA,
  BEARER_SECURITY,
  OPTIONAL_AUTH_METADATA,
  PUBLIC_METADATA,
  ROLES_METADATA,
  VALIDATOR_KEY_HEADER,
  VALIDATOR_KEY_SECURITY,
  VALIDATOR_PIN_HEADER,
  VALIDATOR_SHIFT_HEADER,
  VALIDATOR_SHIFT_SECURITY,
} from './auth.constants';
export { AdminAccessGate } from './admin-access';
export type { AdminAccessResolver } from './admin-access';
export { Auth, CurrentUser, OptionalAuth, Public, Roles } from './auth.decorators';
export { AuthModule } from './auth.module';
export { ADMIN_ROLES, PRINCIPAL_TYPES } from './auth.types';
export type {
  AccessTokenClaims,
  AdminRole,
  AuthenticatedRequest,
  AuthenticatedUser,
  IssuedAccessToken,
  PrincipalType,
  SignAccessTokenInput,
} from './auth.types';
export { ConcurrencyLimitExceededError, ConcurrencyLimiter } from './concurrency-limiter';
export {
  DEFAULT_SCRYPT_PARAMS,
  PASSWORD_SCRYPT_PARAMS,
  UNAMBIGUOUS_ALPHABET,
  hashPassword,
  hmacSha256,
  hmacSha256Hex,
  needsRehash,
  parseScryptHash,
  scryptParamsWithLogN,
  randomCode,
  randomDigits,
  randomToken,
  safeEqual,
  sha256Base64Url,
  sha256Hex,
  verifyPassword,
} from './crypto';
export type { ParsedScryptHash, ScryptParams } from './crypto';
export {
  AccessTokenGuard,
  AdminGuard,
  MemberGuard,
  RolesGuard,
  extractBearerToken,
  isOptionalAuthRoute,
  isPublicRoute,
} from './guards';
export { JwtError, decodeJwtUnsafe, signJwtHs256, verifyJwtHs256 } from './jwt';
export type { JwtClaims, JwtFailure, VerifyJwtOptions } from './jwt';
export { TokenService, parseAccessClaims } from './token.service';
