import { Inject } from '@nestjs/common';

/** Injection token for the validated, typed application configuration (`AppConfig`). */
export const APP_CONFIG = Symbol('APP_CONFIG');

/** Shorthand for `@Inject(APP_CONFIG)`. */
export const InjectConfig = (): ParameterDecorator & PropertyDecorator => Inject(APP_CONFIG);
