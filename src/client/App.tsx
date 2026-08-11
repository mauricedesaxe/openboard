import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";

import {
  cfpDefinitionInputSchema,
  conditionSourceFields,
  nextCustomFieldKey,
  removeCustomField,
  visibleCustomFields,
  type CfpDefinitionInput,
  type CustomField,
} from "../shared/cfps";
import {
  eventLocalDateTimeToIso,
  instantFallsAfterLocalDate,
  isoToEventLocalDateTime,
} from "../shared/date-time";
import type { EventRole, InvitationId } from "../shared/event-team";
import {
  eventInputSchema,
  listTimezones,
  slugifyEventName,
  type EventInput,
} from "../shared/events";
import type { SpeakerProfileInput } from "../shared/speaker-profiles";
import {
  proposalContentSchema,
  proposalDraftSchema,
  type ProposalContent,
  type ProposalDraft,
  type Submission,
  type SubmissionId,
} from "../shared/submissions";

import { AgendaPage, PublicAgendaPage } from "./AgendaPage";
import { authClient } from "./auth";
import { useTRPC } from "./trpc";

const ONBOARDING_REFETCH_INTERVAL_MS = 15_000;
const FILE_ENCODING_CHUNK_BYTES = 32_768;

function pluralize(count: number, singular: string) {
  return count === 1 ? singular : `${singular}s`;
}

export function App() {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo({ left: 0, top: 0 });
  }, [location.pathname]);

  return (
    <Routes>
      <Route path="/events/:slug/cfp" element={<PublicCfpPage />} />
      <Route path="/events/:slug/schedule" element={<PublicAgendaPage />} />
      <Route path="/*" element={<SessionApp />} />
    </Routes>
  );
}

function SessionApp() {
  const session = authClient.useSession();
  const location = useLocation();

  if (session.isPending) {
    return <FullPageStatus label="Opening your board" />;
  }

  if (session.error) {
    return <SessionUnavailable />;
  }

  return (
    <Routes>
      <Route
        path="/invitations/:secret"
        element={
          <InvitationPage
            email={session.data?.user.email}
            signedIn={Boolean(session.data)}
          />
        }
      />
      <Route
        path="/speaker-invitations/:secret"
        element={
          <SpeakerInvitationPage
            email={session.data?.user.email}
            signedIn={Boolean(session.data)}
          />
        }
      />
      <Route
        path="/sign-in"
        element={<SignInRoute signedIn={Boolean(session.data)} />}
      />
      <Route
        path="/*"
        element={
          session.data ? (
            <AuthenticatedApp email={session.data.user.email} />
          ) : (
            <Navigate
              to={`/sign-in?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`}
              replace
            />
          )
        }
      />
    </Routes>
  );
}

function SignInRoute({ signedIn }: { signedIn: boolean }) {
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get("returnTo"));
  return signedIn ? <Navigate to={returnTo} replace /> : <SignInPage />;
}

function AuthenticatedApp({ email }: { email: string }) {
  const trpc = useTRPC();
  const speakerProfile = useQuery(trpc.speakerProfile.getOwn.queryOptions());
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="wordmark" to="/">
          <span className="wordmark-mark">OB</span>
          <span>OpenBoard</span>
        </Link>
        <div className="account-strip">
          {speakerProfile.data?.eligible && (
            <>
              <Link className="text-button" to="/tasks">
                My tasks
              </Link>
              <Link className="text-button" to="/speaker-profile">
                Speaker profile
              </Link>
            </>
          )}
          <span>{email}</span>
          <button
            className="text-button"
            onClick={() => void authClient.signOut()}
            type="button"
          >
            Sign out
          </button>
        </div>
      </header>
      <main>
        <Routes>
          <Route index element={<EventIndex />} />
          <Route path="events/new" element={<CreateEventPage />} />
          <Route path="events/:slug" element={<EventPage />} />
          <Route path="events/:slug/cfp/setup" element={<CfpSetupPage />} />
          <Route path="events/:slug/review" element={<ReviewPage />} />
          <Route path="events/:slug/agenda" element={<AgendaPage />} />
          <Route
            path="events/:slug/onboarding"
            element={<OrganizerOnboardingPage />}
          />
          <Route
            path="submissions/:submissionId"
            element={<SubmissionPage />}
          />
          <Route path="speaker-profile" element={<SpeakerProfilePage />} />
          <Route path="tasks" element={<SpeakerTasksPage />} />
        </Routes>
      </main>
    </div>
  );
}

