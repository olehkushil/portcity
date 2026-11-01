import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPE_PREFIX = 'urn:portcity:problem:';

export interface ValidationIssue {
  /** Dotted path of the invalid field, e.g. `device.platform`. */
  path: string;
  messages: string[];
}

/** RFC 7807 problem document extended with `code` and `requestId`. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  instance?: string;
  requestId?: string;
  details?: unknown;
  errors?: ValidationIssue[];
}

export class ValidationIssueDto implements ValidationIssue {
  @ApiProperty({ example: 'phone' })
  path: string;

  @ApiProperty({ type: [String], example: ['phone must be a valid Ukrainian number'] })
  messages: string[];
}

export class ProblemDetailsDto implements ProblemDetails {
  @ApiProperty({ example: 'urn:portcity:problem:PC_RECEIPT_DUPLICATE' })
  type: string;

  @ApiProperty({ example: 'Receipt already registered' })
  title: string;

  @ApiProperty({ example: 409 })
  status: number;

  @ApiPropertyOptional({ example: 'Receipt 1234567890/42 was already submitted' })
  detail?: string;

  @ApiProperty({ example: 'PC_RECEIPT_DUPLICATE' })
  code: string;

  @ApiPropertyOptional({ example: '/api/v1/receipts/qr' })
  instance?: string;

  @ApiPropertyOptional({ example: '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11' })
  requestId?: string;

  @ApiPropertyOptional({ description: 'Machine-readable context specific to the error code' })
  details?: unknown;

  @ApiPropertyOptional({ type: [ValidationIssueDto] })
  errors?: ValidationIssueDto[];
}

export function problemTypeFor(code: string): string {
  return `${PROBLEM_TYPE_PREFIX}${code}`;
}
