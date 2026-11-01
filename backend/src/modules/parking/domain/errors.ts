import { defineErrorCodes } from '../../../common/errors/error-codes';

/**
 * Parking error codes (contract: PARKING_ERROR_CODES in src/common/contracts/parking.ts).
 * Codes after PC_PARKING_INFO_MODE_DISABLED are later additions (docs/contract-requests/parking.md
 * and the 2026-11-01 review fixes: talon claim, claim and verification limits).
 */
export const ParkingErrors = defineErrorCodes({
  PC_PARKING_UNKNOWN_PLATE: { status: 422, title: 'Parking operator does not know this plate' },
  PC_PARKING_PLATE_INVALID: { status: 400, title: 'Vehicle plate is invalid' },
  PC_PARKING_VEHICLE_NOT_FOUND: { status: 404, title: 'Vehicle not found' },
  PC_PARKING_VEHICLE_EXISTS: { status: 409, title: 'Vehicle with this plate already added' },
  PC_PARKING_VEHICLE_NOT_VERIFIED: { status: 403, title: 'Vehicle is not verified' },
  PC_PARKING_VERIFICATION_FAILED: { status: 422, title: 'Vehicle verification failed' },
  PC_PARKING_SESSION_NOT_FOUND: { status: 404, title: 'Parking session not found' },
  PC_PARKING_NOTHING_DUE: { status: 409, title: 'Nothing to pay for this session' },
  PC_PARKING_INVALID_TRANSITION: {
    status: 409,
    title: 'Parking session state does not allow this',
  },
  PC_PARKING_PROVIDER_UNAVAILABLE: { status: 503, title: 'Parking operator is unavailable' },
  PC_PARKING_TARIFF_NOT_FOUND: { status: 404, title: 'Parking tariff not found' },
  PC_PARKING_INFO_MODE_DISABLED: { status: 403, title: 'Parking info mode is disabled' },
  // Local additions (see docs/contract-requests/parking.md).
  PC_PARKING_VEHICLE_LIMIT: { status: 422, title: 'Vehicle limit reached' },
  PC_PARKING_LOOKUP_LIMIT: { status: 429, title: 'Too many session lookups for unverified plates' },
  PC_PARKING_SESSION_ACTIVE_EXISTS: { status: 409, title: 'A parking session is already running' },
  PC_PARKING_WEBHOOK_SIGNATURE: { status: 401, title: 'Parking webhook signature is invalid' },
  PC_PARKING_WEBHOOK_MALFORMED: { status: 400, title: 'Parking webhook payload is malformed' },
  PC_PARKING_TALON_UNKNOWN: { status: 404, title: 'No active parking session for this talon' },
  PC_PARKING_SESSION_CLAIMED: {
    status: 409,
    title: 'The parking session belongs to another account',
  },
  PC_PARKING_CLAIM_LIMIT: { status: 429, title: 'Too many talon claims' },
  PC_PARKING_VERIFICATION_LIMIT: {
    status: 429,
    title: 'Too many verification attempts for this vehicle',
  },
});

export type ParkingErrorCode = keyof typeof ParkingErrors;