function SignInPage() {
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get("returnTo"));
  const pendingEmail = window.sessionStorage.getItem(
    pendingSignInKey(returnTo),
  );
  const invitationSignIn =
    returnTo.startsWith("/invitations/") ||
    returnTo.startsWith("/speaker-invitations/");
  const proposalSignIn = /^\/events\/[^/]+\/cfp$/.test(returnTo);
  const [email, setEmail] = useState(
    pendingEmail ?? searchParams.get("email") ?? "",
  );
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">(
    pendingEmail ? "code" : "email",
  );
  const [devCode, setDevCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function requestCode(event: FormEvent) {
    event.preventDefault();
    await sendCode();
  }

  async function sendCode() {
    setBusy(true);
    setError(undefined);
    setCode("");
    setDevCode(undefined);
    const result = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    setBusy(false);

    if (result.error) {
      setError("The code could not be sent. Try again.");
      return;
    }

    setStep("code");
    window.sessionStorage.setItem(pendingSignInKey(returnTo), email);
    if (import.meta.env.DEV) {
      const response = await fetch(
        `/api/dev/auth-code?email=${encodeURIComponent(email)}`,
      );
      if (response.ok) {
        const captured: unknown = await response.json();
        if (
          typeof captured === "object" &&
          captured !== null &&
          "code" in captured &&
          typeof captured.code === "string"
        ) {
          setDevCode(captured.code);
        }
      }
    }
  }

  function useAnotherEmail() {
    setStep("email");
    setCode("");
    setDevCode(undefined);
    setError(undefined);
    window.sessionStorage.removeItem(pendingSignInKey(returnTo));
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const result = await authClient.signIn.emailOtp({ email, otp: code });
    setBusy(false);

    if (result.error) {
      setCode("");
      setError(
        "That code is invalid or expired. Request a new code if needed.",
      );
      return;
    }

    window.sessionStorage.removeItem(pendingSignInKey(returnTo));
  }

  return (
    <main className="signin-page">
      <section className="signin-intro">
        <div className="eyebrow">Program operations, one connected board</div>
        <h1>
          Build the event.
          <br />
          Keep the thread.
        </h1>
        <p>
          Move from proposals to a published agenda without losing the people,
          decisions, or details between them.
        </p>
        <div className="route-line" aria-hidden="true">
          <span>CFP</span>
          <i />
          <span>Review</span>
          <i />
          <span>Agenda</span>
          <i />
          <span>Ready</span>
        </div>
      </section>
      <section className="signin-panel">
        <div className="panel-number">01</div>
        <div>
          <div className="eyebrow">
            {invitationSignIn
              ? "Invitation access"
              : proposalSignIn
                ? "Proposal access"
                : "Owner access"}
          </div>
          <h2>
            {step === "email" ? "Start with your email" : "Check your inbox"}
          </h2>
          <p className="muted">
            {step === "email"
              ? "We’ll send a short-lived code. No password to remember."
              : `Enter the six-digit code sent to ${email}.`}
          </p>
        </div>
        {step === "email" ? (
          <form onSubmit={(event) => void requestCode(event)}>
            <Field label="Work email" name="email">
              <input
                autoComplete="email"
                id="email"
                name="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
                type="email"
                value={email}
              />
            </Field>
            <button className="primary-button" disabled={busy} type="submit">
              {busy ? "Sending…" : "Send sign-in code"}
            </button>
          </form>
        ) : (
          <form onSubmit={(event) => void verifyCode(event)}>
            {devCode && (
              <div className="dev-code">
                Local code: <strong>{devCode}</strong>
              </div>
            )}
            <Field label="Sign-in code" name="code">
              <input
                autoComplete="one-time-code"
                id="code"
                inputMode="numeric"
                maxLength={6}
                name="code"
                onChange={(event) => setCode(event.target.value)}
                pattern="[0-9]{6}"
                placeholder="000000"
                required
                value={code}
              />
            </Field>
            <div className="code-actions">
              <button className="primary-button" disabled={busy} type="submit">
                {busy
                  ? "Verifying…"
                  : invitationSignIn
                    ? "Continue to invitation"
                    : proposalSignIn
                      ? "Return to proposal"
                      : "Open my board"}
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void sendCode()}
                type="button"
              >
                Resend code
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={useAnotherEmail}
                type="button"
              >
                Use another email
              </button>
            </div>
          </form>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}

function pendingSignInKey(returnTo: string): string {
  return `openboard:pending-sign-in:${returnTo}`;
}

function EventIndex() {
  const trpc = useTRPC();
  const events = useQuery(trpc.events.list.queryOptions());
  const submissions = useQuery(trpc.submissions.list.queryOptions());

  return (
    <div className="page page-wide">
      <section className="page-heading">
        <div>
          <div className="eyebrow">Your events</div>
          <h1>The program starts here.</h1>
        </div>
        <Link className="primary-button link-button" to="/events/new">
          Create an event
        </Link>
      </section>
      {(events.isPending || submissions.isPending) && (
        <BoardStatus label="Loading your board" />
      )}
      {events.isError && (
        <BoardStatus
          label="Events are unavailable"
          detail={events.error.message}
        />
      )}
      {submissions.isError && (
        <BoardStatus
          label="Proposals are unavailable"
          detail={submissions.error.message}
        />
      )}
      {events.data?.length === 0 && submissions.data?.length === 0 && (
        <section className="empty-board">
          <span className="empty-number">00</span>
          <h2>No events yet</h2>
          <p>
            Create the boundary that will hold your CFP, review, speakers, and
            agenda.
          </p>
          <Link className="arrow-link" to="/events/new">
            Create the first event <span>→</span>
          </Link>
        </section>
      )}
      {events.data && events.data.length > 0 && (
        <div className="event-grid">
          {events.data.map((event, index) => (
            <Link
              className="event-card"
              key={event.id}
              to={`/events/${event.slug}`}
            >
              <span className="card-index">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h2>{event.name}</h2>
              <p>{formatDateRange(event.startsOn, event.endsOn)}</p>
              <span className="card-timezone">{event.timezone}</span>
              <span className="card-arrow">↗</span>
            </Link>
          ))}
        </div>
      )}
      {submissions.data && submissions.data.length > 0 && (
        <section className="owned-submissions">
          <div className="page-heading">
            <div>
              <div className="eyebrow">Your proposals</div>
              <h2>Keep your submissions current.</h2>
            </div>
          </div>
          <div className="event-grid">
            {submissions.data.map((submission, index) => (
              <Link
                className="event-card"
                key={submission.id}
                to={`/submissions/${submission.id}`}
              >
                <span className="card-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h2>{submission.title}</h2>
                <p>{submission.event.name}</p>
                <span className="card-timezone">{submission.status}</span>
                <span className="card-arrow">↗</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function CreateEventPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const createEvent = useMutation(
    trpc.events.create.mutationOptions({
      onSuccess: async (event) => {
        await queryClient.invalidateQueries(trpc.events.list.queryFilter());
        void navigate(`/events/${event.slug}`);
      },
    }),
  );
  const [input, setInput] = useState<EventInput>({
    name: "",
    slug: "",
    startsOn: "",
    endsOn: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  });
  const [validationError, setValidationError] = useState<string>();
  const [slugEdited, setSlugEdited] = useState(false);

  function update<K extends keyof EventInput>(field: K, value: EventInput[K]) {
    setInput((current) => ({ ...current, [field]: value }));
  }

  function updateName(name: string) {
    setInput((current) => ({
      ...current,
      name,
      slug: slugEdited ? current.slug : slugifyEventName(name),
    }));
  }

  function updateSlug(slug: string) {
    setSlugEdited(true);
    update("slug", slug.toLowerCase());
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = eventInputSchema.safeParse(input);
    if (!parsed.success) {
      setValidationError(formatEventValidationError(parsed.error.issues[0]));
      return;
    }

    setValidationError(undefined);
    createEvent.mutate(parsed.data);
  }

  return (
    <div className="page create-layout">
      <aside className="create-aside">
        <Link className="arrow-link" to="/">
          ← Back to events
        </Link>
        <div className="step-marker">
          <strong>01</strong>
          <span>Event boundary</span>
        </div>
        <h1>Name the place where the program comes together.</h1>
        <p>
          The event dates and timezone anchor every deadline and agenda
          placement that follows.
        </p>
      </aside>
      <section className="form-board">
        <form onSubmit={submit}>
          <Field label="Event name" name="name">
            <input
              id="name"
              onChange={(event) => updateName(event.target.value)}
              placeholder="Northstar Conference"
              required
              value={input.name}
            />
          </Field>
          <Field hint="Used in the public URL" label="Slug" name="slug">
            <div className="slug-input">
              <span>/events/</span>
              <input
                id="slug"
                onChange={(event) => updateSlug(event.target.value)}
                placeholder="northstar-2027"
                required
                value={input.slug}
              />
            </div>
          </Field>
          <div className="field-pair">
            <Field label="Starts" name="startsOn">
              <input
                id="startsOn"
                onChange={(event) => update("startsOn", event.target.value)}
                type="date"
                value={input.startsOn}
              />
            </Field>
            <Field label="Ends" name="endsOn">
              <input
                id="endsOn"
                onChange={(event) => update("endsOn", event.target.value)}
                type="date"
                value={input.endsOn}
              />
            </Field>
          </div>
          <Field
            hint="All deadlines and agenda times use this zone"
            label="Timezone"
            name="timezone"
          >
            <select
              id="timezone"
              onChange={(event) => update("timezone", event.target.value)}
              value={input.timezone}
            >
              {listTimezones().map((timezone) => (
                <option key={timezone} value={timezone}>
                  {timezone}
                </option>
              ))}
            </select>
          </Field>
          {(validationError || createEvent.error) && (
            <p className="form-error" role="alert">
              {validationError ?? createEvent.error?.message}
            </p>
          )}
          <button
            className="primary-button"
            disabled={createEvent.isPending}
            type="submit"
          >
            {createEvent.isPending ? "Creating…" : "Create event"}
          </button>
        </form>
      </section>
    </div>
  );
}

function EventPage() {
  const { slug = "" } = useParams();
  const trpc = useTRPC();
  const event = useQuery(trpc.events.get.queryOptions({ slug }));

  if (event.isPending) return <FullPageStatus label="Opening event" />;
  if (event.isError)
    return (
      <div className="page">
        <BoardStatus label="Event unavailable" detail={event.error.message} />
      </div>
    );

  return (
    <div className="page event-page">
      <Link className="arrow-link" to="/">
        ← All events
      </Link>
      <div className="event-title-block">
        <div className="eyebrow">Working event</div>
        <h1>{event.data.name}</h1>
        <div className="event-meta">
          <span>{formatDateRange(event.data.startsOn, event.data.endsOn)}</span>
          <span>{event.data.timezone}</span>
          <span>Private</span>
        </div>
      </div>
      <section className="agenda-board">
        <div>
          <div className="eyebrow">Working agenda</div>
          <h2>Build a conflict-free program.</h2>
          <p>
            Place accepted program items and service blocks. Working conflicts
            stay visible until you correct and publish them.
          </p>
        </div>
        {event.data.access !== "reviewer" && (
          <Link
            className="primary-button link-button"
            to={`/events/${slug}/agenda`}
          >
            Open working agenda
          </Link>
        )}
      </section>
      {event.data.access === "owner" && (
        <EventTeamPanel slug={event.data.slug} />
      )}
      {event.data.access !== "reviewer" && (
        <section className="setup-callout">
          <div>
            <div className="eyebrow">Call for proposals</div>
            <h2>Shape what speakers send you.</h2>
            <p>
              Configure tracks, rooms, formats, and conditional proposal fields
              before you open the public form.
            </p>
          </div>
          <Link
            className="primary-button link-button"
            to={`/events/${slug}/cfp/setup`}
          >
            Configure CFP
          </Link>
        </section>
      )}
      <section className="setup-callout review-callout">
        <div>
          <div className="eyebrow">Review and decisions</div>
          <h2>
            {event.data.access === "reviewer"
              ? "Score your assigned proposals."
              : "Move proposals into the program."}
          </h2>
          <p>
            {event.data.access === "reviewer"
              ? "Your assignments stay blinded and editable while the round is open."
              : "Assign reviewers, watch progress, queue outcomes, and publish them together."}
          </p>
        </div>
        <Link
          className="primary-button link-button"
          to={`/events/${slug}/review`}
        >
          Open review board
        </Link>
      </section>
      {event.data.access !== "reviewer" && (
        <section className="setup-callout onboarding-callout">
          <div>
            <div className="eyebrow">Speaker readiness</div>
            <h2>Turn accepted work into a ready program.</h2>
            <p>
              Assign onboarding requirements, review evidence, and see every
              current blocker without maintaining a separate status field.
            </p>
          </div>
          <Link
            className="primary-button link-button"
            to={`/events/${slug}/onboarding`}
          >
            Open readiness
          </Link>
        </section>
      )}
    </div>
  );
}

function OrganizerOnboardingPage() {
  const { slug = "" } = useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const board = useQuery(
    trpc.onboarding.organizerBoard.queryOptions(
      { slug },
      { refetchInterval: ONBOARDING_REFETCH_INTERVAL_MS },
    ),
  );
  const refresh = () =>
    queryClient.invalidateQueries(
      trpc.onboarding.organizerBoard.queryFilter({ slug }),
    );
  const createDefinition = useMutation(
    trpc.onboarding.createDefinition.mutationOptions({ onSuccess: refresh }),
  );
  const createAssignment = useMutation(
    trpc.onboarding.createAssignment.mutationOptions({ onSuccess: refresh }),
  );
  const waive = useMutation(
    trpc.onboarding.waive.mutationOptions({ onSuccess: refresh }),
  );
  const override = useMutation(
    trpc.onboarding.override.mutationOptions({ onSuccess: refresh }),
  );
  const reopen = useMutation(
    trpc.onboarding.reopen.mutationOptions({ onSuccess: refresh }),
  );
  const recordReminder = useMutation(
    trpc.onboarding.recordReminder.mutationOptions({ onSuccess: refresh }),
  );
  const cancelAssignment = useMutation(
    trpc.onboarding.cancelAssignment.mutationOptions({ onSuccess: refresh }),
  );
  const rejectEvidence = useMutation(
    trpc.onboarding.rejectEvidence.mutationOptions({ onSuccess: refresh }),
  );
  const [definition, setDefinition] = useState({
    name: "",
    scope: "event_speaker" as
      "event_speaker" | "program_item" | "program_item_speaker",
    completionMechanism: "manual" as "manual" | "profile" | "form" | "file",
    profileRequirement: "complete" as "complete" | "bio" | "headshot",
    formLabel: "Response",
  });
  const [assignment, setAssignment] = useState({
    taskDefinitionId: "",
    target: "",
    required: true,
    dueAt: "",
  });

  if (board.isPending)
    return <FullPageStatus label="Opening speaker readiness" />;
  if (board.isError) {
    return (
      <div className="page">
        <BoardStatus
          label="Speaker readiness unavailable"
          detail={board.error.message}
        />
      </div>
    );
  }

  const selectedDefinition = board.data.definitions.find(
    (candidate) => candidate.id === assignment.taskDefinitionId,
  );
  const targetOptions = selectedDefinition
    ? onboardingTargetOptions(board.data.targets, selectedDefinition.scope)
    : [];
  const mutationError =
    createDefinition.error ??
    createAssignment.error ??
    waive.error ??
    override.error ??
    reopen.error ??
    recordReminder.error ??
    cancelAssignment.error ??
    rejectEvidence.error;

  function addDefinition(event: FormEvent) {
    event.preventDefault();
    createDefinition.mutate({
      slug,
      name: definition.name,
      scope: definition.scope,
      completionMechanism: definition.completionMechanism,
      profileRequirement:
        definition.completionMechanism === "profile"
          ? definition.profileRequirement
          : null,
      formFields:
        definition.completionMechanism === "form"
          ? [
              {
                key: "response",
                label: definition.formLabel,
                type: "long_text",
                required: true,
              },
            ]
          : null,
    });
  }

  function addAssignment(event: FormEvent) {
    event.preventDefault();
    if (!selectedDefinition || !assignment.target) return;
    const [scope, id] = assignment.target.split(":", 2);
    if (!id) return;
    const target =
      scope === "event_speaker"
        ? ({ scope, userId: id } as const)
        : scope === "program_item"
          ? ({ scope, programItemId: id } as const)
          : ({
              scope: "program_item_speaker",
              submissionSpeakerId: id,
            } as const);
    createAssignment.mutate({
      slug,
      taskDefinitionId: selectedDefinition.id,
      target,
      required: assignment.required,
      dueAt: assignment.dueAt ? new Date(assignment.dueAt).toISOString() : null,
    });
  }

  function reasonFor(action: string): string | undefined {
    const reason = window.prompt(`Reason to ${action}`)?.trim();
    return reason || undefined;
  }

  return (
    <div className="page onboarding-page">
      <Link className="arrow-link" to={`/events/${slug}`}>
        ← Back to event
      </Link>
      <section className="review-heading">
        <div>
          <div className="eyebrow">Speaker readiness</div>
          <h1>Act on what is blocking the program.</h1>
          <p>Completion comes from current evidence, not a status checkbox.</p>
        </div>
      </section>
      {mutationError && (
        <p className="form-error" role="alert">
          {mutationError.message}
        </p>
      )}
      <div className="onboarding-builders">
        <form className="form-board" onSubmit={addDefinition}>
          <div className="eyebrow">New task definition</div>
          <h2>Define the onboarding task</h2>
          <Field label="Name" name="task-name">
            <input
              id="task-name"
              onChange={(event) =>
                setDefinition((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              required
              value={definition.name}
            />
          </Field>
          <div className="field-pair">
            <Field label="Scope" name="task-scope">
              <select
                id="task-scope"
                onChange={(event) =>
                  setDefinition((current) => ({
                    ...current,
                    scope: event.target.value as typeof current.scope,
                    completionMechanism:
                      event.target.value !== "event_speaker" &&
                      current.completionMechanism === "profile"
                        ? "manual"
                        : current.completionMechanism,
                  }))
                }
                value={definition.scope}
              >
                <option value="event_speaker">Event-speaker task</option>
                <option value="program_item">Program-item task</option>
                <option value="program_item_speaker">
                  Program-item-speaker task
                </option>
              </select>
            </Field>
            <Field label="Completion" name="task-mechanism">
              <select
                id="task-mechanism"
                onChange={(event) =>
                  setDefinition((current) => ({
                    ...current,
                    completionMechanism: event.target
                      .value as typeof current.completionMechanism,
                    scope:
                      event.target.value === "profile"
                        ? "event_speaker"
                        : current.scope,
                  }))
                }
                value={definition.completionMechanism}
              >
                <option value="manual">Manual confirmation</option>
                <option value="profile">Speaker profile</option>
                <option value="form">Form response</option>
                <option value="file">File upload</option>
              </select>
            </Field>
          </div>
          {definition.completionMechanism === "profile" && (
            <Field label="Profile requirement" name="profile-requirement">
              <select
                id="profile-requirement"
                onChange={(event) =>
                  setDefinition((current) => ({
                    ...current,
                    profileRequirement: event.target
                      .value as typeof current.profileRequirement,
                  }))
                }
                value={definition.profileRequirement}
              >
                <option value="complete">Name and bio</option>
                <option value="bio">Bio</option>
                <option value="headshot">Headshot</option>
              </select>
            </Field>
          )}
          {definition.completionMechanism === "form" && (
            <Field label="Required question" name="form-label">
              <input
                id="form-label"
                onChange={(event) =>
                  setDefinition((current) => ({
                    ...current,
                    formLabel: event.target.value,
                  }))
                }
                required
                value={definition.formLabel}
              />
            </Field>
          )}
          <button
            className="primary-button"
            disabled={createDefinition.isPending}
            type="submit"
          >
            Create task definition
          </button>
        </form>
        <form className="form-board" onSubmit={addAssignment}>
          <div className="eyebrow">New assignment</div>
          <h2>Target accepted work</h2>
          <Field label="Task definition" name="assignment-definition">
            <select
              id="assignment-definition"
              onChange={(event) =>
                setAssignment((current) => ({
                  ...current,
                  taskDefinitionId: event.target.value,
                  target: "",
                }))
              }
              required
              value={assignment.taskDefinitionId}
            >
              <option value="">Choose requirement</option>
              {board.data.definitions.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Target" name="assignment-target">
            <select
              disabled={!selectedDefinition}
              id="assignment-target"
              onChange={(event) =>
                setAssignment((current) => ({
                  ...current,
                  target: event.target.value,
                }))
              }
              required
              value={assignment.target}
            >
              <option value="">Choose target</option>
              {targetOptions.map((target) => (
                <option key={target.value} value={target.value}>
                  {target.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due date and time" name="assignment-due">
            <input
              id="assignment-due"
              onChange={(event) =>
                setAssignment((current) => ({
                  ...current,
                  dueAt: event.target.value,
                }))
              }
              type="datetime-local"
              value={assignment.dueAt}
            />
          </Field>
          <label className="publication-selection">
            <input
              checked={assignment.required}
              onChange={(event) =>
                setAssignment((current) => ({
                  ...current,
                  required: event.target.checked,
                }))
              }
              type="checkbox"
            />
            Required for readiness
          </label>
          <button
            className="primary-button"
            disabled={createAssignment.isPending}
            type="submit"
          >
            Create assignment
          </button>
        </form>
      </div>
      <section className="readiness-section">
        <div className="eyebrow">Fixed readiness view</div>
        <h2>Program items</h2>
        <div className="readiness-table" role="table">
          {board.data.readiness.programItems.map((item) => (
            <div className="readiness-row" key={item.id} role="row">
              <strong>{item.title}</strong>
              <span
                className={`status-chip ${item.ready ? "status-open" : "status-closed"}`}
              >
                {item.ready ? "Ready" : "Blocked"}
              </span>
              <span>
                {item.blockers
                  .map((blocker) => blocker.requirement)
                  .join(", ") || "No blockers"}
              </span>
              <span>
                {item.nextDueAt
                  ? new Date(item.nextDueAt).toLocaleString()
                  : "No due date"}
              </span>
            </div>
          ))}
        </div>
        <h2>Speakers</h2>
        <div className="readiness-table" role="table">
          {board.data.readiness.speakers.map((speaker) => (
            <div className="readiness-row" key={speaker.key} role="row">
              <strong>{speaker.name}</strong>
              <span
                className={`status-chip ${speaker.ready ? "status-open" : "status-closed"}`}
              >
                {speaker.ready ? "Ready" : "Blocked"}
              </span>
              <span>
                {speaker.blockers
                  .map((blocker) => blocker.requirement)
                  .join(", ") || "No blockers"}
              </span>
              <span>
                {speaker.nextDueAt
                  ? new Date(speaker.nextDueAt).toLocaleString()
                  : "No due date"}
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="assignment-cards">
        {board.data.assignments.map((item) => (
          <article className="task-card" key={item.id}>
            <div>
              <div className="eyebrow">Revision {item.completionRevision}</div>
              <h3>{item.name}</h3>
              <p>
                {item.required ? "Required" : "Optional"} ·{" "}
                {item.completionMechanism}
              </p>
              {item.lastReminderAt && (
                <p>
                  Last reminder recorded{" "}
                  {new Date(item.lastReminderAt).toLocaleString()}
                </p>
              )}
            </div>
            <span
              className={`status-chip ${item.completed ? "status-open" : "status-closed"}`}
            >
              {item.completed ? "Complete" : "Incomplete"}
            </span>
            <div className="task-actions">
              <button
                className="text-button"
                onClick={() => recordReminder.mutate({ assignmentId: item.id })}
                type="button"
              >
                Record reminder
              </button>
              <button
                className="text-button"
                onClick={() => {
                  const reason = reasonFor("reopen this assignment");
                  if (reason) reopen.mutate({ assignmentId: item.id, reason });
                }}
                type="button"
              >
                Reopen
              </button>
              <button
                className="text-button"
                onClick={() => {
                  const reason = reasonFor("waive this assignment");
                  if (reason) waive.mutate({ assignmentId: item.id, reason });
                }}
                type="button"
              >
                Waive
              </button>
              <button
                className="text-button"
                onClick={() => {
                  const reason = reasonFor("override this assignment");
                  if (reason)
                    override.mutate({ assignmentId: item.id, reason });
                }}
                type="button"
              >
                Organizer override
              </button>
              <button
                className="text-button"
                onClick={() => {
                  if (window.confirm("Cancel this assignment?")) {
                    cancelAssignment.mutate({ assignmentId: item.id });
                  }
                }}
                type="button"
              >
                Cancel assignment
              </button>
            </div>
            {item.evidence.map((evidence) => (
              <div className="evidence-row" key={evidence.id}>
                <span>
                  {evidence.kind}
                  {evidence.fileName && evidence.fileId ? (
                    <>
                      {" · "}
                      <a href={`/api/task-files/${evidence.fileId}`}>
                        {evidence.fileName}
                      </a>
                    </>
                  ) : null}
                </span>
                <span>
                  {evidence.rejectedReason
                    ? `Rejected: ${evidence.rejectedReason}`
                    : evidence.supersededBy
                      ? "Superseded"
                      : "Current history"}
                </span>
                {!evidence.rejectedReason && !evidence.supersededBy && (
                  <button
                    className="text-button"
                    onClick={() => {
                      const reason = reasonFor("reject this evidence");
                      if (reason)
                        rejectEvidence.mutate({
                          evidenceId: evidence.id,
                          reason,
                        });
                    }}
                    type="button"
                  >
                    Reject
                  </button>
                )}
              </div>
            ))}
          </article>
        ))}
      </section>
    </div>
  );
}

function onboardingTargetOptions(
  targets: {
    speakers: Array<{ userId: string; name: string }>;
    programItems: Array<{
      id: string;
      title: string;
      speakers: Array<{ id: string; name: string }>;
    }>;
  },
  scope: "event_speaker" | "program_item" | "program_item_speaker",
) {
  if (scope === "event_speaker") {
    return targets.speakers.map((speaker) => ({
      value: `event_speaker:${speaker.userId}`,
      label: speaker.name,
    }));
  }
  if (scope === "program_item") {
    return targets.programItems.map((item) => ({
      value: `program_item:${item.id}`,
      label: item.title,
    }));
  }
  return targets.programItems.flatMap((item) =>
    item.speakers.map((speaker) => ({
      value: `program_item_speaker:${speaker.id}`,
      label: `${item.title} · ${speaker.name}`,
    })),
  );
}

function SpeakerTasksPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const tasks = useQuery(
    trpc.onboarding.mine.queryOptions(undefined, {
      refetchInterval: ONBOARDING_REFETCH_INTERVAL_MS,
    }),
  );
  const refresh = () =>
    queryClient.invalidateQueries(trpc.onboarding.mine.queryFilter());
  const confirm = useMutation(
    trpc.onboarding.confirmManual.mutationOptions({ onSuccess: refresh }),
  );
  const saveDraft = useMutation(
    trpc.onboarding.saveFormDraft.mutationOptions(),
  );
  const submitForm = useMutation(
    trpc.onboarding.submitForm.mutationOptions({ onSuccess: refresh }),
  );
  const upload = useMutation(
    trpc.onboarding.uploadFile.mutationOptions({ onSuccess: refresh }),
  );
  const [answers, setAnswers] = useState<
    Record<string, Record<string, string>>
  >({});

  if (tasks.isPending) return <FullPageStatus label="Opening your tasks" />;
  if (tasks.isError) {
    return (
      <div className="page">
        <BoardStatus label="Tasks unavailable" detail={tasks.error.message} />
      </div>
    );
  }

  async function submitAnswers(
    event: FormEvent,
    assignmentId: string,
    savedAnswers: Record<string, string> | undefined,
  ) {
    event.preventDefault();
    await saveDraft.mutateAsync({
      assignmentId,
      answers: answers[assignmentId] ?? savedAnswers ?? {},
    });
    await submitForm.mutateAsync({ assignmentId });
  }

  async function uploadFile(assignmentId: string, file: File | undefined) {
    if (!file) return;
    upload.mutate({
      assignmentId,
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      contentBase64: await browserFileToBase64(file),
    });
  }

  return (
    <div className="page onboarding-page">
      <Link className="arrow-link" to="/">
        ← Back to board
      </Link>
      <section className="review-heading">
        <div>
          <div className="eyebrow">Your onboarding</div>
          <h1>Clear the next program blocker.</h1>
          <p>
            Submitted evidence stays in the history if an organizer asks for a
            replacement.
          </p>
        </div>
      </section>
      {tasks.data.length === 0 && (
        <BoardStatus
          label="No onboarding tasks"
          detail="Accepted program work and assigned requirements will appear here."
        />
      )}
      <section className="assignment-cards">
        {tasks.data.map((task) => {
          const fields = task.formFields ?? [];
          return (
            <article className="task-card" key={task.id}>
              <div>
                <div className="eyebrow">
                  {task.required ? "Required" : "Optional"} · Revision{" "}
                  {task.completionRevision}
                </div>
                <h2>{task.name}</h2>
                <p>
                  {task.dueAt
                    ? `Due ${new Date(task.dueAt).toLocaleString()}`
                    : "No due date"}
                </p>
              </div>
              <span
                className={`status-chip ${task.completed ? "status-open" : "status-closed"}`}
              >
                {task.completed ? "Complete" : "Incomplete"}
              </span>
              {task.completionMechanism === "profile" && !task.completed && (
                <Link
                  className="primary-button link-button"
                  to="/speaker-profile"
                >
                  Complete profile
                </Link>
              )}
              {task.completionMechanism === "manual" && !task.completed && (
                <button
                  className="primary-button"
                  disabled={confirm.isPending}
                  onClick={() => confirm.mutate({ assignmentId: task.id })}
                  type="button"
                >
                  Confirm complete
                </button>
              )}
              {task.completionMechanism === "file" && (
                <Field label="Upload current file" name={`file-${task.id}`}>
                  <input
                    id={`file-${task.id}`}
                    onChange={(event) =>
                      void uploadFile(task.id, event.target.files?.[0])
                    }
                    type="file"
                  />
                </Field>
              )}
              {task.completionMechanism === "form" && !task.completed && (
                <form
                  onSubmit={(event) =>
                    void submitAnswers(event, task.id, task.draft?.answers)
                  }
                >
                  {fields.map((field) => (
                    <Field
                      key={field.key}
                      label={field.label}
                      name={`${task.id}-${field.key}`}
                    >
                      {field.type === "long_text" ? (
                        <textarea
                          id={`${task.id}-${field.key}`}
                          onChange={(event) =>
                            setAnswers((current) => ({
                              ...current,
                              [task.id]: {
                                ...(current[task.id] ??
                                  task.draft?.answers ??
                                  {}),
                                [field.key]: event.target.value,
                              },
                            }))
                          }
                          required={field.required}
                          value={
                            answers[task.id]?.[field.key] ??
                            task.draft?.answers[field.key] ??
                            ""
                          }
                        />
                      ) : (
                        <input
                          id={`${task.id}-${field.key}`}
                          onChange={(event) =>
                            setAnswers((current) => ({
                              ...current,
                              [task.id]: {
                                ...(current[task.id] ??
                                  task.draft?.answers ??
                                  {}),
                                [field.key]: event.target.value,
                              },
                            }))
                          }
                          required={field.required}
                          value={
                            answers[task.id]?.[field.key] ??
                            task.draft?.answers[field.key] ??
                            ""
                          }
                        />
                      )}
                    </Field>
                  ))}
                  <button
                    className="primary-button"
                    disabled={saveDraft.isPending || submitForm.isPending}
                    type="submit"
                  >
                    Submit response
                  </button>
                </form>
              )}
              {task.evidence.length > 0 && (
                <div className="evidence-history">
                  <div className="eyebrow">Evidence history</div>
                  {task.evidence.map((evidence) => (
                    <p key={evidence.id}>
                      {evidence.kind}
                      {evidence.fileName && evidence.fileId ? (
                        <>
                          {" · "}
                          <a href={`/api/task-files/${evidence.fileId}`}>
                            {evidence.fileName}
                          </a>
                        </>
                      ) : null}
                      {evidence.rejectedReason
                        ? ` · Rejected: ${evidence.rejectedReason}`
                        : evidence.supersededBy
                          ? " · Superseded"
                          : ""}
                    </p>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}

async function browserFileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (
    let offset = 0;
    offset < bytes.length;
    offset += FILE_ENCODING_CHUNK_BYTES
  ) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + FILE_ENCODING_CHUNK_BYTES),
    );
  }
  return btoa(binary);
}

function ReviewPage() {
  const { slug = "" } = useParams();
  const trpc = useTRPC();
  const event = useQuery(trpc.events.get.queryOptions({ slug }));

  if (event.isPending) return <FullPageStatus label="Opening review board" />;
  if (event.isError) {
    return (
      <div className="page">
        <BoardStatus
          label="Review board unavailable"
          detail={event.error.message}
        />
      </div>
    );
  }

  return event.data.access === "reviewer" ? (
    <ReviewerAssignments slug={slug} />
  ) : (
    <OrganizerReviewBoard slug={slug} />
  );
}

function OrganizerReviewBoard({ slug }: { slug: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const board = useQuery(trpc.reviews.organizerBoard.queryOptions({ slug }));
  const refresh = () =>
    queryClient.invalidateQueries(
      trpc.reviews.organizerBoard.queryFilter({ slug }),
    );
  const openRound = useMutation(
    trpc.reviews.openRound.mutationOptions({ onSuccess: refresh }),
  );
  const closeRound = useMutation(
    trpc.reviews.closeRound.mutationOptions({ onSuccess: refresh }),
  );
  const reopenRound = useMutation(
    trpc.reviews.reopenRound.mutationOptions({ onSuccess: refresh }),
  );
  const assign = useMutation(
    trpc.reviews.assign.mutationOptions({ onSuccess: refresh }),
  );
  const revoke = useMutation(
    trpc.reviews.revokeAssignment.mutationOptions({ onSuccess: refresh }),
  );
  const queue = useMutation(
    trpc.decisions.queue.mutationOptions({ onSuccess: refresh }),
  );
  const [selectedForPublication, setSelectedForPublication] = useState<
    Record<string, boolean>
  >({});
  const publish = useMutation(
    trpc.decisions.publish.mutationOptions({
      onSuccess: async () => {
        setSelectedForPublication({});
        await refresh();
      },
    }),
  );
  const [reviewerBySubmission, setReviewerBySubmission] = useState<
    Record<string, string>
  >({});

  if (board.isPending) return <FullPageStatus label="Opening review board" />;
  if (board.isError) {
    return (
      <div className="page">
        <BoardStatus
          label="Review board unavailable"
          detail={board.error.message}
        />
      </div>
    );
  }

  const queued = board.data.submissions.filter(
    (submission) =>
      submission.decision.status === "accept_queued" ||
      submission.decision.status === "decline_queued",
  );
  const selectedQueued = queued.filter(
    (submission) => selectedForPublication[submission.id],
  );
  const hasMissingReviews = board.data.submissions.some(
    (submission) =>
      submission.status === "active" &&
      submission.review.completed < submission.review.assigned,
  );
  const mutationError =
    openRound.error ??
    closeRound.error ??
    reopenRound.error ??
    assign.error ??
    revoke.error ??
    queue.error ??
    publish.error;

  function closeWithConfirmation() {
    if (!hasMissingReviews) {
      closeRound.mutate({ slug, allowMissingReviews: false });
      return;
    }
    if (!window.confirm("Some assignments have no review. Close anyway?"))
      return;
    closeRound.mutate({ slug, allowMissingReviews: true });
  }

  return (
    <div className="page review-page">
      <Link className="arrow-link" to={`/events/${slug}`}>
        ← Back to event
      </Link>
      <section className="review-heading">
        <div>
          <div className="eyebrow">Review round</div>
          <h1>{board.data.round.name}</h1>
          <p>
            {board.data.submissions.length}{" "}
            {pluralize(board.data.submissions.length, "proposal")} ·{" "}
            {queued.length} queued {pluralize(queued.length, "outcome")}
          </p>
        </div>
        <div className="round-control">
          <span className={`status-chip status-${board.data.round.status}`}>
            {board.data.round.status}
          </span>
          {board.data.round.status === "draft" && (
            <button
              className="primary-button"
              disabled={openRound.isPending}
              onClick={() => openRound.mutate({ slug })}
              type="button"
            >
              Open reviewing
            </button>
          )}
          {board.data.round.status === "open" && (
            <button
              className="primary-button"
              disabled={closeRound.isPending}
              onClick={closeWithConfirmation}
              type="button"
            >
              Close reviewing
            </button>
          )}
          {board.data.round.status === "closed" && (
            <button
              className="text-button"
              disabled={reopenRound.isPending}
              onClick={() => reopenRound.mutate({ slug })}
              type="button"
            >
              Reopen round
            </button>
          )}
        </div>
      </section>
      {mutationError && (
        <p className="form-error" role="alert">
          {mutationError.message}
        </p>
      )}
      {board.data.submissions.length === 0 && (
        <BoardStatus
          label="No proposals to review"
          detail="Open the CFP and wait for the first final submission."
        />
      )}
      <div className="review-list">
        {board.data.submissions.map((submission) => {
          const hasPublishedDecision =
            submission.decision.status === "accepted" ||
            submission.decision.status === "declined";
          return (
            <article className="review-proposal" key={submission.id}>
              <div className="review-proposal-copy">
                <div className="eyebrow">
                  {submission.track} · {submission.format}
                </div>
                <h2>{submission.title}</h2>
                <p>{submission.abstract}</p>
                <div className="review-metrics">
                  <span>
                    {submission.review.completed}/{submission.review.assigned}{" "}
                    reviewed
                  </span>
                  <span>
                    Average {submission.review.average?.toFixed(1) ?? "—"}
                  </span>
                  <span>{submission.status}</span>
                </div>
              </div>
              <div className="review-controls">
                <Field
                  label="Internal outcome"
                  name={`decision-${submission.id}`}
                >
                  <select
                    disabled={
                      hasPublishedDecision || submission.status === "withdrawn"
                    }
                    id={`decision-${submission.id}`}
                    onChange={(event) =>
                      queue.mutate({
                        slug,
                        submissionId: submission.id,
                        status: event.target.value as
                          "pending" | "accept_queued" | "decline_queued",
                      })
                    }
                    value={submission.decision.status}
                  >
                    <option value="pending">Pending</option>
                    <option value="accept_queued">Queue acceptance</option>
                    <option value="decline_queued">Queue decline</option>
                    {hasPublishedDecision && (
                      <option value={submission.decision.status}>
                        {submission.decision.status}
                      </option>
                    )}
                  </select>
                </Field>
                {board.data.round.status === "closed" &&
                  submission.decision.status.endsWith("_queued") && (
                    <label className="publication-selection">
                      <input
                        checked={Boolean(selectedForPublication[submission.id])}
                        onChange={(event) =>
                          setSelectedForPublication((current) => ({
                            ...current,
                            [submission.id]: event.target.checked,
                          }))
                        }
                        type="checkbox"
                      />
                      Include in this publication
                    </label>
                  )}
                {!hasPublishedDecision &&
                  submission.status === "active" &&
                  board.data.round.status !== "closed" && (
                    <div className="assignment-control">
                      <select
                        aria-label={`Reviewer for ${submission.title}`}
                        onChange={(event) =>
                          setReviewerBySubmission((current) => ({
                            ...current,
                            [submission.id]: event.target.value,
                          }))
                        }
                        value={reviewerBySubmission[submission.id] ?? ""}
                      >
                        <option value="">Choose reviewer</option>
                        {board.data.reviewers.map((reviewer) => (
                          <option key={reviewer.id} value={reviewer.id}>
                            {reviewer.name
                              ? `${reviewer.name} · ${reviewer.email}`
                              : reviewer.email}
                          </option>
                        ))}
                      </select>
                      <button
                        className="mini-button"
                        disabled={
                          !reviewerBySubmission[submission.id] ||
                          assign.isPending
                        }
                        onClick={() => {
                          const reviewerUserId =
                            reviewerBySubmission[submission.id];
                          if (!reviewerUserId) return;
                          assign.mutate({
                            slug,
                            submissionId: submission.id,
                            reviewerUserId,
                          });
                        }}
                        type="button"
                      >
                        Assign
                      </button>
                    </div>
                  )}
                <div className="assignment-list">
                  {submission.review.assignments.map((assignment) => (
                    <div className="assignment-row" key={assignment.id}>
                      <span>
                        {assignment.reviewerName || assignment.reviewerEmail} ·{" "}
                        {assignment.score ?? "not scored"}
                      </span>
                      {board.data.round.status !== "closed" && (
                        <button
                          className="text-button"
                          disabled={revoke.isPending}
                          onClick={() =>
                            revoke.mutate({
                              slug,
                              assignmentId: assignment.id,
                            })
                          }
                          type="button"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {board.data.round.status === "closed" && queued.length > 0 && (
        <section className="publication-bar">
          <div>
            <div className="eyebrow">Atomic publication</div>
            <strong>
              Publish {selectedQueued.length} selected{" "}
              {pluralize(selectedQueued.length, "outcome")}
              {selectedQueued.length > 1 ? " together" : ""}
            </strong>
          </div>
          <button
            className="primary-button"
            disabled={publish.isPending || selectedQueued.length === 0}
            onClick={() =>
              publish.mutate({
                slug,
                selections: selectedQueued.map((submission) => ({
                  submissionId: submission.id,
                  expectedStatus: submission.decision.status as
                    "accept_queued" | "decline_queued",
                  expectedRevision: submission.decision.revision,
                })),
              })
            }
            type="button"
          >
            {publish.isPending ? "Publishing…" : "Publish decisions"}
          </button>
        </section>
      )}
      <ReviewerAssignments compact slug={slug} />
    </div>
  );
}

function ReviewerAssignments({
  compact = false,
  slug,
}: {
  compact?: boolean;
  slug: string;
}) {
  const trpc = useTRPC();
  const assignments = useQuery(trpc.reviews.mine.queryOptions({ slug }));

  if (assignments.isPending) {
    return compact ? (
      <BoardStatus label="Loading your assignments" />
    ) : (
      <FullPageStatus label="Opening assignments" />
    );
  }
  if (assignments.isError) {
    return (
      <div className={compact ? "" : "page"}>
        <BoardStatus
          label="Assignments unavailable"
          detail={assignments.error.message}
        />
      </div>
    );
  }

  return (
    <section className={compact ? "own-review-section" : "page review-page"}>
      {!compact && (
        <Link className="arrow-link" to={`/events/${slug}`}>
          ← Back to event
        </Link>
      )}
      <div className="review-heading">
        <div>
          <div className="eyebrow">Your blinded assignments</div>
          <h1>{compact ? "Your reviews" : "Read the work, not the name."}</h1>
          <p>Scores remain editable while the review round is open.</p>
        </div>
      </div>
      {assignments.data.length === 0 && (
        <BoardStatus
          label="No active assignments"
          detail="Assigned proposals will appear here."
        />
      )}
      <div className="review-list">
        {assignments.data.map((assignment) => (
          <ReviewAssignmentCard
            assignment={assignment}
            key={assignment.assignmentId}
            slug={slug}
          />
        ))}
      </div>
    </section>
  );
}

function ReviewAssignmentCard({
  assignment,
  slug,
}: {
  assignment: {
    assignmentId: string;
    roundStatus: "draft" | "open" | "closed";
    submission: {
      id: string;
      title: string;
      abstract: string;
      format: string;
      track: string;
    };
    review: { score: number; comment: string | null } | null;
  };
  slug: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [score, setScore] = useState(assignment.review?.score ?? 3);
  const [comment, setComment] = useState(assignment.review?.comment ?? "");
  const save = useMutation(
    trpc.reviews.save.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries(trpc.reviews.mine.queryFilter({ slug })),
    }),
  );
  const editable = assignment.roundStatus === "open";

  return (
    <article className="review-proposal reviewer-card">
      <div className="review-proposal-copy">
        <div className="eyebrow">
          {assignment.submission.track} · {assignment.submission.format}
        </div>
        <h2>{assignment.submission.title}</h2>
        <p>{assignment.submission.abstract}</p>
      </div>
      <form
        className="review-controls"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate({
            assignmentId: assignment.assignmentId,
            score,
            comment: comment.trim() || null,
          });
        }}
      >
        <Field label="Score" name={`score-${assignment.assignmentId}`}>
          <select
            disabled={!editable}
            id={`score-${assignment.assignmentId}`}
            onChange={(event) => setScore(Number(event.target.value))}
            value={score}
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Private reviewer comment"
          name={`comment-${assignment.assignmentId}`}
        >
          <textarea
            disabled={!editable}
            id={`comment-${assignment.assignmentId}`}
            maxLength={5000}
            onChange={(event) => setComment(event.target.value)}
            value={comment}
          />
        </Field>
        {save.error && (
          <p className="form-error" role="alert">
            {save.error.message}
          </p>
        )}
        <button
          className="primary-button"
          disabled={!editable || save.isPending}
          type="submit"
        >
          {save.isPending
            ? "Saving…"
            : assignment.review
              ? "Update review"
              : "Save review"}
        </button>
      </form>
    </article>
  );
}

function EventTeamPanel({ slug }: { slug: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const team = useQuery(trpc.eventTeam.list.queryOptions({ slug }));
  const formRef = useRef<HTMLFormElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<EventRole>("organizer");
  const [replacement, setReplacement] = useState<{
    kind: "resend" | "correct";
    id: InvitationId;
    email: string;
    role: EventRole;
  }>();
  const [notice, setNotice] = useState<{
    tone: "success" | "warning" | "error";
    message: string;
    invitation?: {
      id: InvitationId;
      email: string;
      role: EventRole;
    };
  }>();
  useEffect(() => {
    if (!replacement) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    formRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
    });
    if (replacement.kind === "correct") emailRef.current?.focus();
  }, [replacement]);
  const invite = useMutation(
    trpc.eventTeam.invite.mutationOptions({
      onError: async () => {
        await queryClient.invalidateQueries(
          trpc.eventTeam.list.queryFilter({ slug }),
        );
      },
      onSuccess: async (result) => {
        await queryClient.invalidateQueries(
          trpc.eventTeam.list.queryFilter({ slug }),
        );
        if (result.outcome === "already_pending") {
          setReplacement(undefined);
          setNotice({
            tone: "warning",
            message: `${/^[aeiou]/i.test(result.role) ? "An" : "A"} ${result.role} invitation is already pending for ${result.email}. Nothing changed.`,
            invitation: {
              id: result.id,
              email: result.email,
              role: result.role,
            },
          });
          return;
        }
        if (result.outcome === "delivery_failed") {
          startReplacement("resend", result);
          setNotice({
            tone: "error",
            message:
              "The invitation was saved, but the email could not be sent. Send a replacement to retry.",
          });
          return;
        }

        setNotice({
          tone: "success",
          message: replacement
            ? "The old link was revoked and the replacement was sent."
            : "The invitation was sent.",
        });
        cancelReplacement();
      },
    }),
  );
  const revoke = useMutation(
    trpc.eventTeam.revokeRole.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(
          trpc.eventTeam.list.queryFilter({ slug }),
        );
        await queryClient.invalidateQueries(trpc.events.list.queryFilter());
      },
    }),
  );
  const revokeInvitation = useMutation(
    trpc.eventTeam.revokeInvitation.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(
          trpc.eventTeam.list.queryFilter({ slug }),
        );
      },
    }),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(undefined);
    invite.mutate({
      slug,
      email,
      role,
      ...(replacement ? { replacesInvitationId: replacement.id } : {}),
    });
  }

  function startReplacement(
    kind: "resend" | "correct",
    invitation: {
      id: string;
      email: string;
      role: EventRole;
    },
  ) {
    setNotice(undefined);
    setReplacement({
      kind,
      id: invitation.id as InvitationId,
      email: invitation.email,
      role: invitation.role,
    });
    setEmail(invitation.email);
    setRole(invitation.role);
  }

  function cancelReplacement() {
    setReplacement(undefined);
    setEmail("");
    setRole("organizer");
  }

  const pendingInvitations =
    team.data?.invitations
      .filter((invitation) => invitation.usable)
      .sort(
        (left, right) =>
          left.email.localeCompare(right.email) ||
          left.role.localeCompare(right.role),
      ) ?? [];
  const pastAttempts =
    team.data?.invitations.filter((invitation) => !invitation.usable) ?? [];

  function pastAttemptStatus(invitation: {
    status: "pending" | "accepted" | "declined" | "revoked";
  }) {
    return invitation.status === "pending" ? "expired" : invitation.status;
  }

  function replacementTitle() {
    return replacement?.kind === "correct"
      ? "Correct invitation address"
      : "Resend invitation link";
  }

  function replacementExplanation() {
    return replacement?.kind === "correct"
      ? "Sending this correction revokes the old link and sends a new link to the corrected address."
      : "Sending this replacement revokes the old link and sends a new link to the same address.";
  }

  function replacementButtonLabel() {
    if (invite.isPending) return "Sending…";
    if (replacement?.kind === "correct") {
      return "Revoke old link and send correction";
    }
    if (replacement?.kind === "resend") {
      return "Revoke old link and resend";
    }
    return "Send invitation";
  }

  return (
    <section className="team-board">
      <div className="team-heading">
        <div>
          <div className="eyebrow">Event team</div>
          <h2>Invite the people who move the program.</h2>
          <p>
            Organizer and reviewer access stays additive. You can remove either
            role without removing the person or their history.
          </p>
        </div>
        <form
          className={`invite-form${replacement ? " invite-form-replacement" : ""}`}
          onSubmit={submit}
          ref={formRef}
        >
          {replacement && (
            <div className="replacement-banner" aria-live="polite">
              <div className="eyebrow">Replacement mode</div>
              <strong>{replacementTitle()}</strong>
              <p>{replacementExplanation()}</p>
            </div>
          )}
          <div className="field-pair">
            <Field label="Email address" name="team-email">
              <input
                id="team-email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="teammate@example.com"
                readOnly={replacement?.kind === "resend"}
                ref={emailRef}
                required
                type="email"
                value={email}
              />
            </Field>
            <Field label="Event role" name="team-role">
              <select
                id="team-role"
                disabled={Boolean(replacement)}
                onChange={(event) => setRole(event.target.value as EventRole)}
                value={role}
              >
                <option value="organizer">Organizer</option>
                <option value="reviewer">Reviewer</option>
              </select>
            </Field>
          </div>
          {(invite.error || revoke.error || revokeInvitation.error) && (
            <p className="form-error" role="alert">
              {invite.error?.message ??
                revoke.error?.message ??
                revokeInvitation.error?.message}
            </p>
          )}
          {notice && (
            <div
              aria-live="polite"
              className={`invite-notice invite-notice-${notice.tone}`}
            >
              <span>{notice.message}</span>
              {notice.invitation && (
                <button
                  className="text-button"
                  onClick={() => {
                    if (notice.invitation) {
                      startReplacement("resend", notice.invitation);
                    }
                  }}
                  type="button"
                >
                  Resend link
                </button>
              )}
            </div>
          )}
          <div className="team-actions">
            <button
              className="primary-button"
              disabled={invite.isPending}
              type="submit"
            >
              {replacementButtonLabel()}
            </button>
            {replacement && (
              <button
                className="text-button"
                onClick={cancelReplacement}
                type="button"
              >
                Cancel replacement
              </button>
            )}
          </div>
        </form>
      </div>

      {team.isPending && <BoardStatus label="Loading event team" />}
      {team.isError && (
        <BoardStatus
          label="Event team unavailable"
          detail={team.error.message}
        />
      )}
      {team.data && (
        <div className="team-columns">
          <div>
            <div className="eyebrow">Active access</div>
            <div className="team-list">
              <div className="team-row">
                <div>
                  <strong>{team.data.owner?.email}</strong>
                  <span>Event owner</span>
                </div>
              </div>
              {team.data.roles.map((member) => (
                <div className="team-row" key={member.id}>
                  <div>
                    <strong>{member.email}</strong>
                    <span>{member.role}</span>
                  </div>
                  <button
                    className="text-button"
                    disabled={revoke.isPending}
                    onClick={() =>
                      revoke.mutate({
                        slug,
                        roleId: member.id,
                      })
                    }
                    type="button"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="eyebrow">Pending invitations</div>
            <div className="team-list pending-invitations">
              {team.data.invitations.length === 0 && (
                <p className="muted">No invitations sent yet.</p>
              )}
              {team.data.invitations.length > 0 &&
                pendingInvitations.length === 0 && (
                  <p className="muted">No pending invitations.</p>
                )}
              {pendingInvitations.map((invitation) => (
                <div
                  className="team-row"
                  id={`invitation-${invitation.id}`}
                  key={invitation.id}
                >
                  <div>
                    <strong>{invitation.email}</strong>
                    <span>{invitation.role} · pending</span>
                  </div>
                  <div className="team-row-actions">
                    <button
                      className="text-button"
                      onClick={() => startReplacement("resend", invitation)}
                      type="button"
                    >
                      Resend link
                    </button>
                    <button
                      className="text-button"
                      onClick={() => startReplacement("correct", invitation)}
                      type="button"
                    >
                      Correct address
                    </button>
                    <button
                      className="text-button"
                      disabled={revokeInvitation.isPending}
                      onClick={() =>
                        revokeInvitation.mutate({
                          slug,
                          invitationId: invitation.id,
                        })
                      }
                      type="button"
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {pastAttempts.length > 0 && (
              <details className="past-attempts">
                <summary>Past attempts ({pastAttempts.length})</summary>
                <div className="team-list">
                  {pastAttempts.map((invitation) => (
                    <div className="team-row team-row-past" key={invitation.id}>
                      <div>
                        <strong>{invitation.email}</strong>
                        <span>
                          {invitation.role} · {pastAttemptStatus(invitation)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

type EventOption = { id: string; name: string; position: number };
const publicCfpSteps = ["Proposal", "Speakers", "Event questions"] as const;

function CfpSetupPage() {
  const { slug = "" } = useParams();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const event = useQuery(trpc.events.get.queryOptions({ slug }));
  const tracks = useQuery(trpc.tracks.list.queryOptions({ slug }));
  const rooms = useQuery(trpc.rooms.list.queryOptions({ slug }));
  const cfp = useQuery(trpc.cfps.getSetup.queryOptions({ slug }));

  const refreshTracks = () =>
    queryClient.invalidateQueries(trpc.tracks.list.queryFilter({ slug }));
  const refreshRooms = () =>
    queryClient.invalidateQueries(trpc.rooms.list.queryFilter({ slug }));
  const createTrack = useMutation(
    trpc.tracks.create.mutationOptions({ onSuccess: refreshTracks }),
  );
  const updateTrack = useMutation(
    trpc.tracks.update.mutationOptions({ onSuccess: refreshTracks }),
  );
  const archiveTrack = useMutation(
    trpc.tracks.archive.mutationOptions({ onSuccess: refreshTracks }),
  );
  const reorderTracks = useMutation(
    trpc.tracks.reorder.mutationOptions({ onSuccess: refreshTracks }),
  );
  const createRoom = useMutation(
    trpc.rooms.create.mutationOptions({ onSuccess: refreshRooms }),
  );
  const updateRoom = useMutation(
    trpc.rooms.update.mutationOptions({ onSuccess: refreshRooms }),
  );
  const archiveRoom = useMutation(
    trpc.rooms.archive.mutationOptions({ onSuccess: refreshRooms }),
  );
  const reorderRooms = useMutation(
    trpc.rooms.reorder.mutationOptions({ onSuccess: refreshRooms }),
  );

  if (event.isPending || tracks.isPending || rooms.isPending || cfp.isPending) {
    return <FullPageStatus label="Opening CFP setup" />;
  }
  const error = event.error ?? tracks.error ?? rooms.error ?? cfp.error;
  if (error) {
    return (
      <div className="page">
        <BoardStatus label="CFP setup unavailable" detail={error.message} />
      </div>
    );
  }
  if (!event.data || !tracks.data || !rooms.data || cfp.data === undefined) {
    return <FullPageStatus label="Opening CFP setup" />;
  }
  const structureLocked = Boolean(
    cfp.data.open?.structureLocked || cfp.data.draft?.structureLocked,
  );

  return (
    <div className="page setup-page">
      <Link className="arrow-link" to={`/events/${slug}`}>
        ← Back to event
      </Link>
      <section className="page-heading setup-heading">
        <div>
          <div className="eyebrow">Program intake</div>
          <h1>{event.data.name} CFP</h1>
        </div>
      </section>
      <div className="setup-grid">
        <OptionEditor
          creating={createTrack.isPending}
          disabled={structureLocked}
          title="Tracks"
          detail="Each submission has one track."
          error={
            createTrack.error ??
            updateTrack.error ??
            archiveTrack.error ??
            reorderTracks.error
          }
          items={tracks.data}
          onCreate={(name) => createTrack.mutateAsync({ slug, name })}
          onRename={(id, name) =>
            updateTrack.mutate({ slug, trackId: id, name })
          }
          onArchive={(id) => {
            if (window.confirm("Archive this track?")) {
              archiveTrack.mutate({ slug, trackId: id });
            }
          }}
          onReorder={(orderedIds) => reorderTracks.mutate({ slug, orderedIds })}
        />
        <OptionEditor
          creating={createRoom.isPending}
          disabled={false}
          title="Rooms"
          detail="Rooms are ready for later agenda placement."
          error={
            createRoom.error ??
            updateRoom.error ??
            archiveRoom.error ??
            reorderRooms.error
          }
          items={rooms.data}
          onCreate={(name) => createRoom.mutateAsync({ slug, name })}
          onRename={(id, name) => updateRoom.mutate({ slug, roomId: id, name })}
          onArchive={(id) => {
            if (window.confirm("Archive this room?")) {
              archiveRoom.mutate({ slug, roomId: id });
            }
          }}
          onReorder={(orderedIds) => reorderRooms.mutate({ slug, orderedIds })}
        />
      </div>
      {cfp.data.open && (
        <CfpBuilder
          cfp={cfp.data.open}
          key={cfp.data.open.id}
          endsOn={event.data.endsOn}
          slug={slug}
          timezone={event.data.timezone}
        />
      )}
      <CfpBuilder
        cfp={cfp.data.draft}
        key={cfp.data.draft?.id ?? "new"}
        endsOn={event.data.endsOn}
        slug={slug}
        timezone={event.data.timezone}
      />
    </div>
  );
}

function OptionEditor({
  creating,
  disabled,
  title,
  detail,
  items,
  error,
  onCreate,
  onRename,
  onArchive,
  onReorder,
}: {
  creating: boolean;
  disabled: boolean;
  title: string;
  detail: string;
  items: EventOption[];
  error: { message: string } | null;
  onCreate: (name: string) => Promise<unknown>;
  onRename: (id: string, name: string) => void;
  onArchive: (id: string) => void;
  onReorder: (ids: string[]) => void;
}) {
  const [name, setName] = useState("");
  const [validationError, setValidationError] = useState<string>();
  const singular = title.slice(0, -1).toLowerCase();

  async function create(event: FormEvent) {
    event.preventDefault();
    if (name.trim().length < 2) {
      setValidationError(`Enter at least 2 characters for the ${singular}.`);
      return;
    }
    setValidationError(undefined);
    try {
      await onCreate(name.trim());
      setName("");
    } catch {
      return;
    }
  }

  function move(index: number, offset: number) {
    const next = [...items];
    const target = index + offset;
    const currentItem = next[index];
    const targetItem = next[target];
    if (!currentItem || !targetItem) return;
    next[index] = targetItem;
    next[target] = currentItem;
    onReorder(next.map((item) => item.id));
  }

  return (
    <section className="option-board">
      <div className="eyebrow">{title}</div>
      <h2>{title}</h2>
      <p>{detail}</p>
      <div className="option-list">
        {items.length === 0 && (
          <p className="muted">No {title.toLowerCase()} yet.</p>
        )}
        {items.map((item, index) => (
          <form
            className="option-row"
            key={item.id}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const nextName = form.get("name");
              if (typeof nextName !== "string" || nextName.trim().length < 2) {
                setValidationError(
                  `Enter at least 2 characters for the ${singular}.`,
                );
                return;
              }
              setValidationError(undefined);
              onRename(item.id, nextName.trim());
            }}
          >
            <input
              defaultValue={item.name}
              disabled={disabled}
              name="name"
              aria-label={`${singular} name: ${item.name}`}
            />
            <button className="mini-button" disabled={disabled} type="submit">
              Save
            </button>
            <button
              className="mini-button"
              disabled={disabled || index === 0}
              aria-label={`Move ${item.name} up`}
              onClick={() => move(index, -1)}
              type="button"
            >
              Move up
            </button>
            <button
              className="mini-button"
              disabled={disabled || index === items.length - 1}
              aria-label={`Move ${item.name} down`}
              onClick={() => move(index, 1)}
              type="button"
            >
              Move down
            </button>
            <button
              className="mini-button danger-button"
              disabled={disabled}
              onClick={() => onArchive(item.id)}
              type="button"
            >
              Archive
            </button>
          </form>
        ))}
      </div>
      {(validationError || error) && (
        <p className="form-error" role="alert">
          {validationError ?? error?.message}
        </p>
      )}
      <form className="option-add" onSubmit={create}>
        <input
          aria-label={`New ${singular} name`}
          onChange={(event) => {
            setName(event.target.value);
            setValidationError(undefined);
          }}
          placeholder={`Add ${singular}`}
          disabled={disabled || creating}
          value={name}
        />
        <button
          className="mini-button"
          disabled={disabled || creating}
          type="submit"
        >
          {creating ? "Adding…" : "Add"}
        </button>
      </form>
    </section>
  );
}

function InvitationPage({
  email,
  signedIn,
}: {
  email?: string | undefined;
  signedIn: boolean;
}) {
  const { secret = "" } = useParams();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const invitation = useQuery(trpc.invitations.get.queryOptions({ secret }));
  const accept = useMutation(
    trpc.invitations.accept.mutationOptions({
      onSuccess: (result) => {
        void navigate(`/events/${result.eventSlug}`, { replace: true });
      },
    }),
  );
  const decline = useMutation(trpc.invitations.decline.mutationOptions());
  const acceptanceKey = `openboard:pending-invitation-acceptance:${secret}`;
  const acceptanceStarted = useRef(false);
  const acceptAfterSignIn =
    window.sessionStorage.getItem(acceptanceKey) === "true";
  const finishPendingAcceptance = useEffectEvent(() => {
    acceptanceStarted.current = true;
    window.sessionStorage.removeItem(acceptanceKey);
    accept.mutate({ secret });
  });

  useEffect(() => {
    if (
      acceptAfterSignIn &&
      signedIn &&
      invitation.data &&
      email === invitation.data.email &&
      accept.isIdle &&
      !acceptanceStarted.current
    ) {
      finishPendingAcceptance();
    }
  }, [accept.isIdle, acceptAfterSignIn, email, invitation.data, signedIn]);

  if (invitation.isPending) {
    return <FullPageStatus label="Opening invitation" />;
  }
  if (invitation.isError) {
    return (
      <main className="invitation-page">
        <section className="invitation-card">
          <div className="eyebrow">Invitation unavailable</div>
          <h1>This invitation can’t be used.</h1>
          <p>Check the link or ask the event owner for a new invitation.</p>
          <Link className="arrow-link" to="/">
            Open OpenBoard
          </Link>
        </section>
      </main>
    );
  }
  if (decline.isSuccess) {
    return (
      <main className="invitation-page">
        <section className="invitation-card">
          <div className="eyebrow">Invitation declined</div>
          <h1>No event access was added.</h1>
          <p>You don’t need an account, and this invitation can’t be reused.</p>
        </section>
      </main>
    );
  }

  const returnTo = `/invitations/${secret}`;
  const signInUrl = `/sign-in?returnTo=${encodeURIComponent(returnTo)}&email=${encodeURIComponent(invitation.data.email)}`;
  const emailMismatch = signedIn && email !== invitation.data.email;
  async function signInWithInvitedEmail() {
    await authClient.signOut();
    window.location.assign(signInUrl);
  }
  return (
    <main className="invitation-page">
      <section className="invitation-card">
        <div className="eyebrow">Event invitation</div>
        <h1>Join {invitation.data.eventName}.</h1>
        <p>
          You were invited with the <strong>{invitation.data.role}</strong> role
          through <strong>{invitation.data.email}</strong>.
        </p>
        {emailMismatch && (
          <div className="invite-notice invite-notice-warning" role="alert">
            <span>Use {invitation.data.email} to accept this invitation.</span>
            <button
              className="text-button"
              onClick={() => void signInWithInvitedEmail()}
              type="button"
            >
              Sign out and continue
            </button>
          </div>
        )}
        {(accept.error || decline.error) && (
          <p className="form-error" role="alert">
            {accept.error?.message ?? decline.error?.message}
          </p>
        )}
        <div className="invitation-actions">
          {signedIn ? (
            <button
              className="primary-button"
              disabled={accept.isPending || emailMismatch}
              onClick={() => accept.mutate({ secret })}
              type="button"
            >
              {accept.isPending ? "Accepting…" : "Accept invitation"}
            </button>
          ) : (
            <Link
              className="primary-button link-button"
              onClick={() =>
                window.sessionStorage.setItem(acceptanceKey, "true")
              }
              to={signInUrl}
            >
              Verify email and accept
            </Link>
          )}
          <button
            className="text-button"
            disabled={decline.isPending || emailMismatch}
            onClick={() => decline.mutate({ secret })}
            type="button"
          >
            {decline.isPending ? "Declining…" : "Decline invitation"}
          </button>
        </div>
      </section>
    </main>
  );
}

function SpeakerInvitationPage({
  email,
  signedIn,
}: {
  email?: string | undefined;
  signedIn: boolean;
}) {
  const { secret = "" } = useParams();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const invitation = useQuery(
    trpc.submissionSpeakerInvitations.get.queryOptions({ secret }),
  );
  const accept = useMutation(
    trpc.submissionSpeakerInvitations.accept.mutationOptions({
      onSuccess: (result) => {
        void navigate(`/submissions/${result.submissionId}`, { replace: true });
      },
    }),
  );
  const decline = useMutation(
    trpc.submissionSpeakerInvitations.decline.mutationOptions(),
  );

  if (invitation.isPending) {
    return <FullPageStatus label="Opening speaker invitation" />;
  }
  if (invitation.isError) {
    return (
      <main className="invitation-page">
        <section className="invitation-card">
          <div className="eyebrow">Invitation unavailable</div>
          <h1>This invitation can’t be used.</h1>
          <p>
            Check the link or ask the submission owner for a new invitation.
          </p>
          <Link className="arrow-link" to="/">
            Open OpenBoard
          </Link>
        </section>
      </main>
    );
  }
  if (decline.isSuccess) {
    return (
      <main className="invitation-page">
        <section className="invitation-card">
          <div className="eyebrow">Invitation declined</div>
          <h1>No proposal access was added.</h1>
          <p>This invitation can’t be reused.</p>
        </section>
      </main>
    );
  }

  const returnTo = `/speaker-invitations/${secret}`;
  const signInUrl = `/sign-in?returnTo=${encodeURIComponent(returnTo)}&email=${encodeURIComponent(invitation.data.email)}`;
  const emailMismatch = signedIn && email !== invitation.data.email;
  async function signInWithInvitedSpeakerEmail() {
    await authClient.signOut();
    window.location.assign(signInUrl);
  }
  return (
    <main className="invitation-page">
      <section className="invitation-card">
        <div className="eyebrow">Proposed-speaker invitation</div>
        <h1>Join {invitation.data.submissionTitle}.</h1>
        <p>
          <strong>{invitation.data.speakerName}</strong> was invited to speak at{" "}
          {invitation.data.eventName} through{" "}
          <strong>{invitation.data.email}</strong>.
        </p>
        {emailMismatch && (
          <div className="invite-notice invite-notice-warning" role="alert">
            <span>Use {invitation.data.email} to accept this invitation.</span>
            <button
              className="text-button"
              onClick={() => void signInWithInvitedSpeakerEmail()}
              type="button"
            >
              Sign out and continue
            </button>
          </div>
        )}
        {(accept.error || decline.error) && (
          <p className="form-error" role="alert">
            {accept.error?.message ?? decline.error?.message}
          </p>
        )}
        <div className="invitation-actions">
          {signedIn ? (
            <button
              className="primary-button"
              disabled={accept.isPending || emailMismatch}
              onClick={() => accept.mutate({ secret })}
              type="button"
            >
              {accept.isPending ? "Accepting…" : "Accept invitation"}
            </button>
          ) : (
            <Link className="primary-button link-button" to={signInUrl}>
              Verify email and accept
            </Link>
          )}
          <button
            className="text-button"
            disabled={decline.isPending || emailMismatch}
            onClick={() => decline.mutate({ secret })}
            type="button"
          >
            {decline.isPending ? "Declining…" : "Decline invitation"}
          </button>
        </div>
      </section>
    </main>
  );
}

function SpeakerProfilePage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const profileState = useQuery(trpc.speakerProfile.getOwn.queryOptions());
  const [draft, setDraft] = useState<SpeakerProfileInput>();
  const save = useMutation(
    trpc.speakerProfile.saveOwn.mutationOptions({
      onSuccess: async (saved) => {
        setDraft(saved);
        await queryClient.invalidateQueries(
          trpc.speakerProfile.getOwn.queryFilter(),
        );
      },
    }),
  );

  if (profileState.isPending)
    return <FullPageStatus label="Opening speaker profile" />;
  if (profileState.isError) {
    return (
      <div className="page">
        <BoardStatus
          label="Profile unavailable"
          detail={profileState.error.message}
        />
      </div>
    );
  }
  if (!profileState.data.eligible) {
    return (
      <div className="page">
        <BoardStatus
          label="Speaker profile unavailable"
          detail="Claim a proposed-speaker invitation before creating a profile."
        />
      </div>
    );
  }

  const current = draft ??
    profileState.data.profile ?? {
      displayName: profileState.data.suggestedDisplayName ?? "",
      bio: "",
      headshotUrl: null,
    };
  function updateProfile(values: Partial<SpeakerProfileInput>) {
    setDraft({ ...current, ...values });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate(current);
  }

  return (
    <div className="page setup-page">
      <Link className="arrow-link" to="/">
        ← My events
      </Link>
      <section className="page-heading compact-heading">
        <div className="eyebrow">Reusable speaker profile</div>
        <h1>
          {profileState.data.profile
            ? "Your public details"
            : "Create your profile"}
        </h1>
        <p>
          Your bio and headshot stay with you across events and accepted
          proposals.
        </p>
      </section>
      <section className="form-board submission-form">
        <form onSubmit={submit}>
          <fieldset className="submission-fields" disabled={save.isPending}>
            <Field label="Display name" name="speaker-profile-name">
              <input
                id="speaker-profile-name"
                required
                value={current.displayName}
                onChange={(event) =>
                  updateProfile({ displayName: event.target.value })
                }
              />
            </Field>
            <Field label="Bio" name="speaker-profile-bio">
              <textarea
                id="speaker-profile-bio"
                required
                value={current.bio}
                onChange={(event) => updateProfile({ bio: event.target.value })}
              />
            </Field>
            <Field label="Headshot URL" name="speaker-profile-headshot">
              <input
                id="speaker-profile-headshot"
                type="url"
                value={current.headshotUrl ?? ""}
                onChange={(event) =>
                  updateProfile({ headshotUrl: event.target.value || null })
                }
              />
            </Field>
          </fieldset>
          {save.error && (
            <p className="form-error" role="alert">
              {save.error.message}
            </p>
          )}
          <div className="submission-actions">
            <button
              className="primary-button"
              disabled={save.isPending}
              type="submit"
            >
              {save.isPending ? "Saving…" : "Save profile"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function CfpBuilder({
  cfp,
  endsOn,
  slug,
  timezone,
}: {
  cfp:
    | (CfpDefinitionInput & {
        id: string;
        status: "draft" | "open";
        structureLocked: boolean;
      })
    | null;
  endsOn: string;
  slug: string;
  timezone: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [definition, setDefinition] = useState<CfpDefinitionInput>(() =>
    cfp
      ? {
          name: cfp.name,
          deadline: cfp.deadline,
          formats: cfp.formats,
          customFields: cfp.customFields,
        }
      : emptyCfpDefinition(),
  );
  const [validationError, setValidationError] = useState<{
    message: string;
    path: (string | number)[];
  }>();
  const refresh = () =>
    queryClient.invalidateQueries(trpc.cfps.getSetup.queryFilter({ slug }));
  const create = useMutation(
    trpc.cfps.createDraft.mutationOptions({ onSuccess: refresh }),
  );
  const update = useMutation(
    trpc.cfps.updateDraft.mutationOptions({ onSuccess: refresh }),
  );
  const open = useMutation(
    trpc.cfps.open.mutationOptions({ onSuccess: refresh }),
  );
  const formId = cfp?.id ?? "new";

  function parsedDefinition(): CfpDefinitionInput | undefined {
    const parsed = cfpDefinitionInputSchema.safeParse(definition);
    if (!parsed.success) {
      setValidationError(cfpValidationError(parsed.error.issues[0]));
      return undefined;
    }
    if (instantFallsAfterLocalDate(parsed.data.deadline, endsOn, timezone)) {
      setValidationError({
        message: "Choose a deadline on or before the event end date.",
        path: ["deadline"],
      });
      return undefined;
    }
    setValidationError(undefined);
    return parsed.data;
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const parsed = parsedDefinition();
    if (!parsed) return;
    if (cfp) update.mutate({ slug, cfpId: cfp.id, ...parsed });
    else create.mutate({ slug, ...parsed });
  }

  function saveAndOpen() {
    const parsed = parsedDefinition();
    if (!parsed) return;
    if (!cfp) {
      setValidationError({
        message: "Create the draft before opening it.",
        path: [],
      });
      return;
    }

    open.mutate({ slug, cfpId: cfp.id, ...parsed });
  }

  function updateField(index: number, field: CustomField) {
    setDefinition((current) => ({
      ...current,
      customFields: current.customFields.map((currentField, fieldIndex) =>
        fieldIndex === index ? field : currentField,
      ),
    }));
  }

  function addField(type: CustomField["type"]) {
    setDefinition((current) => ({
      ...current,
      customFields: [
        ...current.customFields,
        newCustomField(type, nextCustomFieldKey(current.customFields)),
      ],
    }));
  }

  const mutationError = create.error ?? update.error ?? open.error;
  return (
    <section className="cfp-builder">
      <div className="builder-title">
        <div>
          <div className="eyebrow">Public form</div>
          <h2>{cfp ? cfp.name : "Draft your CFP"}</h2>
        </div>
        {cfp && (
          <span className={`status-chip status-${cfp.status}`}>
            {cfp.status}
          </span>
        )}
      </div>
      <form onInput={() => setValidationError(undefined)} onSubmit={save}>
        {cfp?.structureLocked && (
          <p className="locked-form-note">
            A proposal has been submitted. Formats, tracks, and custom fields
            are locked. You can still update the CFP name and deadline.
          </p>
        )}
        <fieldset className="builder-fields">
          <div className="field-pair">
            <Field label="CFP name" name={`cfp-name-${formId}`}>
              <input
                id={`cfp-name-${formId}`}
                value={definition.name}
                onChange={(event) =>
                  setDefinition((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </Field>
            <Field label="Deadline" name={`cfp-deadline-${formId}`}>
              <input
                id={`cfp-deadline-${formId}`}
                type="datetime-local"
                value={isoToEventLocalDateTime(definition.deadline, timezone)}
                onChange={(event) => {
                  const deadline = eventLocalDateTimeToIso(
                    event.target.value,
                    timezone,
                  );
                  setDefinition((current) => ({
                    ...current,
                    deadline: deadline ?? "",
                  }));
                  setValidationError(
                    deadline
                      ? undefined
                      : {
                          message:
                            "Choose a deadline that exists in the event timezone.",
                          path: ["deadline"],
                        },
                  );
                }}
              />
            </Field>
          </div>
          <Field
            hint="Separate formats with commas"
            label="Formats"
            name={`cfp-formats-${formId}`}
          >
            <CommaSeparatedInput
              disabled={cfp?.structureLocked}
              id={`cfp-formats-${formId}`}
              initialValues={definition.formats}
              onValuesChange={(formats) =>
                setDefinition((current) => ({
                  ...current,
                  formats,
                }))
              }
            />
          </Field>
          <div className="core-field-note">
            <strong>Always included</strong>
            <span>Title · Abstract · Format · Track · Proposed speakers</span>
          </div>
          <div className="custom-field-heading">
            <div>
              <div className="eyebrow">Custom fields</div>
              <p>Add only the information this event needs.</p>
            </div>
            <div className="field-type-actions">
              <button
                disabled={cfp?.structureLocked}
                type="button"
                onClick={() => addField("short_text")}
              >
                + Short text
              </button>
              <button
                disabled={cfp?.structureLocked}
                type="button"
                onClick={() => addField("long_text")}
              >
                + Long text
              </button>
              <button
                disabled={cfp?.structureLocked}
                type="button"
                onClick={() => addField("single_select")}
              >
                + Single select
              </button>
            </div>
          </div>
          {definition.customFields.map((field, index) => (
            <CustomFieldEditor
              allFields={definition.customFields}
              disabled={cfp?.structureLocked ?? false}
              field={field}
              idPrefix={formId}
              index={index}
              key={index}
              validationMessage={
                validationError?.path[0] === "customFields" &&
                validationError.path[1] === index
                  ? validationError.message
                  : undefined
              }
              onChange={(next) => updateField(index, next)}
              onRemove={() =>
                setDefinition((current) => ({
                  ...current,
                  customFields: removeCustomField(current.customFields, index),
                }))
              }
            />
          ))}
        </fieldset>
        {(validationError?.path[0] !== "customFields" || mutationError) &&
          (validationError || mutationError) && (
            <p className="form-error" role="alert">
              {validationError?.message ?? mutationError?.message}
            </p>
          )}
        <div className="builder-actions">
          <button
            className="primary-button"
            disabled={create.isPending || update.isPending}
            type="submit"
          >
            {cfp?.structureLocked
              ? "Save name and deadline"
              : cfp
                ? "Save form"
                : "Create draft"}
          </button>
          {cfp?.status === "draft" && (
            <button
              className="open-button"
              disabled={open.isPending}
              onClick={saveAndOpen}
              type="button"
            >
              Open CFP
            </button>
          )}
          {cfp?.status === "open" && (
            <Link className="arrow-link" to={`/events/${slug}/cfp`}>
              View public form →
            </Link>
          )}
        </div>
      </form>
    </section>
  );
}

function CommaSeparatedInput({
  disabled,
  id,
  initialValues,
  onValuesChange,
}: {
  disabled?: boolean | undefined;
  id: string;
  initialValues: string[];
  onValuesChange: (values: string[]) => void;
}) {
  const [text, setText] = useState(() => initialValues.join(", "));

  return (
    <input
      disabled={disabled}
      id={id}
      value={text}
      onChange={(event) => {
        const nextText = event.target.value;
        setText(nextText);
        onValuesChange(
          nextText
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}

function CustomFieldEditor({
  disabled,
  field,
  idPrefix,
  index,
  allFields,
  validationMessage,
  onChange,
  onRemove,
}: {
  disabled: boolean;
  field: CustomField;
  idPrefix: string;
  index: number;
  allFields: CustomField[];
  validationMessage?: string | undefined;
  onChange: (field: CustomField) => void;
  onRemove: () => void;
}) {
  const sources = conditionSourceFields(allFields, index);
  const condition = field.condition;
  const source = sources.find(
    (candidate) => candidate.key === condition?.fieldKey,
  );
  const fieldId = (name: string) => `${idPrefix}-${name}-${index}`;
  return (
    <fieldset className="custom-field-card" disabled={disabled}>
      <legend>{field.type.replace("_", " ")}</legend>
      {validationMessage && (
        <p className="form-error" role="alert">
          {validationMessage}
        </p>
      )}
      <Field label="Label" name={fieldId("field-label")}>
        <input
          id={fieldId("field-label")}
          value={field.label}
          onChange={(event) =>
            onChange({ ...field, label: event.target.value })
          }
        />
      </Field>
      {field.type === "single_select" && (
        <Field
          hint="Separate options with commas"
          label="Options"
          name={fieldId("field-options")}
        >
          <CommaSeparatedInput
            id={fieldId("field-options")}
            initialValues={field.options}
            key={field.key}
            onValuesChange={(options) =>
              onChange({
                ...field,
                options,
              })
            }
          />
        </Field>
      )}
      {field.type === "file" && (
        <div className="field-pair">
          <Field label="Accepted MIME types" name={fieldId("field-types")}>
            <input
              id={fieldId("field-types")}
              value={field.acceptedTypes.join(", ")}
              onChange={(event) =>
                onChange({
                  ...field,
                  acceptedTypes: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field label="Maximum MB" name={fieldId("field-size")}>
            <input
              id={fieldId("field-size")}
              min="1"
              max="100"
              type="number"
              value={field.maxSizeMb}
              onChange={(event) =>
                onChange({ ...field, maxSizeMb: Number(event.target.value) })
              }
            />
          </Field>
        </div>
      )}
      <div className="field-rules">
        <label>
          <input
            checked={field.required}
            onChange={(event) =>
              onChange({ ...field, required: event.target.checked })
            }
            type="checkbox"
          />{" "}
          Required
        </label>
        <label>
          Show when
          <select
            value={field.condition?.fieldKey ?? ""}
            onChange={(event) => {
              const nextSource = sources.find(
                (candidate) => candidate.key === event.target.value,
              );
              onChange({
                ...field,
                condition:
                  nextSource?.type === "single_select"
                    ? {
                        fieldKey: nextSource.key,
                        equals: nextSource.options[0] ?? "",
                      }
                    : undefined,
              });
            }}
          >
            <option value="">Always visible</option>
            {sources.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.label}
              </option>
            ))}
          </select>
        </label>
        {sources.length === 0 && (
          <span className="field-rule-hint">
            Add a single-select field above this one to make it conditional.
          </span>
        )}
        {source?.type === "single_select" && condition && (
          <select
            aria-label="Condition value"
            value={condition.equals}
            onChange={(event) =>
              onChange({
                ...field,
                condition: { ...condition, equals: event.target.value },
              })
            }
          >
            {source.options.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        )}
        <button
          className="text-button danger-button"
          onClick={onRemove}
          type="button"
        >
          Remove field
        </button>
      </div>
    </fieldset>
  );
}

type ProposalEditContent = Omit<ProposalContent, "proposedSpeakers">;

function SubmissionPage() {
  const { submissionId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const submissionInput = { submissionId: submissionId as SubmissionId };
  const submission = useQuery(
    trpc.submissions.get.queryOptions(submissionInput),
  );
  const [editState, setEditState] = useState<{
    submissionId: string;
    content: ProposalEditContent;
    revision: number;
  }>();
  const update = useMutation(
    trpc.submissions.updateOwn.mutationOptions({
      onSuccess: async (saved) => {
        setEditState({
          submissionId: saved.id,
          content: submissionContent(saved),
          revision: saved.revision,
        });
        await queryClient.invalidateQueries(
          trpc.submissions.get.queryFilter(submissionInput),
        );
      },
      onError: async (error, attempted) => {
        if (error.data?.code !== "CONFLICT") return;
        const latest = await queryClient.fetchQuery(
          trpc.submissions.get.queryOptions(submissionInput),
        );
        if (latest.revision === attempted.expectedRevision) return;
        setEditState({
          submissionId: latest.id,
          content: submissionContent(latest),
          revision: latest.revision,
        });
      },
    }),
  );
  const withdraw = useMutation(
    trpc.submissions.withdrawOwn.mutationOptions({
      onSuccess: async () => {
        setEditState(undefined);
        await queryClient.invalidateQueries(
          trpc.submissions.get.queryFilter(submissionInput),
        );
      },
    }),
  );

  if (submission.isPending) return <FullPageStatus label="Opening proposal" />;
  if (submission.isError)
    return (
      <div className="page">
        <BoardStatus
          label="Proposal unavailable"
          detail={submission.error.message}
        />
      </div>
    );

  const loadedSubmission = submission.data;
  const active = loadedSubmission.status === "active";
  const initialContent = submissionContent(loadedSubmission);
  const currentContent =
    editState?.submissionId === submission.data.id
      ? editState.content
      : initialContent;
  const editable = submission.data.permissions.canEdit;

  function changeContent(
    update: (current: ProposalEditContent) => ProposalEditContent,
  ) {
    setEditState((current) => ({
      submissionId: loadedSubmission.id,
      revision:
        current?.submissionId === loadedSubmission.id
          ? current.revision
          : loadedSubmission.revision,
      content: update(
        current?.submissionId === loadedSubmission.id
          ? current.content
          : initialContent,
      ),
    }));
  }

  function save(event: FormEvent) {
    event.preventDefault();
    update.mutate({
      submissionId: submissionInput.submissionId,
      expectedRevision:
        editState?.submissionId === loadedSubmission.id
          ? editState.revision
          : loadedSubmission.revision,
      ...currentContent,
    });
  }

  return (
    <div className="page submission-page">
      <Link className="arrow-link" to="/">
        ← My events
      </Link>
      <section className="submission-heading">
        <div>
          <div className="eyebrow">Proposal received</div>
          <h1>{submission.data.title}</h1>
          <p>
            {submission.data.event.name} · {submission.data.cfp.name}
          </p>
        </div>
        <div className="submission-state-group">
          <span
            className={`submission-state ${active ? "active" : "withdrawn"}`}
          >
            {submission.data.status}
          </span>
          <span className="submission-state">
            Decision: {submission.data.decision.status.replace("_", " ")}
          </span>
          <span className="submission-state">
            Confirmation: {submission.data.confirmation.status}
          </span>
        </div>
      </section>
      {searchParams.get("invitationDelivery") === "failed" && (
        <p className="invite-notice invite-notice-warning" role="status">
          The proposal was saved, but at least one invitation email could not be
          sent. Send a new invitation from the proposed-speaker list.
        </p>
      )}
      {currentContent && (
        <section className="form-board submission-form">
          <form onSubmit={save}>
            <div className="eyebrow">Your proposal</div>
            <fieldset
              className="submission-fields"
              disabled={!editable || update.isPending}
            >
              <div className="field-pair">
                <Field label="Title" name="submission-title">
                  <input
                    id="submission-title"
                    required
                    value={currentContent.title}
                    onChange={(event) =>
                      changeContent((current) => ({
                        ...current,
                        title: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Track" name="submission-track">
                  <select
                    id="submission-track"
                    required
                    value={currentContent.trackId}
                    onChange={(event) =>
                      changeContent((current) => ({
                        ...current,
                        trackId: event.target
                          .value as ProposalEditContent["trackId"],
                      }))
                    }
                  >
                    {submission.data.form.tracks.map((track) => (
                      <option key={track.id} value={track.id}>
                        {track.name}
                        {track.archived ? " (archived)" : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Abstract" name="submission-abstract">
                <textarea
                  id="submission-abstract"
                  required
                  value={currentContent.abstract}
                  onChange={(event) =>
                    changeContent((current) => ({
                      ...current,
                      abstract: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="Format" name="submission-format">
                <select
                  id="submission-format"
                  required
                  value={currentContent.format}
                  onChange={(event) =>
                    changeContent((current) => ({
                      ...current,
                      format: event.target.value,
                    }))
                  }
                >
                  {submission.data.form.formats.map((format) => (
                    <option key={format}>{format}</option>
                  ))}
                </select>
              </Field>
              {visibleCustomFields(
                submission.data.form.customFields,
                currentContent.customAnswers,
              ).map((field) => (
                <PublicCustomField
                  disabled={!editable || update.isPending}
                  field={field}
                  key={field.key}
                  value={currentContent.customAnswers[field.key] ?? ""}
                  onChange={(value) =>
                    changeContent((current) => ({
                      ...current,
                      customAnswers: {
                        ...current.customAnswers,
                        [field.key]: value,
                      },
                    }))
                  }
                />
              ))}
            </fieldset>
            {(update.error || withdraw.error) && (
              <p className="form-error" role="alert">
                {update.error?.message ?? withdraw.error?.message}
              </p>
            )}
            {(editable || submission.data.permissions.canWithdraw) && (
              <div className="submission-actions">
                <button
                  className="primary-button"
                  disabled={!editable || update.isPending}
                  type="submit"
                >
                  {update.isPending ? "Saving…" : "Save proposal"}
                </button>
                {submission.data.permissions.canWithdraw && (
                  <button
                    className="text-button danger-button"
                    disabled={withdraw.isPending}
                    onClick={() =>
                      withdraw.mutate({
                        submissionId: submissionInput.submissionId,
                      })
                    }
                    type="button"
                  >
                    {withdraw.isPending ? "Withdrawing…" : "Withdraw proposal"}
                  </button>
                )}
              </div>
            )}
          </form>
        </section>
      )}
      <SubmissionSpeakerManager
        submission={submission.data}
        submissionInput={submissionInput}
      />
    </div>
  );
}

function SubmissionSpeakerManager({
  submission,
  submissionInput,
}: {
  submission: Submission;
  submissionInput: { submissionId: SubmissionId };
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [deliveryNotice, setDeliveryNotice] = useState<string>();
  const submissionQuery = trpc.submissions.get.queryOptions(submissionInput);
  const refresh = () =>
    queryClient.invalidateQueries(
      trpc.submissions.get.queryFilter(submissionInput),
    );
  const add = useMutation(
    trpc.submissions.addSpeaker.mutationOptions({
      onSuccess: async (result) => {
        setName("");
        setEmail("");
        setDeliveryNotice(
          result.delivery === "failed"
            ? "The speaker was saved, but the email could not be sent. Send a new invitation from their row."
            : undefined,
        );
        await refresh();
      },
    }),
  );
  const remove = useMutation(
    trpc.submissions.removeSpeaker.mutationOptions({
      onMutate: async ({ speakerId }) => {
        await queryClient.cancelQueries(
          trpc.submissions.get.queryFilter(submissionInput),
        );
        const previousSubmission = queryClient.getQueryData(
          submissionQuery.queryKey,
        );
        queryClient.setQueryData(submissionQuery.queryKey, (current) =>
          current
            ? {
                ...current,
                proposedSpeakers: current.proposedSpeakers.filter(
                  (speaker) => speaker.id !== speakerId,
                ),
              }
            : current,
        );
        return { previousSubmission };
      },
      onError: (_error, _input, context) => {
        if (context?.previousSubmission) {
          queryClient.setQueryData(
            submissionQuery.queryKey,
            context.previousSubmission,
          );
        }
      },
      onSettled: refresh,
    }),
  );
  const replace = useMutation(
    trpc.submissions.replaceSpeakerInvitation.mutationOptions({
      onSuccess: async (result) => {
        setDeliveryNotice(
          result.delivery === "failed"
            ? "The new invitation was saved, but the email could not be sent. Try again."
            : undefined,
        );
        await refresh();
      },
    }),
  );
  const resend = useMutation(
    trpc.submissions.resendSpeakerInvitation.mutationOptions({
      onSuccess: async (result) => {
        setDeliveryNotice(
          result.delivery === "failed"
            ? "The invitation was saved, but the email could not be sent. Try again."
            : undefined,
        );
        await refresh();
      },
    }),
  );
  const mutationError =
    add.error ?? remove.error ?? replace.error ?? resend.error;
  const isOnlyProposedSpeaker = submission.proposedSpeakers.length === 1;

  function invite(event: FormEvent) {
    event.preventDefault();
    add.mutate({ ...submissionInput, name, email });
  }

  return (
    <section className="form-board speaker-board">
      <div className="builder-title">
        <div>
          <div className="eyebrow">Proposed speakers</div>
          <h2>People attached to this proposal</h2>
        </div>
        <span className="submission-state">
          {submission.proposedSpeakers.length} active
        </span>
      </div>
      <div className="speaker-list">
        {submission.proposedSpeakers.map((speaker) => (
          <div className="speaker-row" key={speaker.id}>
            <div>
              <strong>{speaker.name}</strong>
              <span>{speaker.email ?? "Email hidden"}</span>
            </div>
            <div className="speaker-row-actions">
              <span
                className={`submission-state ${speaker.claimed ? "active" : ""}`}
              >
                {speaker.claimed
                  ? "Claimed"
                  : speaker.invitation?.usable
                    ? "Invitation pending"
                    : "Invitation unavailable"}
              </span>
              {submission.permissions.canManageSpeakers &&
                !speaker.claimed &&
                speaker.invitation?.status === "pending" && (
                  <button
                    className="text-button"
                    disabled={replace.isPending}
                    onClick={() =>
                      replace.mutate({
                        ...submissionInput,
                        speakerId: speaker.id,
                        replacesInvitationId: speaker.invitation?.id ?? "",
                      })
                    }
                    type="button"
                  >
                    Send new invitation
                  </button>
                )}
              {submission.permissions.canManageSpeakers &&
                !speaker.claimed &&
                speaker.invitation?.status !== "pending" && (
                  <button
                    className="text-button"
                    disabled={resend.isPending}
                    onClick={() =>
                      resend.mutate({
                        ...submissionInput,
                        speakerId: speaker.id,
                      })
                    }
                    type="button"
                  >
                    Send invitation
                  </button>
                )}
              {submission.permissions.canManageSpeakers && (
                <>
                  <button
                    aria-describedby={
                      isOnlyProposedSpeaker
                        ? `remove-speaker-reason-${speaker.id}`
                        : undefined
                    }
                    className="text-button danger-button"
                    disabled={remove.isPending || isOnlyProposedSpeaker}
                    onClick={() =>
                      remove.mutate({
                        ...submissionInput,
                        speakerId: speaker.id,
                      })
                    }
                    type="button"
                  >
                    Remove
                  </button>
                  {isOnlyProposedSpeaker && (
                    <span
                      className="speaker-removal-reason"
                      id={`remove-speaker-reason-${speaker.id}`}
                    >
                      At least one proposed speaker must remain.
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {submission.permissions.canManageSpeakers && (
        <form className="speaker-invite-form" onSubmit={invite}>
          <Field label="Proposed speaker name" name="new-speaker-name">
            <input
              id="new-speaker-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Proposed speaker email" name="new-speaker-email">
            <input
              id="new-speaker-email"
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <button className="primary-button" disabled={add.isPending}>
            {add.isPending ? "Inviting…" : "Invite proposed speaker"}
          </button>
        </form>
      )}
      {mutationError && (
        <p className="form-error" role="alert">
          {mutationError.message}
        </p>
      )}
      {deliveryNotice && (
        <p className="invite-notice invite-notice-warning" role="status">
          {deliveryNotice}
        </p>
      )}
    </section>
  );
}

function PublicCfpPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const session = authClient.useSession();
  const cfp = useQuery(
    trpc.cfps.publicByEventSlug.queryOptions(
      { slug },
      { refetchOnWindowFocus: false, retry: false, staleTime: Infinity },
    ),
  );
  const [draft, setDraft] = useState<ProposalDraft>(() =>
    loadProposalDraft(slug),
  );
  const [proposalError, setProposalError] = useState<string>();
  const [signInPending, setSignInPending] = useState(false);
  const draftKey = proposalDraftKey(slug);
  const submit = useMutation(
    trpc.submissions.submit.mutationOptions({
      onSuccess: (submission) => {
        if (draftKey) window.localStorage.removeItem(draftKey);
        const deliveryQuery = submission.invitationDeliveryFailed
          ? "?invitationDelivery=failed"
          : "";
        void navigate(`/submissions/${submission.id}${deliveryQuery}`);
      },
      onError: () => {
        setDraft((current) => ({ ...current, submitAfterSignIn: false }));
      },
    }),
  );
  const { coreAnswers, customAnswers, step } = draft;

  useEffect(() => {
    window.localStorage.setItem(draftKey, JSON.stringify(draft));
  }, [draft, draftKey]);

  function proposalInput() {
    if (!cfp.data) {
      return {
        ok: false as const,
        message: "The proposal form is unavailable.",
      };
    }
    const parsed = proposalContentSchema.safeParse({
      title: coreAnswers.title,
      abstract: coreAnswers.abstract,
      format: coreAnswers.format,
      trackId: coreAnswers.track,
      proposedSpeakers: [
        { name: coreAnswers.speakerName, email: coreAnswers.speakerEmail },
      ],
      customAnswers,
    });
    if (!parsed.success) {
      return {
        ok: false as const,
        message:
          parsed.error.issues[0]?.message ??
          "Check the proposal before submitting.",
      };
    }
    return {
      ok: true as const,
      value: {
        slug,
        cfpId: cfp.data.cfpId,
        clientDraftId: draft.clientDraftId,
        ...parsed.data,
      },
    };
  }

  const finishPendingSubmission = useEffectEvent(() => {
    const parsed = proposalInput();
    if (parsed.ok) submit.mutate(parsed.value);
  });

  useEffect(() => {
    if (
      draft.submitAfterSignIn &&
      session.data &&
      cfp.data &&
      !submit.isPending
    ) {
      finishPendingSubmission();
    }
  }, [cfp.data, draft.submitAfterSignIn, session.data, submit.isPending]);

  function setStep(update: number | ((current: number) => number)) {
    setDraft((current) => ({
      ...current,
      step: typeof update === "function" ? update(current.step) : update,
    }));
  }

  function setCoreAnswers(
    update: (
      current: ProposalDraft["coreAnswers"],
    ) => ProposalDraft["coreAnswers"],
  ) {
    setDraft((current) => ({
      ...current,
      coreAnswers: update(current.coreAnswers),
    }));
  }

  function setCustomAnswers(
    update: (
      current: ProposalDraft["customAnswers"],
    ) => ProposalDraft["customAnswers"],
  ) {
    setDraft((current) => ({
      ...current,
      customAnswers: update(current.customAnswers),
    }));
  }

  async function advance(event: FormEvent) {
    event.preventDefault();
    if (step < publicCfpSteps.length - 1) {
      setStep((current) => current + 1);
      return;
    }

    const parsed = proposalInput();
    if (!parsed.ok) {
      setProposalError(parsed.message);
      return;
    }
    setProposalError(undefined);

    if (!session.data) {
      const returnTo = `/events/${slug}/cfp`;
      const pendingDraft = { ...draft, submitAfterSignIn: true };
      const speakerEmail = parsed.value.proposedSpeakers[0]?.email;
      if (!speakerEmail) return;
      setSignInPending(true);
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: speakerEmail,
        type: "sign-in",
      });
      setSignInPending(false);
      if (result.error) {
        setProposalError("The sign-in code could not be sent. Try again.");
        return;
      }
      setDraft(pendingDraft);
      window.localStorage.setItem(draftKey, JSON.stringify(pendingDraft));
      window.sessionStorage.setItem(pendingSignInKey(returnTo), speakerEmail);
      void navigate(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }

    submit.mutate(parsed.value);
  }

  if (cfp.isPending)
    return <FullPageStatus label="Opening call for proposals" />;
  if (cfp.isError)
    return (
      <main className="public-cfp">
        <BoardStatus label="This CFP is not open" detail={cfp.error.message} />
      </main>
    );

  return (
    <main className="public-cfp">
      <header className="public-cfp-header">
        <Link className="wordmark" to="/">
          <span className="wordmark-mark">OB</span>
          <span>{cfp.data.event.name}</span>
        </Link>
        <div className="deadline">
          <span>Deadline</span>
          <strong>
            {formatDeadline(cfp.data.deadline, cfp.data.event.timezone)}
          </strong>
        </div>
      </header>
      <div className="public-form-shell">
        <aside className="public-form-intro">
          <div className="eyebrow">Call for proposals</div>
          <h1>{cfp.data.name}</h1>
          <ol>
            {publicCfpSteps.map((label, index) => (
              <li className={step === index ? "current" : ""} key={label}>
                <span>0{index + 1}</span>
                {label}
              </li>
            ))}
          </ol>
        </aside>
        <section className="public-form-card">
          <form onSubmit={(event) => void advance(event)}>
            {step === 0 && (
              <>
                <div className="eyebrow">01 · The idea</div>
                <h2>What do you want to share?</h2>
                <Field
                  label="Title"
                  name="public-title"
                  required={cfp.data.coreFields.title.required}
                >
                  <input
                    id="public-title"
                    required={cfp.data.coreFields.title.required}
                    value={coreAnswers.title}
                    onChange={(event) =>
                      setCoreAnswers((current) => ({
                        ...current,
                        title: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field
                  label="Abstract"
                  name="public-abstract"
                  required={cfp.data.coreFields.abstract.required}
                >
                  <textarea
                    id="public-abstract"
                    required={cfp.data.coreFields.abstract.required}
                    value={coreAnswers.abstract}
                    onChange={(event) =>
                      setCoreAnswers((current) => ({
                        ...current,
                        abstract: event.target.value,
                      }))
                    }
                  />
                </Field>
                <div className="field-pair">
                  <Field
                    label="Format"
                    name="public-format"
                    required={cfp.data.coreFields.format.required}
                  >
                    <select
                      id="public-format"
                      required={cfp.data.coreFields.format.required}
                      value={coreAnswers.format}
                      onChange={(event) =>
                        setCoreAnswers((current) => ({
                          ...current,
                          format: event.target.value,
                        }))
                      }
                    >
                      <option value="">Choose a format</option>
                      {cfp.data.formats.map((format) => (
                        <option key={format}>{format}</option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label="Track"
                    name="public-track"
                    required={cfp.data.coreFields.track.required}
                  >
                    <select
                      id="public-track"
                      required={cfp.data.coreFields.track.required}
                      value={coreAnswers.track}
                      onChange={(event) =>
                        setCoreAnswers((current) => ({
                          ...current,
                          track: event.target.value,
                        }))
                      }
                    >
                      <option value="">Choose a track</option>
                      {cfp.data.tracks.map((track) => (
                        <option key={track.id} value={track.id}>
                          {track.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </>
            )}
            {step === 1 && (
              <>
                <div className="eyebrow">02 · The people</div>
                <h2>Who will present?</h2>
                <Field
                  label="Proposed speaker name"
                  name="speaker-name"
                  required={cfp.data.coreFields.proposedSpeakers.required}
                >
                  <input
                    id="speaker-name"
                    required={cfp.data.coreFields.proposedSpeakers.required}
                    value={coreAnswers.speakerName}
                    onChange={(event) =>
                      setCoreAnswers((current) => ({
                        ...current,
                        speakerName: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field
                  label="Proposed speaker email"
                  name="speaker-email"
                  required={cfp.data.coreFields.proposedSpeakers.required}
                >
                  <input
                    id="speaker-email"
                    required={cfp.data.coreFields.proposedSpeakers.required}
                    type="email"
                    value={coreAnswers.speakerEmail}
                    onChange={(event) =>
                      setCoreAnswers((current) => ({
                        ...current,
                        speakerEmail: event.target.value,
                      }))
                    }
                  />
                </Field>
              </>
            )}
            {step === 2 && (
              <>
                <div className="eyebrow">03 · Event questions</div>
                <h2>A few details for this event.</h2>
                {visibleCustomFields(cfp.data.customFields, customAnswers).map(
                  (field) => (
                    <PublicCustomField
                      disabled={false}
                      field={field}
                      key={field.key}
                      value={customAnswers[field.key] ?? ""}
                      onChange={(value) =>
                        setCustomAnswers((current) => ({
                          ...current,
                          [field.key]: value,
                        }))
                      }
                    />
                  ),
                )}
                {cfp.data.customFields.length === 0 && (
                  <p className="muted">
                    No extra questions. Your proposal is ready for the
                    submission step.
                  </p>
                )}
              </>
            )}
            <div className="public-form-actions">
              {step > 0 && (
                <button
                  className="text-button"
                  onClick={() => setStep((current) => current - 1)}
                  type="button"
                >
                  Back
                </button>
              )}
              {step < publicCfpSteps.length - 1 ? (
                <button className="primary-button" type="submit">
                  Continue
                </button>
              ) : (
                <button
                  className="primary-button"
                  disabled={
                    submit.isPending || session.isPending || signInPending
                  }
                  type="submit"
                >
                  {signInPending
                    ? "Sending code…"
                    : submit.isPending
                      ? "Submitting…"
                      : session.data
                        ? "Submit proposal"
                        : "Sign in and submit"}
                </button>
              )}
            </div>
            {(proposalError || submit.error) && (
              <p className="form-error" role="alert">
                {proposalError ?? submit.error?.message}
              </p>
            )}
          </form>
        </section>
      </div>
    </main>
  );
}

function PublicCustomField({
  disabled,
  field,
  value,
  onChange,
}: {
  disabled: boolean;
  field: CustomField;
  value: string;
  onChange: (value: string) => void;
}) {
  if (field.type === "long_text")
    return (
      <Field label={field.label} name={field.key} required={field.required}>
        <textarea
          disabled={disabled}
          id={field.key}
          required={field.required}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    );
  if (field.type === "single_select")
    return (
      <Field label={field.label} name={field.key} required={field.required}>
        <select
          disabled={disabled}
          id={field.key}
          required={field.required}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose one</option>
          {field.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </Field>
    );
  if (field.type === "file")
    return (
      <Field
        hint={`Up to ${field.maxSizeMb} MB`}
        label={field.label}
        name={field.key}
        required={field.required}
      >
        <input
          accept={field.acceptedTypes.join(",")}
          disabled
          id={field.key}
          required={field.required}
          type="file"
        />
      </Field>
    );
  return (
    <Field label={field.label} name={field.key} required={field.required}>
      <input
        disabled={disabled}
        id={field.key}
        required={field.required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function emptyCfpDefinition(): CfpDefinitionInput {
  const deadline = new Date();
  deadline.setMonth(deadline.getMonth() + 1);
  return {
    name: "",
    deadline: deadline.toISOString(),
    formats: ["Talk", "Workshop"],
    customFields: [],
  };
}

function emptyProposalDraft(): ProposalDraft {
  return {
    clientDraftId: crypto.randomUUID(),
    submitAfterSignIn: false,
    step: 0,
    coreAnswers: {
      abstract: "",
      format: "",
      speakerEmail: "",
      speakerName: "",
      title: "",
      track: "",
    },
    customAnswers: {},
  };
}

function loadProposalDraft(slug: string): ProposalDraft {
  const key = proposalDraftKey(slug);
  const stored = window.localStorage.getItem(key);
  if (!stored) return emptyProposalDraft();

  try {
    const parsed = proposalDraftSchema.safeParse(JSON.parse(stored) as unknown);
    if (parsed.success) return parsed.data;
  } catch {
    window.localStorage.removeItem(key);
  }
  return emptyProposalDraft();
}

function proposalDraftKey(slug: string): string {
  return `openboard:proposal-draft:${slug}`;
}

function submissionContent(submission: Submission): ProposalEditContent {
  return {
    title: submission.title,
    abstract: submission.abstract,
    format: submission.format,
    trackId: submission.track.id,
    customAnswers: submission.customAnswers,
  };
}

function newCustomField(type: CustomField["type"], key: string): CustomField {
  const base = {
    key,
    label: "New question",
    required: false,
  };
  if (type === "single_select")
    return { ...base, type, options: ["Option one", "Option two"] };
  if (type === "file")
    return { ...base, type, acceptedTypes: ["application/pdf"], maxSizeMb: 10 };
  return { ...base, type };
}

function formatDeadline(value: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZoneName: "short",
    year: "numeric",
    timeZone: timezone,
  }).format(new Date(value));
}

function cfpValidationError(
  issue:
    | {
        message: string;
        path: PropertyKey[];
      }
    | undefined,
): { message: string; path: (string | number)[] } {
  return {
    message: issue?.message ?? "Check the form definition.",
    path:
      issue?.path.filter(
        (segment): segment is string | number =>
          typeof segment === "string" || typeof segment === "number",
      ) ?? [],
  };
}

function Field({
  children,
  hint,
  label,
  name,
  required,
}: {
  children: ReactNode;
  hint?: string;
  label: string;
  name: string;
  required?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={name}>
        {label}
        {required && (
          <span aria-hidden="true" className="field-required">
            *
          </span>
        )}
      </label>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

function FullPageStatus({ label }: { label: string }) {
  return (
    <main className="full-status">
      <span className="pulse" />
      {label}
    </main>
  );
}

function SessionUnavailable() {
  return (
    <main className="full-status">
      <span>We couldn’t check your session.</span>
      <button
        className="text-button"
        onClick={() => window.location.reload()}
        type="button"
      >
        Try again
      </button>
    </main>
  );
}

function BoardStatus({ detail, label }: { detail?: string; label: string }) {
  return (
    <section className="empty-board">
      <h2>{label}</h2>
      {detail && <p>{detail}</p>}
    </section>
  );
}

function formatDateRange(startsOn: string, endsOn: string): string {
  const formatter = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const start = formatter.format(new Date(`${startsOn}T00:00:00Z`));
  const end = formatter.format(new Date(`${endsOn}T00:00:00Z`));
  return start === end ? start : `${start} – ${end}`;
}

function formatEventValidationError(
  issue: { message: string; path: PropertyKey[] } | undefined,
): string {
  if (!issue) return "Check the event details.";

  const labels: Partial<Record<keyof EventInput, string>> = {
    name: "Event name",
    slug: "Slug",
    startsOn: "Start date",
    endsOn: "End date",
    timezone: "Timezone",
  };
  const field = issue.path[0];
  const label =
    typeof field === "string" ? labels[field as keyof EventInput] : undefined;
  return label ? `${label}: ${issue.message}` : issue.message;
}

function safeReturnTo(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}
