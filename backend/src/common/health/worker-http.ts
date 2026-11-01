import type { NextFunction, Request, Response } from 'express';
import { PROBLEM_CONTENT_TYPE, problemTypeFor } from '../errors/problem-details';

const ALLOWED = new Set(['/health', '/ready']);

/** The worker exposes only the probes; every other route answers 404 problem+json. */
export function workerHttpAllowlist(req: Request, res: Response, next: NextFunction): void {
  const path = (req.originalUrl || req.url || '').split('?')[0] ?? '';
  if (ALLOWED.has(path)) {
    next();
    return;
  }
  res.statusCode = 404;
  res.setHeader('Content-Type', PROBLEM_CONTENT_TYPE);
  res.end(
    JSON.stringify({
      type: problemTypeFor('PC_COMMON_NOT_FOUND'),
      title: 'Not found',
      status: 404,
      code: 'PC_COMMON_NOT_FOUND',
      detail: 'The worker process serves only /health and /ready',
      instance: path,
    }),
  );
}
