# OpenBoard

OpenBoard is an open-source workspace for running an event program from the call for proposals
through the published agenda. It keeps proposals, reviews, decisions, speakers, onboarding work,
communications, and scheduling connected instead of splitting them across separate tools.

[Open the deployed application](https://openboard.alexlazar.dev/)

## What it does

- Builds conditional call-for-proposals forms with tracks, deadlines, and a fast browser-saved
  proposal draft.
- Gives organizers, reviewers, submitters, and speakers scoped access through passwordless sign-in
  and invitations.
- Assigns submissions for review, records scores and comments, and publishes acceptance or decline
  decisions.
- Turns accepted submissions into program items, then builds and publishes an agenda with room and
  speaker conflict checks.
- Tracks speaker profiles, files, onboarding tasks, and the evidence that makes each speaker ready.
- Sends editable email and calendar communications, with retryable delivery records.
- Publishes the public agenda as a web view, JSON API, and iCalendar feed from one revision.

## Why it exists

OpenBoard began as a remote hackathon response to the cost and breadth of Sessionboard. The brief
asked for an open-source alternative that covered the useful program workflow without copying the
surrounding CRM, billing, CMS, and marketing platform.

The project focuses on one connected journey: an organizer opens a CFP, a submitter proposes a
session, a reviewer evaluates it, the organizer publishes a decision and agenda, and an accepted
speaker completes onboarding. The original planning map is in
[issue #1](https://github.com/mauricedesaxe/openboard/issues/1), and the implementation specification
is in [issue #18](https://github.com/mauricedesaxe/openboard/issues/18).

## Architecture

OpenBoard is a React and TypeScript application deployed as one Cloudflare Worker. tRPC and Zod
provide the typed application boundary. Cloudflare D1 stores authoritative application data, while
R2 stores uploaded files. Better Auth owns passwordless identity and session state inside the same
application.

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

Production requires `APP_ENV=production`, an HTTPS `APP_URL`, a random `BETTER_AUTH_SECRET`, and an
explicit email transport. The deployment workflow requires `PRODUCTION_BETTERSTACK_SOURCE_TOKEN`
for telemetry export. The primary setup uses `EMAIL_TRANSPORT=cloudflare`,
`EMAIL_FROM=auth@alexlazar.dev`, and the `EMAIL` binding in `wrangler.jsonc`. The documented fallback
uses `EMAIL_TRANSPORT=resend`, the same `EMAIL_FROM`, and `RESEND_API_KEY`. The Worker returns a typed
503 response instead of serving the application when configuration is incomplete or unsafe.

Production problem reports require `BETTERSTACK_INCIDENT_API_TOKEN`,
`BETTERSTACK_INCIDENT_POLICY_ID`, and `BETTERSTACK_INCIDENT_REQUESTER_EMAIL` as Worker secrets. The
token must be a team-scoped Uptime API token. The policy must route email to the app owner.

## Production observability

Production telemetry must keep the request-to-delivery path visible across later cron attempts and
retries. It must not record recipients, message content, uploaded-file details, request content, or
arbitrary error messages. Unhandled exceptions retain their stack. Handled failures use stable event
codes and safe domain IDs.

Scheduled work runs every minute through the cron trigger declared in `wrangler.jsonc`. Each
successful run pings the dedicated OpenBoard Better Stack heartbeat configured through the
`BETTERSTACK_HEARTBEAT_URL` Worker secret. The deployment workflow requires
`PRODUCTION_BETTERSTACK_HEARTBEAT_URL` and fails the production deploy when it is missing, so a
dropped secret cannot silently remove the schedule detector. Only production configuration can
satisfy the heartbeat, so preview and local runs never keep it alive or trigger its incidents. A
missed heartbeat emails the app owner, which detects a stopped schedule even while HTTP traffic
stays healthy. Treat the heartbeat URL as a credential: anyone who holds it can keep the heartbeat
quiet through a genuine outage, so it never belongs in logs, PR descriptions, or other tracker
artifacts.
