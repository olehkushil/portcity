import type { AccessTokenProvider } from './fcm-access-token';
import { type PushMessage, PushPort, type PushSendResult } from './push.port';

export interface FcmPushAdapterOptions {
  projectId: string | null;
  tokens: AccessTokenProvider;
  /** Base URL, default https://fcm.googleapis.com (tests point it at a fake). */
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** FCM HTTP v1 error codes: https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode */
export function mapFcmFailure(status: number, fcmErrorCode: string | null): PushSendResult {
  const code = fcmErrorCode ?? '';
  const message = code ? `${status} ${code}` : `HTTP ${status}`;
  if (code === 'UNREGISTERED' || status === 404) {
    return { ok: false, code: 'unregistered', retryable: false, message };
  }
  if (code === 'INVALID_ARGUMENT' || code === 'SENDER_ID_MISMATCH' || status === 400) {
    return { ok: false, code: 'invalid_token', retryable: false, message };
  }
  if (code === 'QUOTA_EXCEEDED' || status === 429) {
    return { ok: false, code: 'rate_limited', retryable: true, message };
  }
  if (status === 401) {
    // Expired access token: refreshed on the next attempt.
    return { ok: false, code: 'provider_error', retryable: true, message };
  }
  if (status === 403 || code === 'THIRD_PARTY_AUTH_ERROR') {
    return { ok: false, code: 'provider_error', retryable: false, message };
  }
  if (status >= 500 || code === 'UNAVAILABLE' || code === 'INTERNAL') {
    return { ok: false, code: 'provider_error', retryable: true, message };
  }
  return { ok: false, code: 'provider_error', retryable: false, message };
}

interface FcmErrorBody {
  error?: {
    status?: unknown;
    message?: unknown;
    details?: Array<{ '@type'?: unknown; errorCode?: unknown }>;
  };
}

/** Pulls the FcmError.errorCode (preferred) or the RPC status out of an error response body. */
export function extractFcmErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const error = (body as FcmErrorBody).error;
  if (!error) {
    return null;
  }
  for (const detail of error.details ?? []) {
    if (typeof detail?.errorCode === 'string') {
      return detail.errorCode;
    }
  }
  return typeof error.status === 'string' ? error.status : null;
}

export function buildFcmRequestBody(message: PushMessage): Record<string, unknown> {
  return {
    message: {
      token: message.token,
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: {
        priority: 'HIGH',
        ...(message.collapseKey ? { collapse_key: message.collapseKey } : {}),
      },
      apns: {
        headers: message.collapseKey ? { 'apns-collapse-id': message.collapseKey } : {},
        payload: { aps: { sound: 'default' } },
      },
    },
  };
}

/**
 * Firebase Cloud Messaging HTTP v1 adapter. Without a project id or token source it reports
 * `not_configured` for every message (deliveries end up `skipped`) instead of throwing, so a
 * misconfigured worker does not loop on retries.
 */
export class FcmPushAdapter extends PushPort {
  readonly provider = 'fcm';
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: FcmPushAdapterOptions) {
    super();
    this.endpoint = (options.endpoint ?? 'https://fcm.googleapis.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  get configured(): boolean {
    return Boolean(this.options.projectId) && this.options.tokens.configured;
  }

  async send(message: PushMessage): Promise<PushSendResult> {
    if (!this.configured || !this.options.projectId) {
      return {
        ok: false,
        code: 'not_configured',
        retryable: false,
        message: 'FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON (or FCM_ACCESS_TOKEN) are required',
      };
    }
    let accessToken: string;
    try {
      accessToken = await this.options.tokens.getAccessToken();
    } catch (error) {
      return { ok: false, code: 'provider_error', retryable: true, message: describe(error) };
    }

    const url = `${this.endpoint}/v1/projects/${encodeURIComponent(this.options.projectId)}/messages:send`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildFcmRequestBody(message)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { ok: false, code: 'provider_error', retryable: true, message: describe(error) };
    }

    if (response.ok) {
      const body = (await safeJson(response)) as { name?: unknown } | null;
      return {
        ok: true,
        providerMessageId: typeof body?.name === 'string' ? body.name : null,
      };
    }
    if (response.status === 401) {
      this.options.tokens.invalidate();
    }
    return mapFcmFailure(response.status, extractFcmErrorCode(await safeJson(response)));
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    return body;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
