'use strict';
// Silences NestJS' built-in console logger inside Jest workers so unit test output stays
// readable. Application code logs through `new Logger(...)` from @nestjs/common; the e2e
// factory additionally creates the app with `logger: false`.
const { Logger } = require('@nestjs/common');

Logger.overrideLogger(false);
