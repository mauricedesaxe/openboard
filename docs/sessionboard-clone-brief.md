# SessionBoard Open-Source Clone — Consolidated Context

Canonical planning doc for the hackathon effort. Version 0 consolidates the high-level
brief and the SessionBoard product research. The walkthrough YouTube transcript and the
Google Doc background are pending inputs; they slot into the marked sections below.

## What we're building

An open-source clone of [Sessionboard](https://www.sessionboard.com/) (a speaker & event
content management platform that costs their team >$40k/yr) so that we walk away owning
the code. The team runs events on their existing registration platform **Accelevents**.

The product, in one line: a single "system of record" for conference sessions and the
speakers behind them, spanning the whole lifecycle — submissions come in, get reviewed,
become an agenda, get captured during the event, and are repurposed into content after.
The unifying idea is **one connected record**: a session links to its speakers, its
abstract, its transcript, and its derived content, so nothing gets re-entered at any
stage.

## Constraints & success criteria

- **Hackathon deadline:** Wed Aug 12 10PM PT.
- **Submit:** a form, an open-source repo, and a deployed site we can test.
- **Winning:** independent evaluation, $10k cash, and a latent.space writeup.
- **Budget:** up to $500 token reimbursement for valid attempts (proof required).
- **Stack (their stack, so bonus points):** deploy on Cloudflare infra; persist to Airtable.

## Required features (from the brief)

1. Custom call-for-papers submission forms with conditional logic and category-based routing.
2. Self-service speaker portal for bios, headshots, slides, and supporting documents.
3. Automated, templated speaker communications — reminders and calendar invites delivered
   to each speaker's own calendar (Gmail, Outlook, iCal).
4. Submission evaluation and scoring workflows, plus AI-assisted review across multiple
   rounds. **AI-assisted review is now OPTIONAL** (per the doc update).
5. Drag-and-drop schedule and agenda building, with automatic conflict detection across
   rooms and tracks; viewable by list, day, week, track, or room.
6. Real-time dashboard of which speakers still have outstanding onboarding tasks.
7. Native, one-way integration with **Accelevents** (their registration platform) to
   eliminate manual data re-entry. **Now OPTIONAL.**
8. Resource and wiki pages within the speaker portal, including HTML embed support.
   **Now OPTIONAL.**
9. Embeddable, mobile-friendly speaker gallery and schedule itinerary to post to the
   website. **Now OPTIONAL.**

So the **must-have core is features 1–6**: conditional CFP forms, speaker portal, templated
comms + calendar invites, evaluation/scoring, agenda + conflict detection, and the task
dashboard. Features 7–9 and AI-assisted review are stretch "nice if we add them."

## Walkthrough takeaways (swyx, 9:55)

The walkthrough pins the scope tightly and lowers fidelity pressure:

- **Program side only.** "We're probably only going to use the program side... not really
  the marketing, not really the CRM." So CRM, Marketing, CMS pillars are out of scope for
  the clone.
- **Job-to-be-done over fidelity.** "It's not about the fidelity to SessionBoard, it's about
  filling the job to be done." "I don't care about the AI workflow thing."
- **The felt wedge is speed.** He repeatedly calls the incumbent slow on the core flow
  (form → submission). A fast, snappy core loop is itself a differentiator.
- **Screens toured** (the live reference): Event Settings (email templates), Dashboard
  (submission stats), Submissions table (add/import/export CSV, manual vs form entry),
  Forms (the form builder: types abstract/session/pre-program, welcome screen, form
  questions, participant fields with speaker counts, close date, reminders, submission
  limits, thank-you page, admin notification), public form flow (language, continue-to-next
  multi-step), submitter's home (My Submissions, My Tasks, My Profile), Evaluation Plans
  (assign reviewers, due dates, committee evaluation), Agenda (add agenda, dates/times),
  Embeds (embed type + preview schedule).
- Full transcript and highlights are in the session history, not duplicated here.

## What the research says the product is (core competencies)

Everything below is from SessionBoard's own pages, so treat claims like "4x faster" as
positioning, not measured fact. Their four pillars:

- **Program** — submission → review → agenda pipeline.
- **CRM** — the persistent speaker database across events.
- **Marketing / Capture** — transcribe and repurpose sessions into content.
- **CMS** — publish that content (embeds, media library).

Core competencies (the heart of it):

1. **Call for Papers / Abstract Management.** Custom submission forms with conditional
   logic and branching; one intake dashboard; assign reviewers by track, weighted/blinded
   scoring rubrics, AI evaluator support for first-pass triage at scale.
2. **Speaker database / CRM.** A persistent speaker profile across every event, accumulating
   sessions, ratings, contributed content, and communication logs; tagging + advanced search;
   dynamic lists that auto-update.
3. **Agenda builder with conflict logic.** Drag-and-drop scheduling over tracks/rooms/days,
   rule-based constraints, speaker double-booking and room-capacity detection. The
   differentiator is dynamic relationships, not a static calendar.
4. **Content management.** One dashboard to manage bios, titles, abstracts, assets — bulk
   edit, per-field access control, comment/task threads, version history.
5. **Live capture → content repurposing (Marketing).** Live transcription with AI extracting
   topics, themes, quotes, attributed to the speaker; the transcript becomes clips, summaries,
   blog posts, and social copy after the event.
6. **Publish / distribute (CMS).** Embeddable auto-syncing agenda widgets, a media library,
   pushing content out to other tools.
7. **Communication tooling.** In-platform email/SMS templates, automated confirmations,
   reminders, and document requests tied to each speaker record.

Core user flows the MVP must make work:

- **A. Submission → published agenda.** Build form → publish link → submitters apply →
  reviewers score → accept → program items flow directly into agenda + CMS with no
  re-entry → agenda published to an embed. This is the flagship flow, and the structural
  core.
- **B. Find and reuse a speaker.** Import roster → tag/search → pull a past speaker into a
  new event, bio and prior content come along.
- **C. Live capture.** Start transcription on a session → structured, searchable,
  speaker-attributed content appears.
- **D. Repurpose.** Pick a captured session → generate clips/summaries/social posts from the
  transcript → distribute → track engagement.

## Brief → feature mapping

The brief's core (features 1–6) maps onto Flows A and B (forms, portal, communications,
scoring, agenda, task dashboard), plus the now-optional registration integration
(Accelevents) and the now-optional wiki/embeds. The research-identified differentiators
that are *not* in the brief, and are cut for the MVP: live transcription, AI content
repurposing, the media library, and the CRM/Marketing/CMS pillars (swyx confirmed program
only). AI-assisted *review* stays as the one thin, optional slice of AI.

## Out of scope (explicitly descoped)

- Authentication and billing (per instruction — focus on core competencies only).
- SessionBoard's full marketing/content-repurposing engine, Speaker CRM, and CMS.
- Features 7–9 and AI-assisted review are **optional**, not in the must-have core.

## Pending inputs (slot in when ready)

- **Google Doc:** the organizer's background context — not yet provided to us.
- Requirements FREEZE after Saturday and Sunday clarification sessions; core (1–6) is
  already well understood, so we start there now.

## Open questions

- Repo placement + stack (the gating decision for Wayfinder).
