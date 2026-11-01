'use strict';
// Shared Jest settings for the unit, integration and e2e configurations.
// Tests are transpiled with @swc/jest (decorator metadata enabled, CommonJS output);
// type checking is done separately by `npm run typecheck`.
const path = require('node:path');

const swcConfig = {
  jsc: {
    parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: 'es2022',
    keepClassNames: true,
  },
  module: { type: 'commonjs' },
  sourceMaps: 'inline',
};

/** @type {import('jest').Config} */
module.exports = {
  rootDir: path.resolve(__dirname, '..'),
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['@swc/jest', swcConfig] },
  setupFiles: ['<rootDir>/test/setup-env.js', '<rootDir>/test/setup-nest.js'],
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 15000,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/main.ts',
    '!src/worker.ts',
    '!src/worker-mode.ts',
    '!src/scripts/**',
    '!src/**/index.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text-summary', 'lcov'],
};
