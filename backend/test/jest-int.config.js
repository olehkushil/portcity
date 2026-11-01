'use strict';
// Integration tests: `*.int-spec.ts` under test/ (and optionally src/).
// They need PostgreSQL and self-skip when DATABASE_URL is unset (see test/utils/int.ts).
const base = require('./jest.base');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: 'int',
  roots: ['<rootDir>/test', '<rootDir>/src'],
  testRegex: '.*\\.int-spec\\.ts$',
  testTimeout: 30000,
};
