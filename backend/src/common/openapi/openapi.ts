import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { appVersion } from '../app-info';
import {
  BEARER_SECURITY,
  VALIDATOR_KEY_HEADER,
  VALIDATOR_KEY_SECURITY,
  VALIDATOR_SHIFT_HEADER,
  VALIDATOR_SHIFT_SECURITY,
} from '../auth/auth.constants';
import { ProblemDetailsDto, ValidationIssueDto } from '../errors/problem-details';

export const OPENAPI_TAGS: ReadonlyArray<readonly [string, string]> = [
  ['ops', 'Health and readiness probes'],
  ['auth', 'OTP login, tokens, profile'],
  ['club', 'Loyalty account, points, rules'],
  ['receipts', 'Receipt submission and moderation'],
  ['rewards', 'Reward catalogue and redemptions'],
  ['vouchers', 'Voucher wallet: activation codes, cancellation'],
  ['validator', 'Cashier validator devices (X-Validator-Key + shift token or PIN)'],
  ['promos', 'Promos, coupons, events'],
  ['parking', 'Vehicles, sessions, tariff, info mode'],
  ['payments', 'Payments and provider webhooks'],
  ['notifications', 'In-app notifications and preferences'],
  ['content', 'Tenants and mall info'],
  ['admin', 'Back-office endpoints (admin tokens)'],
];

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('PortCity Loyalty API')
    .setDescription(
      [
        'Backend of the Порт City mall app (Lutsk).',
        'All endpoints live under /api/v1. Errors are returned as application/problem+json',
        'with a stable `code` (PC_<MODULE>_<REASON>) and the request id.',
        'Mutations with financial or points effects require the Idempotency-Key header.',
      ].join(' '),
    )
    .setVersion(appVersion())
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Member or admin access token',
      },
      BEARER_SECURITY,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: VALIDATOR_KEY_HEADER,
        description: 'Validator device key',
      },
      VALIDATOR_KEY_SECURITY,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: VALIDATOR_SHIFT_HEADER,
        description: 'Validator shift token from POST /validator/shift',
      },
      VALIDATOR_SHIFT_SECURITY,
    );
  // The cashier's PIN is not a security scheme: it is accepted only in the body of
  // POST /validator/shift (X-Validator-Pin was retired in the review fixes of 2026-11-01).
  for (const [name, description] of OPENAPI_TAGS) {
    builder.addTag(name, description);
  }
  return SwaggerModule.createDocument(app, builder.build(), {
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey}_${methodKey}`,
    extraModels: [ProblemDetailsDto, ValidationIssueDto],
  });
}

/** Serves Swagger UI at /docs and the raw document at /docs/openapi.json. */
export function setupOpenApi(app: INestApplication, document: OpenAPIObject): void {
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs/openapi.json',
    yamlDocumentUrl: 'docs/openapi.yaml',
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    customSiteTitle: 'PortCity Loyalty API',
  });
}
