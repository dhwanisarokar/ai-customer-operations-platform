# Testing

- **Unit/integration:** Vitest (`npm test`). Tests live beside source as `*.test.ts(x)`; cross-cutting
  tests and setup in `tests/`. React Testing Library + jest-dom are configured for component tests.
- **E2E:** Playwright — to be added with the first user journey.

## Priorities

Authorization and tenant isolation, validation failures, AI agent execution, workflow execution, job
retries, webhook idempotency, subscription state changes. Coverage is a signal, not a target.

## Current tests

- `src/lib/env.test.ts` — env validation, no value leakage in errors.
- `src/server/services/health.test.ts` — health status for up/down database.

Database-backed integration tests will run against a real Postgres (service container in CI), not mocks.
