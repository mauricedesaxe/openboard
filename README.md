# OpenBoard

OpenBoard manages an event program from submissions through the published agenda.

## Local development

Requirements: Node 22 and the pnpm version pinned in `package.json`.

1. Run `pnpm install`.
2. Copy `.dev.vars.example` to `.dev.vars` and replace the authentication secret.
3. Run `pnpm db:migrate:local`.
4. Run `pnpm dev`.

Local sign-in uses the capture transport. The requested code appears in the sign-in form and is
never emitted by preview or production configurations.

## Checks

Run `pnpm check` to execute formatting, linting, type checking, isolated D1 tests, and the Worker
and SPA build.

Production requires `APP_ENV=production`, an HTTPS `APP_URL`, a random `BETTER_AUTH_SECRET`, and
the Resend variables checked by `src/server/config.ts`. The Worker returns a typed 503 response
instead of serving the application when configuration is incomplete or unsafe.
