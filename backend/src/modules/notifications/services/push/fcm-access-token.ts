import { createSign } from 'node:crypto';

/** OAuth2 scope required by FCM HTTP v1. */
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** Access tokens are refreshed this long before Google says they expire. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

/** Supplies bearer tokens for the FCM adapter. */
export interface AccessTokenProvider {
  readonly configured: boolean;
  /** Throws when the token cannot be obtained (treated as a retryable provider error). */
  getAccessToken(): Promise<string>;
  /** Drops a cached token after the provider answered 401. */
  invalidate(): void;
}

export class StaticAccessTokenProvider implements AccessTokenProvider {
  constructor(private readonly token: string | null) {}

  get configured(): boolean {
    return this.token !== null && this.token.length > 0;
  }

  async getAccessToken(): Promise<string> {
    if (!this.token) {
      throw new Error('FCM_ACCESS_TOKEN is not set');
    }
    return this.token;
  }

  invalidate(): void {
    // A static token cannot be refreshed; the next send reports the failure again.
  }
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** Signs `claims` as an RS256 JWT with a PEM private key (service-account assertion). */
export function signJwtRs256(claims: Record<string, unknown>, privateKeyPem: string): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify(claims));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Accepts the raw service account JSON or its base64 encoding. */
export function parseServiceAccount(raw: string): ServiceAccountKey {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is neither JSON nor base64-encoded JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const clientEmail = record.client_email;
  const privateKey = record.private_key;
  if (typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON needs client_email and private_key');
  }
  return {
    client_email: clientEmail,
    // .env files often keep the key on one line with literal "\n" sequences.
    private_key: privateKey.replace(/\\n/g, '\n'),
    token_uri: typeof record.token_uri === 'string' ? record.token_uri : undefined,
    project_id: typeof record.project_id === 'string' ? record.project_id : undefined,
  };
}

export interface ServiceAccountTokenOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  scope?: string;
  timeoutMs?: number;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

/**
 * OAuth2 "JWT bearer" flow for a Google service account, implemented with Node crypto and
 * fetch so no SDK is needed (docs/deps-requests/notifications.md lists the optional SDK).
 */
export class ServiceAccountTokenProvider implements AccessTokenProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly scope: string;
  private readonly timeoutMs: number;
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly key: ServiceAccountKey,
    options: ServiceAccountTokenOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? ((): Date => new Date());
    this.scope = options.scope ?? FCM_SCOPE;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  get configured(): boolean {
    return true;
  }

  async getAccessToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.cached && this.cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > nowMs) {
      return this.cached.token;
    }
    const tokenUri = this.key.token_uri ?? GOOGLE_TOKEN_URI;
    const issuedAt = Math.floor(nowMs / 1000);
    const assertion = signJwtRs256(
      {
        iss: this.key.client_email,
        scope: this.scope,
        aud: tokenUri,
        iat: issuedAt,
        exp: issuedAt + 3600,
      },
      this.key.private_key,
    );
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    const response = await this.fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Google token endpoint answered ${response.status}`);
    }
    const json = (await response.json()) as TokenResponse;
    if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
      throw new Error('Google token endpoint returned no access_token');
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    this.cached = { token: json.access_token, expiresAt: nowMs + expiresIn * 1000 };
    return json.access_token;
  }

  invalidate(): void {
    this.cached = null;
  }
}
