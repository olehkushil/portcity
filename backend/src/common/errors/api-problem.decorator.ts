import { HttpStatus, applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { PROBLEM_CONTENT_TYPE, ProblemDetailsDto } from './problem-details';

const DESCRIPTIONS: Record<number, string> = {
  400: 'Validation failed or malformed request',
  401: 'Missing or invalid access token',
  403: 'Insufficient permissions',
  404: 'Resource not found',
  409: 'Conflict (duplicate, idempotency mismatch, invalid state transition)',
  422: 'Business rule violation',
  429: 'Rate limit exceeded',
  503: 'Dependency unavailable',
};

/**
 * Documents `application/problem+json` responses for the given statuses.
 * Example: `@ApiProblemResponses(400, 404, 409)`.
 */
export function ApiProblemResponses(...statuses: number[]): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: DESCRIPTIONS[status] ?? (HttpStatus[status] ?? 'Error').replace(/_/g, ' '),
        content: {
          [PROBLEM_CONTENT_TYPE]: {
            schema: { $ref: `#/components/schemas/${ProblemDetailsDto.name}` },
          },
        },
      }),
    ),
  );
}
