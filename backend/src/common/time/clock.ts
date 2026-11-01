import { Injectable } from '@nestjs/common';

/**
 * Injectable time source. Services must call `clock.now()` instead of `new Date()`
 * so that tests can control time with `FakeClock`.
 * The abstract class is the injection token: `constructor(private readonly clock: Clock) {}`.
 */
export abstract class Clock {
  abstract now(): Date;

  nowMs(): number {
    return this.now().getTime();
  }
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export class FakeClock extends Clock {
  private current: number;

  constructor(initial: Date | string | number = '2026-01-15T10:00:00.000Z') {
    super();
    this.current = new Date(initial).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(value: Date | string | number): void {
    this.current = new Date(value).getTime();
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }

  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1000);
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }

  advanceHours(hours: number): void {
    this.advance(hours * 3_600_000);
  }

  advanceDays(days: number): void {
    this.advance(days * 86_400_000);
  }
}
