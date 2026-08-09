# Authentication and authorization

Status: Authentication and authorization boundary decided on 2026-08-08 in
[issue #10](https://github.com/mauricedesaxe/openboard/issues/10).

## Decision

OpenBoard owns its identity and authorization boundary. It embeds Better Auth in the OpenBoard
Worker, stores authentication state in OpenBoard's D1 database, and initially supports passwordless
email codes. The private Lazar identity service is a reference for tested security choices, not a
runtime dependency.

This keeps OpenBoard self-hostable and avoids maintaining one authentication path for Lazar and a
second path for public installations. Optional OIDC providers can be added later without changing
the domain's user identifiers.

## Identity and sessions

- Better Auth's D1 user ID is OpenBoard's stable `UserId`.
- Domain records reference `UserId`, never an email address.
- One user has one verified email address in the first version.
- Better Auth issues a secure, HttpOnly, same-origin session cookie. Browser JavaScript never holds
  an API token.
- A session expires after seven inactive days and renews while its user remains active.
- Passwordless codes are short-lived and single-use. Requests are limited by IP and normalized-email
  hash, and verification attempts are bounded.
- Authentication responses do not reveal whether an email address already has an account.
- CAPTCHA is not required initially. It can be added if measured abuse makes rate limits
  insufficient.

## Authentication flows

### Public submission

Anyone can open a CFP and build a browser-local draft without an account. The draft remains on that
browser and device. At final submission, OpenBoard verifies the submission owner's email in place,
creates or resumes their session, and writes the submission under their `UserId`.

The browser keeps the local draft until D1 confirms the submission. A failed or expired code and a
page reload must not discard it. Fully anonymous submissions that are claimed later are not
supported.

### Additional speakers

An additional submission speaker starts as an unclaimed relationship with an invited email address.
They receive a single-use invitation link and prove control of that address with an email code.
OpenBoard then links the submission speaker to their `UserId`; authorization no longer depends
on email matching.

The decline link opens a confirmation page. An explicit unauthenticated action using that secret
declines the invitation, creates no user or access grant, and stops further reminders. Unclaimed
submission speakers receive no other operational communications.

Before claim, the submission owner or an organizer can correct the invited address and reissue the
invitation. Correction or reissue atomically advances its version only while the submission speaker
remains unclaimed, invalidating every earlier invitation link. A claim atomically links the user
only when that invitation version is current and the submission speaker remains unclaimed. This
prevents stale invitations or concurrent claimants from linking a user to the relationship. The first
version does not link several verified email addresses to one user.

### Organizers and reviewers

Any verified user can create an event and becomes its owner. Additional organizers and
reviewers join through revocable, expiring email invitations. An invitation grants no access until
the recipient verifies the invited address.

Only the event owner grants or revokes organizer access. Any organizer may grant or revoke reviewer
access and create reviewer assignments.

## Authorization model

Authentication establishes the user. It does not establish permission to an event or resource.
Every tRPC procedure selects a named server-side guard that loads the requested relationship and
fails closed before the handler runs.

The initial guard vocabulary is:

- `public`: no user required; limited to deliberately public data and authentication entry
  points.
- `authenticated`: any verified user.
- `eventOwner`: the event's owner.
- `eventOrganizer`: the owner or an organizer of the event.
- `assignedReviewer`: a reviewer assigned to the requested submission in the requested review round.
- `submissionOwner`: the user accountable for the requested submission.
- `submissionSpeaker`: a user linked as a speaker to the requested submission.

Frontend route protection improves navigation but is not an authorization boundary.

## Resource rules

### Events and roles

- Any authenticated user may create an event.
- An event has exactly one owner.
- The owner controls organizer access, ownership transfer, and event deletion.
- Organizers control event operations and reviewer access.
- Organizer and reviewer roles are additive. Speaking remains a separate submission-speaker
  relationship, so a user may organize, review, and speak within one event.
- A reviewer cannot be assigned to a submission they own or speak on.

### Submissions and reviews

- The submission owner and event organizers may edit a proposal in the first version.
- Other linked submission speakers may view the proposal but cannot edit it.
- Reviewers may access only explicitly assigned submissions.
- Reviewer procedures return a review-round-specific projection. They do not expose the complete
  organizer-facing submission, speaker contact details, tasks, files, communications, or unreleased
  decisions.
- Whether a reviewer projection includes speaker names is review-round policy, not a broader access
  grant.

Bulk organizer actions may create many reviewer assignments. A bulk action does not create a
persistent event-wide or track-wide read permission. Rules that assign reviewers to future
submissions are deferred.

### Profiles, tasks, and files

- A speaker controls edits to their reusable speaker profile.
- Organizers may read profile fields needed for events where that speaker participates, but cannot
  silently change the shared profile.
- A speaker may access their own event-speaker and program-item-speaker tasks and files.
- Speakers linked to a submission may access its shared program-item tasks and files.
- Organizers may access speaker and program-item resources where required to run their event.
- Review access does not include speaker tasks or files.

### Agenda

- Organizers read and edit the private working agenda.
- Speakers may read their own confirmed placement.
- Public users may read only an explicitly published agenda projection.
- Publication never exposes internal scheduling notes or unpublished changes.

### Communications

- Organizers may access event communication history and delivery state.
- A user may access only communications addressed to them.
- An event role alone does not grant access to another recipient's communication.

## State owned in D1

Better Auth owns its user, session, account, and verification records in OpenBoard's D1 database.
OpenBoard owns the authorization state that gives those users meaning inside the product:

- event ownership and organizer or reviewer role grants;
- pending privileged invitations;
- submission ownership;
- submission-speaker links and pending speaker invitations;
- reviewer assignments;
- agenda publication state;
- resource ownership and subject links for profiles, tasks, files, and communications; and
- security audit records.

OpenBoard records event creation, ownership transfer, invitation acceptance or revocation, event
role changes, speaker-account linking, publication, and denied mutation attempts. Ordinary
successful reads are not audited.

## Self-hosting and previews

A production deployment validates its authentication secret, canonical application URL, D1
binding, and email sender at startup. It refuses to start as usable when any required dependency is
missing. Production never writes authentication codes or bearer credentials to logs.

Local development uses a mail-capture adapter. Each deployed preview uses the real Better Auth flow
against isolated D1 state and restricts outbound authentication email to configured tester
addresses. Preview sessions do not cross into production, and previews do not provide a role-switch
bypass.

## Deferred

- Cross-device pre-authentication drafts.
- Multiple verified emails per user.
- Collaborative proposal editing by co-speakers.
- Rules that automatically assign reviewers to future submissions.
- CAPTCHA.
- External API tokens.
- Lazar or other OIDC sign-in.
