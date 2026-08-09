# OpenBoard

OpenBoard manages the program side of an event, from submissions through review, speaker
onboarding, and the published schedule. This glossary names the records and relationships used
across that workflow.

## Language

**Event**:
A conference or similar gathering whose program is managed in OpenBoard.

**User**:
A person with a verified OpenBoard identity managed by Better Auth. Domain records reference the
user's stable `UserId`; email addresses are contact points, not identity.
_Avoid_: Principal

**Event owner**:
The one person responsible for an event's ownership and organizer access.
_Avoid_: Global administrator

**Organizer**:
A person permitted to manage an event's program, reviewers, submissions, agenda, speakers, and
communications.

**Event role**:
One organizer or reviewer access grant linking a user to an event. Roles are additive and event
ownership remains separate.

**Invitation**:
A pending, expiring offer to establish an event role or link a submission speaker to a verified
user. Accepting requires email verification; declining requires only the invitation's secret link.

**Call for proposals (CFP)**:
An event's public invitation and form for proposed talks, workshops, or panels.
_Avoid_: Call for papers, submission form

**Form definition**:
An event-owned set of fields and validation rules used by a CFP or onboarding task.

**Form response**:
One set of answers to a form definition, belonging either to a submission or to one revision of a
task assignment that uses a form.

**Submission**:
One proposed talk, workshop, or panel sent to an event through a CFP or entered by an organizer.
_Avoid_: Session, talk

**Program**:
The accepted talks, workshops, and panels belonging to an event. The program is the collection of
the event's program items, not an independent record.

**Program item**:
An accepted talk, workshop, or panel in an event's program. Publishing acceptance creates exactly
one program item linked to its submission and independent of any agenda placement.
_Avoid_: Session

**Submission owner**:
The person accountable for a submission and permitted to edit the proposal. Ownership and speaking
are independent relationships; a public CFP defaults the owner into the speaker list.
_Avoid_: Submitter

**Abstract**:
A short description of what a submission proposes to cover.
_Avoid_: Description, summary

**Submission speaker**:
A person named as a potential speaker on a submission. The relationship may remain unclaimed with
an invited name and email or link to a verified user, and remains the same before and after
acceptance.
_Avoid_: Participant

**Proposed speaker**:
The UI term for a submission speaker whose submission has not been accepted.

**Speaker**:
The UI term for a submission speaker whose submission has been accepted.

**Speaker profile**:
A speaker-owned, reusable record containing personal presentation information such as a bio and
headshot.

**Reviewer**:
A person permitted to evaluate submissions assigned to them for an event.

**Review round**:
One named review campaign for a CFP, defining reviewer visibility, scoring rules, due date, and
whether reviewing is open or closed.

**Reviewer assignment**:
The revocable relationship permitting one reviewer to evaluate one submission in one review round.

**Review**:
One reviewer's score and optional comment for an assigned submission.

**Decision**:
The current outcome for one submission: pending, internally queued for acceptance or decline, or
published as accepted or declined.

**Track**:
A topic grouping for submissions and scheduled sessions within an event.
_Avoid_: Category

**Room**:
The physical or virtual place where a scheduled part of an event happens.
_Avoid_: Location

**Agenda item**:
One durable placement on an agenda. An agenda item is either a program placement referencing one
program item or a service block containing its own details, never both. Removing a program placement
from the schedule cancels its agenda item rather than deleting it.

**Service block**:
Agenda-native content such as registration, a break, lunch, or a reception. A service block is a
kind of agenda item, not an independent record.

**Scheduled session**:
The UI term for a program item once it has been placed on an agenda.

**Agenda**:
An event's scheduling workspace and publication boundary, containing program placements and service
blocks across times, rooms, and tracks.
_Avoid_: Calendar, timetable

**Working agenda**:
The private agenda organizers are still preparing.
_Avoid_: Draft schedule

**Published agenda**:
The public projection of agenda information that organizers have deliberately released.
_Avoid_: Live agenda

The [program and agenda relationship](docs/diagrams/program-and-agenda.png) is also preserved as an
editable [tldraw board](docs/diagrams/program-and-agenda.tldr).

**Calendar sync state**:
The stable iCalendar UID, sequence, and cancellation state used to synchronize one published agenda
placement with external calendars.

**Task definition**:
An event-owned reusable requirement whose target scope and completion mechanism become fixed after
its first assignment.

**Task assignment**:
One required or optional obligation created from a task definition. Completion is derived from
current-revision manual confirmation, profile data, form response, stored file, waiver, or organizer
override evidence rather than a stored completed flag.

**Event-speaker task**:
A task one user completes once for one event.

**Program-item task**:
A shared task that any claimed speaker may complete once for one program item.

**Program-item-speaker task**:
A task one submission speaker completes specifically for one program item.

**Stored file**:
File identity and immutable R2 metadata. A stored file gains domain meaning through a speaker-profile,
task-assignment, or form-response attachment.

**Communication**:
One rendered message intended for one user or invitation. Delivery retries are append-only attempts
and never change the domain state that caused the message.
