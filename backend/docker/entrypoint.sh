#!/bin/sh
# Container entrypoint: applies pending Prisma migrations (unless RUN_MIGRATIONS=false),
# then execs the given command (API by default, worker via CMD override).
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] prisma migrate deploy"
  npx prisma migrate deploy --schema prisma/schema
else
  echo "[entrypoint] skipping migrations (RUN_MIGRATIONS=${RUN_MIGRATIONS})"
fi

exec "$@"
