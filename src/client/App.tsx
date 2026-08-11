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
  type EventInput,
} from "../shared/events";
import {
  proposalContentSchema,
  proposalDraftSchema,
  type ProposalContent,
  type ProposalDraft,
  type Submission,
  type SubmissionId,
} from "../shared/submissions";

import { authClient } from "./auth";
import { useTRPC } from "./trpc";

export function App() {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo({ left: 0, top: 0 });
  }, [location.pathname]);

  return (
    <Routes>
      <Route path="/events/:slug/cfp" element={<PublicCfpPage />} />
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
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="wordmark" to="/">
          <span className="wordmark-mark">OB</span>
          <span>OpenBoard</span>
        </Link>
        <div className="account-strip">
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
          <Route
            path="submissions/:submissionId"
            element={<SubmissionPage />}
          />
        </Routes>
      </main>
    </div>
  );
}

function SignInPage() {
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get("returnTo"));
  const invitationSignIn = returnTo.startsWith("/invitations/");
  const proposalSignIn = /^\/events\/[^/]+\/cfp$/.test(returnTo);
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
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

    window.location.assign(returnTo);
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

function EventIndex() {
  const trpc = useTRPC();
  const events = useQuery(trpc.events.list.queryOptions());
  const submissions = useQuery(trpc.submissions.listOwn.queryOptions());

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

  function update<K extends keyof EventInput>(field: K, value: EventInput[K]) {
    setInput((current) => ({ ...current, [field]: value }));
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
              onChange={(event) => update("name", event.target.value)}
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
                onChange={(event) =>
                  update("slug", event.target.value.toLowerCase())
                }
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
          <h2>Nothing scheduled yet.</h2>
          <p>
            Your private agenda is ready. Accepted program items and service
            blocks will land here.
          </p>
        </div>
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
    </div>
  );
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
            {board.data.submissions.length} proposals · {queued.length} queued
            outcomes
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
              Publish {selectedQueued.length} selected outcomes together
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
            message: `A ${result.role} invitation is already pending for ${result.email}. Nothing changed.`,
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
          <p className="form-error" role="alert">
            Sign out and use {invitation.data.email} to accept this invitation.
          </p>
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
            <input
              disabled={cfp?.structureLocked}
              id={`cfp-formats-${formId}`}
              value={definition.formats.join(", ")}
              onChange={(event) =>
                setDefinition((current) => ({
                  ...current,
                  formats: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
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
          <input
            id={fieldId("field-options")}
            value={field.options.join(", ")}
            onChange={(event) =>
              onChange({
                ...field,
                options: event.target.value
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
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

function SubmissionPage() {
  const { submissionId = "" } = useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const submissionInput = { submissionId: submissionId as SubmissionId };
  const submission = useQuery(
    trpc.submissions.getOwn.queryOptions(submissionInput),
  );
  const [editState, setEditState] = useState<{
    submissionId: string;
    content: ProposalContent;
  }>();
  const update = useMutation(
    trpc.submissions.updateOwn.mutationOptions({
      onSuccess: async (saved) => {
        setEditState({
          submissionId: saved.id,
          content: submissionContent(saved),
        });
        await queryClient.invalidateQueries(
          trpc.submissions.getOwn.queryFilter(submissionInput),
        );
      },
    }),
  );
  const withdraw = useMutation(
    trpc.submissions.withdrawOwn.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(
          trpc.submissions.getOwn.queryFilter(submissionInput),
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
    update: (current: ProposalContent) => ProposalContent,
  ) {
    setEditState((current) => ({
      submissionId: loadedSubmission.id,
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
                          .value as ProposalContent["trackId"],
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
              <div className="field-pair">
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
                <Field label="Proposed speaker" name="submission-speaker">
                  <input
                    id="submission-speaker"
                    required
                    value={currentContent.proposedSpeakers[0]?.name ?? ""}
                    onChange={(event) =>
                      changeContent((current) => ({
                        ...current,
                        proposedSpeakers: [
                          {
                            name: event.target.value,
                            email: current.proposedSpeakers[0]?.email ?? "",
                          },
                          ...current.proposedSpeakers.slice(1),
                        ],
                      }))
                    }
                  />
                </Field>
              </div>
              <Field label="Speaker email" name="submission-speaker-email">
                <input
                  id="submission-speaker-email"
                  required
                  type="email"
                  value={currentContent.proposedSpeakers[0]?.email ?? ""}
                  onChange={(event) =>
                    changeContent((current) => ({
                      ...current,
                      proposedSpeakers: [
                        {
                          name: current.proposedSpeakers[0]?.name ?? "",
                          email: event.target.value,
                        },
                        ...current.proposedSpeakers.slice(1),
                      ],
                    }))
                  }
                />
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
    </div>
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
  const draftKey = proposalDraftKey(slug);
  const submit = useMutation(
    trpc.submissions.submit.mutationOptions({
      onSuccess: (submission) => {
        if (draftKey) window.localStorage.removeItem(draftKey);
        void navigate(`/submissions/${submission.id}`);
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

  function advance(event: FormEvent) {
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
      setDraft(pendingDraft);
      window.localStorage.setItem(draftKey, JSON.stringify(pendingDraft));
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
          <form onSubmit={advance}>
            {step === 0 && (
              <>
                <div className="eyebrow">01 · The idea</div>
                <h2>What do you want to share?</h2>
                <Field label="Title" name="public-title">
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
                <Field label="Abstract" name="public-abstract">
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
                  <Field label="Format" name="public-format">
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
                  <Field label="Track" name="public-track">
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
                <Field label="Proposed speaker name" name="speaker-name">
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
                <Field label="Proposed speaker email" name="speaker-email">
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
                  disabled={submit.isPending || session.isPending}
                  type="submit"
                >
                  {submit.isPending
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
      <Field label={field.label} name={field.key}>
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
      <Field label={field.label} name={field.key}>
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
    <Field label={field.label} name={field.key}>
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

function submissionContent(submission: Submission): ProposalContent {
  return {
    title: submission.title,
    abstract: submission.abstract,
    format: submission.format,
    trackId: submission.track.id,
    proposedSpeakers: submission.proposedSpeakers.map(({ name, email }) => ({
      name,
      email,
    })),
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
}: {
  children: ReactNode;
  hint?: string;
  label: string;
  name: string;
}) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
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
