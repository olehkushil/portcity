import { type PushMessage, PushPort, type PushSendResult } from './push.port';

/**
 * Development and test adapter: records every message in memory and reports success.
 * Tests can queue forced results with `failNext()`.
 */
export class StubPushAdapter extends PushPort {
  readonly provider = 'stub';
  readonly sent: PushMessage[] = [];
  private readonly forced: PushSendResult[] = [];

  constructor(private readonly log?: (message: string) => void) {
    super();
  }

  async send(message: PushMessage): Promise<PushSendResult> {
    this.sent.push(message);
    this.log?.(`stub push to ${maskToken(message.token)}: ${message.title}`);
    const forced = this.forced.shift();
    return forced ?? { ok: true, providerMessageId: `stub-${this.sent.length}` };
  }

  /** The next `send()` calls return these results in order (tests). */
  failNext(...results: PushSendResult[]): void {
    this.forced.push(...results);
  }

  clear(): void {
    this.sent.length = 0;
    this.forced.length = 0;
  }
}

export function maskToken(token: string): string {
  return token.length <= 8 ? '****' : `${token.slice(0, 4)}...${token.slice(-4)}`;
}
