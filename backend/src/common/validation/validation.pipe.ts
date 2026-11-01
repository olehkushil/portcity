import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { DomainError } from '../errors/domain-error';
import { CommonErrors } from '../errors/error-codes';
import type { ValidationIssue } from '../errors/problem-details';

/** Flattens nested class-validator errors into `{ path, messages }` items. */
export function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const error of errors) {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    if (error.constraints) {
      issues.push({ path, messages: Object.values(error.constraints) });
    }
    if (error.children && error.children.length > 0) {
      issues.push(...flattenValidationErrors(error.children, path));
    }
  }
  return issues;
}

/** Global pipe per brief section 1; failures become PC_COMMON_VALIDATION problem documents. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    stopAtFirstError: false,
    validateCustomDecorators: true,
    exceptionFactory: (errors: ValidationError[]) =>
      new DomainError(CommonErrors.PC_COMMON_VALIDATION, 'Request validation failed', {
        details: flattenValidationErrors(errors),
      }),
  });
}
