import { type ValidationOptions, registerDecorator } from 'class-validator';
import { isValidDayKey } from '../domain/daily-report';
import { isValidFeatureFlagKey } from '../domain/feature-flag-rules';

type PropertyDecoratorFn = (target: object, propertyName: string | symbol) => void;

/** `yyyy-MM-dd` that exists on the calendar (rejects 2026-02-30). */
export function IsDayKey(options?: ValidationOptions): PropertyDecoratorFn {
  return (target, propertyName): void => {
    registerDecorator({
      name: 'isDayKey',
      target: target.constructor,
      propertyName: String(propertyName),
      options,
      validator: {
        validate: (value: unknown): boolean => isValidDayKey(value),
        defaultMessage: (): string =>
          `${String(propertyName)} must be a calendar day in the format yyyy-MM-dd`,
      },
    });
  };
}

/** Lowercase dotted feature flag key such as `parking.info_mode`. */
export function IsFeatureFlagKey(options?: ValidationOptions): PropertyDecoratorFn {
  return (target, propertyName): void => {
    registerDecorator({
      name: 'isFeatureFlagKey',
      target: target.constructor,
      propertyName: String(propertyName),
      options,
      validator: {
        validate: (value: unknown): boolean => isValidFeatureFlagKey(value),
        defaultMessage: (): string =>
          `${String(propertyName)} must be lowercase dotted segments like parking.info_mode`,
      },
    });
  };
}
