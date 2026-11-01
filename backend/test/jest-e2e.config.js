'use strict';
// End-to-end tests: `*.e2e-spec.ts` under test/, run against the full AppModule
// created by test/utils/app-factory.ts (queues faked, Prisma lazy).
const base = require('./jest.base');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: 'e2e',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  testTimeout: 30000,
};
