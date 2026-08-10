import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";

import type { EventRole, InvitationId } from "../shared/event-team";
import {
  eventInputSchema,
  listTimezones,
  type EventInput,
} from "../shared/events";

import { authClient } from "./auth";
import { useTRPC } from "./trpc";

export function App() {
  const session = authClient.useSession();

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
            <Navigate to="/sign-in" replace />
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
        </Routes>
      </main>
    </div>
  );
}

function SignInPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get("returnTo"));
  const invitationSignIn = returnTo.startsWith("/invitations/");
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

    void navigate(returnTo, { replace: true });
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
            {invitationSignIn ? "Invitation access" : "Owner access"}
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
      {events.isPending && <BoardStatus label="Loading events" />}
      {events.isError && (
        <BoardStatus
          label="Events are unavailable"
          detail={events.error.message}
        />
      )}
      {events.data?.length === 0 && (
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
    </div>
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
