'use strict';
// Runs in every Jest worker before test files are loaded.
// Keeps tests deterministic regardless of the developer machine time zone and
// makes the application boot without external services.
process.env.NODE_ENV = 'test';
process.env.TZ = 'UTC';
process.env.PRISMA_LAZY_CONNECT = process.env.PRISMA_LAZY_CONNECT || 'true';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.LOG_PRETTY = 'false';
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'memory';
process.env.QUEUE_DRIVER = process.env.QUEUE_DRIVER || 'memory';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-only-jwt-secret-0123456789abcdef0123456789';
process.env.OTP_PEPPER = process.env.OTP_PEPPER || 'test-only-otp-pepper';
process.env.VOUCHER_PEPPER = process.env.VOUCHER_PEPPER || 'test-only-voucher-pepper';
process.env.MEMBER_QR_SECRET = process.env.MEMBER_QR_SECRET || 'test-only-member-qr-secret';
process.env.THROTTLE_LIMIT = process.env.THROTTLE_LIMIT || '100000';
process.env.DOCS_ENABLED = 'false';
