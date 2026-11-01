'use strict';
// Unit tests: `*.spec.ts` next to the code under src/. No database, no Redis.
const base = require('./test/jest.base');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: 'unit',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
};
