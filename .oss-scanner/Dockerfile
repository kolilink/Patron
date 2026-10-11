# OSS Scanner build for Patron (Expo / React Native + TypeScript client, Supabase backend).
# Build context is the repo checkout; the scanner contract puts it at /src.
# Network is available only while this Dockerfile builds. Everything the scan needs is fetched here.
FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    CI=1 \
    EXPO_NO_TELEMETRY=1 \
    npm_config_fund=false \
    npm_config_update_notifier=false

# python3 + numpy: one hermetic test (notification-chime determinism) shells out to Python.
# git/ca-certificates: some npm dependencies resolve via git.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git python3 python3-pip python3-numpy \
    && rm -rf /var/lib/apt/lists/*

COPY . /src
WORKDIR /src

# Exact lockfile install (.npmrc sets legacy-peer-deps=true). node_modules stays in the image for the offline scan.
RUN npm ci

# Prove the build: type-check, then the hermetic unit suite (jest, mocked Supabase / expo modules).
# Failures are reported but do not abort the image, so the scanner still gets the full source tree.
RUN npx tsc --noEmit || echo "WARNING: tsc reported errors"
RUN npx jest --ci || echo "WARNING: jest reported failures"

# Deliberately NOT run: __tests__/integration/ (jest.integration.config.js). Those tests execute the real
# SQL functions in db/ against a local Supabase/Postgres stack (Docker-in-Docker, supabase CLI), which does not
# exist in this image and cannot be fetched at scan time. The SQL lives in db/schema.sql + db/migration_v*.sql
# and the edge functions in supabase/functions/ (Deno/TypeScript) and can be read and reasoned about statically.
