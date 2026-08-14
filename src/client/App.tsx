import {
  hashKey,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type MutationKey,
} from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Link,
  Navigate,
  NavLink,
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
import type { CommunicationPurpose } from "../shared/communications";
import {
  cfpDeadlineInputBounds,
  defaultCfpDeadline,
  formatEventDateRange,
  instantFallsAfterLocalDate,
  instantFallsBeforeLocalDate,
  isoToEventLocalDateTime,
  resolveEventLocalDateTime,
} from "../shared/date-time";
import { ORGANIZER_CFP_AREA } from "../shared/event-routes";
import type { EventRole, InvitationId } from "../shared/event-team";
import {
  eventInputSchema,
  eventSettingsInputSchema,
  listTimezones,
  slugifyEventName,
  type EventInput,
  type EventSettingsInput,
} from "../shared/events";
import {
  MAX_STORED_FILE_BYTES,
  type StoredFile,
  type StoredFileId,
} from "../shared/files";
import {
  speakerHeadshotUploadSchema,
  type SpeakerHeadshotUpload,
  type SpeakerProfileInput,
} from "../shared/speaker-profiles";
import {
  proposalContentSchema,
  proposalDraftSchema,
  type ProposalContent,
  type ProposalDraft,
  type Submission,
  type SubmissionId,
} from "../shared/submissions";

import { MutationStatus } from "./MutationStatus";
import { authClient } from "./auth";
import {
  identifyBrowserUser,
  markBrowserSignInCompleted,
  trackBrowserEvent,
  trackBrowserPageView,
} from "./browser-telemetry";
import {
  eventSlugFromPath,
  eventSwitchPath,
  hasEventPermission,
  reviewLandingPath,
  type NavigationEvent,
  type ReviewPath,
} from "./event-navigation";
import { useMutationStatuses } from "./mutation-feedback";
import { useTRPC } from "./trpc";

const ONBOARDING_REFETCH_INTERVAL_MS = 15_000;
const FILE_ENCODING_CHUNK_BYTES = 32_768;
const AgendaPage = lazy(() =>
  import("./AgendaPage").then((module) => ({ default: module.AgendaPage })),
);
const PublicAgendaPage = lazy(() =>
  import("./AgendaPage").then((module) => ({
    default: module.PublicAgendaPage,
  })),
);

function pluralize(count: number, singular: string) {
  return count === 1 ? singular : `${singular}s`;
}

export function App() {
  const location = useLocation();
  const session = authClient.useSession();
  useBrowserUser(session.data?.user.id);
  useEffect(() => {
    trackBrowserPageView();
    window.scrollTo({ left: 0, top: 0 });
  }, [location.pathname]);

  return (
    <Suspense fallback={<FullPageStatus label="Opening agenda" />}>
      <Routes>
        <Route path="/events/:slug/cfp" element={<PublicCfpPage />} />
        <Route path="/events/:slug/schedule" element={<PublicAgendaPage />} />
        <Route path="/*" element={<SessionApp />} />
      </Routes>
    </Suspense>
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

function useBrowserUser(userId: string | undefined) {
  useEffect(() => {
    identifyBrowserUser(userId);
  }, [userId]);
}

function AuthenticatedApp({ email }: { email: string }) {
  const trpc = useTRPC();
  const location = useLocation();
  const navigate = useNavigate();
  const events = useQuery(trpc.events.list.queryOptions());
  const activeSubmissionId = location.pathname.match(
    /^\/submissions\/([^/]+)(?:\/|$)/,
  )?.[1] as SubmissionId | undefined;
  const activeSubmission = useQuery(
    trpc.submissions.get.queryOptions(
      { submissionId: activeSubmissionId ?? "" },
      { enabled: Boolean(activeSubmissionId) },
    ),
  );
  const activeSlug =
    eventSlugFromPath(location.pathname) ?? activeSubmission.data?.event.slug;
  const activeEvent =
    events.data?.find((event) => event.slug === activeSlug) ??
    (activeSubmission.data && activeSubmissionId
      ? {
          ...activeSubmission.data.event,
          access: "submitter" as const,
          permissions: [] as const,
          proposalPath: `/submissions/${activeSubmissionId}`,
        }
      : undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [signOutState, setSignOutState] = useState<
    | { status: "idle" }
    | { status: "pending" }
    | { status: "error"; message: string }
  >({ status: "idle" });
  async function signOut() {
    setSignOutState({ status: "pending" });
    const result = await authClient.signOut();
    if (result.error) {
      setSignOutState({
        status: "error",
        message: result.error.message ?? "Sign out failed. Try again.",
      });
    }
  }
  return (
    <div className={`app-shell ${activeEvent ? "event-shell" : ""}`}>
      <header className="mobile-topbar">
        <Link className="wordmark" to="/">
          <span className="wordmark-mark">OB</span>
          <span>OpenBoard</span>
        </Link>
        <button
          aria-expanded={drawerOpen}
          aria-label="Open navigation"
          className="navigation-toggle"
          onClick={() => setDrawerOpen((open) => !open)}
          type="button"
        >
          {drawerOpen ? "Close" : "Menu"}
        </button>
      </header>
      {drawerOpen && (
        <button
          aria-label="Close navigation"
          className="navigation-scrim"
          onClick={() => setDrawerOpen(false)}
          type="button"
        />
      )}
      <aside className={`app-sidebar ${drawerOpen ? "navigation-open" : ""}`}>
        <AppNavigation
          activeEvent={activeEvent}
          email={email}
          events={events.data ?? []}
          onNavigate={() => setDrawerOpen(false)}
          onSignOut={() => void signOut()}
          onSwitch={(slug) => {
            const target = events.data?.find((event) => event.slug === slug);
            if (target)
              void navigate(eventSwitchPath(location.pathname, target));
            setDrawerOpen(false);
          }}
          signOutPending={signOutState.status === "pending"}
        />
        {activeEvent && (
          <div className="drawer-event-navigation">
            <EventNavigation
              event={activeEvent}
              onNavigate={() => setDrawerOpen(false)}
            />
          </div>
        )}
      </aside>
      {activeEvent && (
        <aside className="event-sidebar">
          <EventNavigation event={activeEvent} />
        </aside>
      )}
      <main className="workspace-main">
        <Routes>
          <Route index element={<EventIndex />} />
          <Route path="events/new" element={<CreateEventPage />} />
          <Route path="events/:slug" element={<EventPage />} />
          <Route
            path="events/:slug/home"
            element={<Navigate to=".." replace />}
          />
          <Route path="events/:slug/tracks" element={<TracksPage />} />
          <Route path="events/:slug/rooms" element={<RoomsPage />} />
          <Route
            path={`events/:slug/${ORGANIZER_CFP_AREA}`}
            element={<CfpManagePage />}
          />
          <Route path="events/:slug/review/*" element={<ReviewPage />} />
          <Route path="events/:slug/agenda" element={<AgendaPage />} />
          <Route
            path="events/:slug/communications/*"
            element={<CommunicationSettingsPage />}
          />
          <Route
            path="events/:slug/readiness"
            element={<OrganizerReadinessPage view="overview" />}
          />
          <Route
            path="events/:slug/readiness/task-definitions"
            element={<OrganizerReadinessPage view="definitions" />}
          />
          <Route
            path="events/:slug/readiness/task-assignments"
            element={<OrganizerReadinessPage view="assignments" />}
          />
          <Route path="events/:slug/team" element={<EventTeamPage />} />
          <Route path="events/:slug/settings" element={<EventSettingsPage />} />
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

function AppNavigation({
  activeEvent,
  email,
  events,
  onNavigate,
  onSignOut,
  onSwitch,
  signOutPending,
}: {
  activeEvent: NavigationEvent | undefined;
  email: string;
  events: NavigationEvent[];
  onNavigate: () => void;
  onSignOut: () => void;
  onSwitch: (slug: string) => void;
  signOutPending: boolean;
}) {
  const switcherEvents =
    activeEvent && !events.some((event) => event.slug === activeEvent.slug)
      ? [activeEvent, ...events]
      : events;
  return (
    <>
      <Link className="wordmark sidebar-wordmark" onClick={onNavigate} to="/">
        <span className="wordmark-mark">OB</span>
        <span>OpenBoard</span>
      </Link>
      <nav aria-label="OpenBoard navigation" className="app-navigation">
        <NavLink onClick={onNavigate} to="/" end>
          Events
        </NavLink>
        {events.length > 0 && (
          <label className="event-switcher">
            <span>Active event</span>
            <select
              aria-label="Switch active event"
              onChange={(event) => onSwitch(event.target.value)}
              value={activeEvent?.slug ?? ""}
            >
              {!activeEvent && (
                <option key="choose-event" value="">
                  Choose an event
                </option>
              )}
              {switcherEvents.map((event) => (
                <option key={event.slug} value={event.slug}>
                  {event.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <NavLink onClick={onNavigate} to="/tasks">
          My tasks
        </NavLink>
        <NavLink onClick={onNavigate} to="/speaker-profile">
          Speaker profile
        </NavLink>
      </nav>
      <div className="sidebar-account">
        <span>{email}</span>
        <button
          className="text-button"
          disabled={signOutPending}
          onClick={onSignOut}
          type="button"
        >
          {signOutPending ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </>
  );
}

const organizerNavigation = [
  { group: "Overview", items: [["Home", ""]] },
  {
    group: "Program",
    items: [
      ["Tracks", "tracks"],
      ["Rooms", "rooms"],
      ["CFP", ORGANIZER_CFP_AREA],
      ["Review", "review"],
      ["Agenda", "agenda"],
    ],
  },
  { group: "People", items: [["Readiness", "readiness"]] },
  {
    group: "Operations",
    items: [
      ["Communications", "communications"],
      ["Settings", "settings"],
    ],
  },
] as const;

function EventNavigation({
  event,
  onNavigate,
}: {
  event: NavigationEvent;
  onNavigate?: () => void;
}) {
  const trpc = useTRPC();
  const workspace = useQuery(
    trpc.events.workspace.queryOptions(
      { slug: event.slug },
      { enabled: event.access !== "submitter" },
    ),
  );
  const badgeCount = (path: string) => {
    if (!workspace.data) return 0;
    if (path === "review" && !hasEventPermission(event, "organizer")) {
      return workspace.data.reviewer?.remaining ?? 0;
    }
    const keys: Record<string, string[]> = {
      [ORGANIZER_CFP_AREA]: ["cfp"],
      review: ["review", "decisions"],
      agenda: ["agenda-conflicts", "unplaced"],
      readiness: ["readiness"],
      team: ["team", "team-expired"],
      communications: ["communications"],
    };
    return workspace.data.attention
      .filter((item) => keys[path]?.includes(item.key))
      .reduce((sum, item) => sum + item.count, 0);
  };
  const groups = hasEventPermission(event, "organizer")
    ? organizerNavigation.map((group) => ({
        ...group,
        items: [...group.items],
      }))
    : hasEventPermission(event, "reviewer")
      ? [
          { group: "Overview", items: [["Home", ""]] },
          { group: "Program", items: [["Review", "review"]] },
        ]
      : [];
  if (event.access === "owner") {
    groups
      .find((group) => group.group === "People")
      ?.items.push(["Team", "team"] as never);
  }
  return (
    <nav aria-label={`${event.name} navigation`} className="event-navigation">
      <div className="event-navigation-title">
        <span>Active event</span>
        <strong>{event.name}</strong>
      </div>
      {event.access === "submitter" && (
        <div className="navigation-group">
          <span>Proposal</span>
          <NavLink end onClick={onNavigate} to={event.proposalPath}>
            <span>Proposal</span>
          </NavLink>
        </div>
      )}
      {groups.map((group) => (
        <div className="navigation-group" key={group.group}>
          <span>{group.group}</span>
          {group.items.map(([label, path]) => (
            <NavLink
              end={path === ""}
              key={label}
              onClick={onNavigate}
              to={`/events/${event.slug}${path ? `/${path}` : ""}`}
            >
              <span>{label}</span>
              {badgeCount(path) > 0 && (
                <span
                  className="navigation-badge"
                  aria-label={`${badgeCount(path)} ${badgeCount(path) === 1 ? "item needs" : "items need"} attention`}
                >
                  {badgeCount(path)}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

function SignInPage() {
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get("returnTo"));
  const [pendingEmail] = useState(() =>
    window.sessionStorage.getItem(pendingSignInKey(returnTo)),
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
  const [sendingCode, setSendingCode] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (!pendingEmail || !import.meta.env.DEV) return;
    void fetchCapturedAuthCode(pendingEmail).then(setDevCode);
  }, [pendingEmail]);

  async function requestCode(event: FormEvent) {
    event.preventDefault();
    await sendCode();
  }

  async function sendCode() {
    setSendingCode(true);
    setError(undefined);
    setCode("");
    setDevCode(undefined);
    const result = await beginEmailSignIn(email, returnTo);
    setSendingCode(false);

    if (result.error) {
      setError("The code could not be sent. Try again.");
      return;
    }

    setStep("code");
    if (import.meta.env.DEV) {
      setDevCode(await fetchCapturedAuthCode(email));
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
    setVerifying(true);
    setError(undefined);
    const result = await authClient.signIn.emailOtp({ email, otp: code });
    setVerifying(false);

    if (result.error) {
      setCode("");
      setError(
        "That code is invalid or expired. Request a new code if needed.",
      );
      return;
    }

    markBrowserSignInCompleted();
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
            <button
              className="primary-button"
              disabled={sendingCode}
              type="submit"
            >
              {sendingCode ? "Sending…" : "Send sign-in code"}
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
              <button
                className="primary-button"
                disabled={sendingCode || verifying}
                type="submit"
              >
                {verifying
                  ? "Verifying…"
                  : invitationSignIn
                    ? "Continue to invitation"
                    : proposalSignIn
                      ? "Return to proposal"
                      : "Open my board"}
              </button>
              <button
                className="text-button"
                disabled={sendingCode || verifying}
                onClick={() => void sendCode()}
                type="button"
              >
                {sendingCode ? "Resending…" : "Resend code"}
              </button>
              <button
                className="text-button"
                disabled={sendingCode || verifying}
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

async function beginEmailSignIn(email: string, returnTo: string) {
  const result = await authClient.emailOtp.sendVerificationOtp({
    email,
    type: "sign-in",
  });
  if (!result.error) {
    window.sessionStorage.setItem(pendingSignInKey(returnTo), email);
  }
  return result;
}

async function fetchCapturedAuthCode(
  email: string,
): Promise<string | undefined> {
  const response = await fetch(
    `/api/dev/auth-code?email=${encodeURIComponent(email)}`,
  );
  if (!response.ok) return;
  const captured: unknown = await response.json();
  return typeof captured === "object" &&
    captured !== null &&
    "code" in captured &&
    typeof captured.code === "string"
    ? captured.code
    : undefined;
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
              <p>{formatEventDateRange(event.startsOn, event.endsOn)}</p>
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
        trackBrowserEvent("event_created");
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
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timezone,
  }).format(new Date());

  function update<K extends keyof EventInput>(field: K, value: EventInput[K]) {
    setInput((current) => ({
      ...current,
      [field]: value,
      ...(field === "startsOn" && current.endsOn === ""
        ? { endsOn: value }
        : {}),
    }));
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
                min={today}
                onChange={(event) => update("startsOn", event.target.value)}
                type="date"
                value={input.startsOn}
              />
            </Field>
            <Field label="Ends" name="endsOn">
              <input
                id="endsOn"
                min={input.startsOn || today}
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
  const workspace = useQuery(trpc.events.workspace.queryOptions({ slug }));

  if (workspace.isPending) return <FullPageStatus label="Opening event Home" />;
  if (workspace.isError)
    return (
      <div className="page">
        <BoardStatus
          label="Event Home unavailable"
          detail={workspace.error.message}
        />
      </div>
    );

  const { event, attention, reviewer, statuses } = workspace.data;
  return (
    <div className="page event-home">
      <div className="event-home-heading">
        <div className="eyebrow">Event Home</div>
        <h1>{event.name}</h1>
        <div className="event-meta">
          <span>{formatEventDateRange(event.startsOn, event.endsOn)}</span>
          <span>{event.timezone}</span>
          <span>{event.access}</span>
        </div>
      </div>
      {reviewer && !event.permissions.includes("organizer") ? (
        <ReviewerHome reviewer={reviewer} slug={slug} />
      ) : (
        <>
          <section className="attention-panel">
            <div className="attention-heading">
              <div>
                <div className="eyebrow">Needs attention</div>
                <h2>Act on what blocks the event.</h2>
              </div>
              <span>
                {attention.reduce((sum, item) => sum + item.count, 0)}
              </span>
            </div>
            {attention.length === 0 ? (
              <div className="on-track">
                <strong>Everything is on track</strong>
                <span>No current event state needs action.</span>
              </div>
            ) : (
              <div className="attention-list">
                {attention.map((item) => (
                  <Link
                    className={`attention-item attention-${item.severity}`}
                    key={item.key}
                    to={item.href}
                  >
                    <span className="attention-signal">
                      {item.severity === "critical"
                        ? "Action required"
                        : "Check soon"}
                    </span>
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.detail}</p>
                    </div>
                    <span aria-hidden="true">→</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
          <section className="status-section">
            <div className="eyebrow">Event status</div>
            <div className="status-grid">
              {statuses.map((status) => (
                <Link
                  className="status-card"
                  key={status.key}
                  to={`/events/${slug}/${status.href}`}
                >
                  <span>{status.label}</span>
                  <strong>{status.value}</strong>
                  <p>{status.detail}</p>
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function ReviewerHome({
  reviewer,
  slug,
}: {
  reviewer: {
    roundStatus: string;
    remaining: number;
    assigned: number;
    cfpDeadline: string | null;
  };
  slug: string;
}) {
  return (
    <section className="reviewer-home">
      <div className="eyebrow">Your review round</div>
      <div className="reviewer-home-grid">
        <div>
          <span>Round</span>
          <strong>{reviewer.roundStatus}</strong>
        </div>
        <div>
          <span>Reviews remaining</span>
          <strong>{reviewer.remaining}</strong>
        </div>
        <div>
          <span>Assigned</span>
          <strong>{reviewer.assigned}</strong>
        </div>
        <div>
          <span>CFP deadline</span>
          <strong>
            {reviewer.cfpDeadline
              ? reviewer.cfpDeadline.slice(0, 10)
              : "Not available"}
          </strong>
        </div>
      </div>
      <Link
        className="primary-button link-button"
        to={`/events/${slug}/review`}
      >
        My reviews
      </Link>
    </section>
  );
}

function EventTeamPage() {
  const { slug = "" } = useParams();
  const trpc = useTRPC();
  const workspace = useQuery(trpc.events.workspace.queryOptions({ slug }));
  if (workspace.isPending) return <FullPageStatus label="Opening event team" />;
  if (workspace.isError || workspace.data.event.access !== "owner")
    return (
      <div className="page">
        <BoardStatus
          label="Team unavailable"
          detail="Only the event owner can manage the event team."
        />
      </div>
    );
  return (
    <div className="page team-page">
      <EventTeamPanel slug={slug} />
    </div>
  );
}

function EventSettingsPage() {
  const { slug = "" } = useParams();
  const trpc = useTRPC();
  const event = useQuery(trpc.events.get.queryOptions({ slug }));
  if (event.isPending) return <FullPageStatus label="Opening event settings" />;
  if (event.isError)
    return (
      <div className="page">
        <BoardStatus
          label="Settings unavailable"
          detail={event.error.message}
        />
      </div>
    );
  if (event.data.access === "reviewer")
    return (
      <div className="page">
        <BoardStatus
          label="Settings unavailable"
          detail="Only the event owner or an organizer can manage event settings."
        />
      </div>
    );
  return <EventSettingsForm event={event.data} key={event.data.slug} />;
}

function EventSettingsForm({
  event,
}: {
  event: {
    access: "owner" | "organizer" | "reviewer";
    name: string;
    slug: string;
    startsOn: string;
    endsOn: string;
    timezone: string;
    revision: number;
  };
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [input, setInput] = useState<EventSettingsInput>({
    name: event.name,
    slug: event.slug,
    startsOn: event.startsOn,
    endsOn: event.endsOn,
    timezone: event.timezone,
    expectedRevision: event.revision,
  });
  const [validationError, setValidationError] = useState<string>();
  const updateSettings = useMutation(
    trpc.events.updateSettings.mutationOptions({
      onSuccess: async (saved) => {
        setInput({
          name: saved.name,
          slug: saved.slug,
          startsOn: saved.startsOn,
          endsOn: saved.endsOn,
          timezone: saved.timezone,
          expectedRevision: saved.revision,
        });
        await Promise.all([
          queryClient.invalidateQueries(
            trpc.events.get.queryFilter({ slug: event.slug }),
          ),
          queryClient.invalidateQueries(
            trpc.events.workspace.queryFilter({ slug: event.slug }),
          ),
          queryClient.invalidateQueries(trpc.events.list.queryFilter()),
        ]);
      },
    }),
  );
  const updateStatus = useMutationStatuses([
    {
      mutation: updateSettings,
      mutationKey: trpc.events.updateSettings.mutationKey(),
      success: "Event settings saved",
    },
  ]);

  function update<K extends keyof EventSettingsInput>(
    field: K,
    value: EventSettingsInput[K],
  ) {
    setInput((current) => ({ ...current, [field]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = eventSettingsInputSchema.safeParse(input);
    if (!parsed.success) {
      setValidationError(formatEventValidationError(parsed.error.issues[0]));
      return;
    }

    setValidationError(undefined);
    updateSettings.mutate(parsed.data);
  }

  return (
    <div className="page">
      <section className="review-heading">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>{event.name}</h1>
          <p>
            {formatEventDateRange(event.startsOn, event.endsOn)} ·{" "}
            {event.timezone}
          </p>
        </div>
      </section>
      <MutationStatus
        error={updateStatus.error}
        success={updateStatus.success}
      />
      <form className="form-board settings-form" onSubmit={submit}>
        <Field label="Event name" name="settings-name">
          <input
            disabled={updateSettings.isPending}
            id="settings-name"
            onChange={(change) => update("name", change.target.value)}
            required
            value={input.name}
          />
        </Field>
        <div className="field-pair">
          <Field label="Starts" name="settings-startsOn">
            <input
              disabled={updateSettings.isPending}
              id="settings-startsOn"
              onChange={(change) => update("startsOn", change.target.value)}
              required
              type="date"
              value={input.startsOn}
            />
          </Field>
          <Field label="Ends" name="settings-endsOn">
            <input
              disabled={updateSettings.isPending}
              id="settings-endsOn"
              min={input.startsOn}
              onChange={(change) => update("endsOn", change.target.value)}
              required
              type="date"
              value={input.endsOn}
            />
          </Field>
        </div>
        <Field
          hint="All deadlines and agenda times use this zone"
          label="Timezone"
          name="settings-timezone"
        >
          <select
            disabled={updateSettings.isPending}
            id="settings-timezone"
            onChange={(change) => update("timezone", change.target.value)}
            value={input.timezone}
          >
            {listTimezones().map((timezone) => (
              <option key={timezone} value={timezone}>
                {timezone}
              </option>
            ))}
          </select>
        </Field>
        {(validationError || updateSettings.error) && (
          <p className="form-error" role="alert">
            {validationError ?? updateSettings.error?.message}
          </p>
        )}
        <button
          className="primary-button"
          disabled={updateSettings.isPending}
          type="submit"
        >
          {updateSettings.isPending ? "Saving…" : "Save event settings"}
        </button>
      </form>
    </div>
  );
}

function CommunicationSettingsPage() {
  const { slug = "" } = useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refreshTemplates = () =>
    queryClient.invalidateQueries(
      trpc.communications.templates.queryFilter({ slug }),
    );
  const update = useMutation(
    trpc.communications.updateTemplate.mutationOptions({
      onSuccess: refreshTemplates,
    }),
  );
  const retry = useMutation(
    trpc.communications.retry.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries(
          trpc.communications.failures.queryFilter({ slug }),
        ),
    }),
  );
  const communicationStatus = useMutationStatuses([
    {
      mutation: update,
      mutationKey: trpc.communications.updateTemplate.mutationKey(),
      success: "Template saved",
    },
    {
      mutation: retry,
      mutationKey: trpc.communications.retry.mutationKey(),
      success: "Delivery retry queued",
    },
  ]);
  return (
    <div className="page">
      <section className="review-heading">
        <div>
          <div className="eyebrow">Communications</div>
          <h1>Keep every message moving.</h1>
          <p>Edit future messages or recover failed delivery.</p>
        </div>
      </section>
      <nav aria-label="Communications" className="local-navigation">
        <NavLink end to={`/events/${slug}/communications`}>
          Templates
        </NavLink>
        <NavLink to={`/events/${slug}/communications/deliveries`}>
          Deliveries
        </NavLink>
      </nav>
      <MutationStatus
        error={communicationStatus.error}
        success={communicationStatus.success}
      />
      <Routes>
        <Route
          index
          element={
            <CommunicationTemplatesPage
              pendingFor={(purpose) =>
                communicationStatus.isPendingFor(update, "purpose", purpose)
              }
              save={(purpose, subject, body, expectedRevision) =>
                update.mutate({
                  slug,
                  purpose,
                  subject,
                  body,
                  expectedRevision,
                })
              }
              slug={slug}
            />
          }
        />
        <Route
          path="deliveries"
          element={
            <CommunicationDeliveriesPage
              pendingFor={(communicationId) =>
                communicationStatus.isPendingFor(
                  retry,
                  "communicationId",
                  communicationId,
                )
              }
              retry={(communicationId) =>
                retry.mutate({ slug, communicationId })
              }
              slug={slug}
            />
          }
        />
      </Routes>
    </div>
  );
}

function CommunicationTemplatesPage({
  pendingFor,
  save,
  slug,
}: {
  pendingFor: (purpose: string) => boolean;
  save: (
    purpose: CommunicationPurpose,
    subject: string,
    body: string,
    expectedRevision: number,
  ) => void;
  slug: string;
}) {
  const trpc = useTRPC();
  const templates = useQuery(
    trpc.communications.templates.queryOptions({ slug }),
  );
  if (templates.isPending) return <BoardStatus label="Loading templates" />;
  if (templates.isError)
    return (
      <BoardStatus
        label="Templates unavailable"
        detail={templates.error.message}
      />
    );
  return (
    <section className="communications-section">
      <div className="section-introduction">
        <h2>Message templates</h2>
        <p>Changes apply only to communications created afterward.</p>
      </div>
      <div className="review-list">
        {templates.data.map((template) => (
          <CommunicationTemplateForm
            key={`${slug}:${template.purpose}`}
            onSave={(subject, body) =>
              save(template.purpose, subject, body, template.revision)
            }
            pending={pendingFor(template.purpose)}
            template={template}
          />
        ))}
      </div>
    </section>
  );
}

function CommunicationDeliveriesPage({
  pendingFor,
  retry,
  slug,
}: {
  pendingFor: (communicationId: string) => boolean;
  retry: (communicationId: string) => void;
  slug: string;
}) {
  const trpc = useTRPC();
  const failures = useQuery(
    trpc.communications.failures.queryOptions({ slug }),
  );
  if (failures.isPending) return <BoardStatus label="Loading deliveries" />;
  if (failures.isError)
    return (
      <BoardStatus
        label="Deliveries unavailable"
        detail={failures.error.message}
      />
    );
  return (
    <section className="assignment-cards communications-section">
      <div className="section-introduction">
        <h2>Failed delivery</h2>
        <p>Retry recoverable failures. Terminal failures remain visible.</p>
      </div>
      {failures.data.length === 0 ? (
        <BoardStatus
          label="Delivery is clear"
          detail="No communication needs a retry."
        />
      ) : (
        failures.data.map((failure) => (
          <article className="task-card" key={failure.communicationId}>
            <div>
              <div className="eyebrow">{failure.purpose}</div>
              <h3>{failure.subject}</h3>
              <p>{failure.error}</p>
            </div>
            {failure.status === "failed" ? (
              <button
                className="text-button"
                disabled={pendingFor(failure.communicationId)}
                onClick={() => retry(failure.communicationId)}
                type="button"
              >
                {pendingFor(failure.communicationId)
                  ? "Queuing…"
                  : "Retry delivery"}
              </button>
            ) : (
              <span className="eyebrow">Not retryable</span>
            )}
          </article>
        ))
      )}
    </section>
  );
}

function CommunicationTemplateForm({
  onSave,
  pending,
  template,
}: {
  onSave: (subject: string, body: string) => void;
  pending: boolean;
  template: {
    purpose: string;
    subject: string;
    body: string;
    revision: number;
  };
}) {
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  return (
    <form
      className="form-board"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(subject, body);
      }}
    >
      <div className="eyebrow">{template.purpose.replaceAll("_", " ")}</div>
      <Field label="Subject" name={`subject-${template.purpose}`}>
        <input
          id={`subject-${template.purpose}`}
          onChange={(event) => setSubject(event.target.value)}
          value={subject}
        />
      </Field>
      <Field label="Body" name={`body-${template.purpose}`}>
        <textarea
          id={`body-${template.purpose}`}
          onChange={(event) => setBody(event.target.value)}
          value={body}
        />
      </Field>
      <button className="primary-button" disabled={pending} type="submit">
        {pending ? "Saving…" : `Save revision ${template.revision + 1}`}
      </button>
    </form>
  );
}

function OrganizerReadinessPage({
  view,
}: {
  view: "overview" | "definitions" | "assignments";
}) {
  const { slug = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const board = useQuery(
    trpc.onboarding.organizerBoard.queryOptions(
      { slug },
      { refetchInterval: ONBOARDING_REFETCH_INTERVAL_MS },
    ),
  );
  const communicationFailures = useQuery(
    trpc.communications.failures.queryOptions(
      { slug },
      { enabled: view === "assignments" },
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
  const onboardingStatus = useMutationStatuses([
    {
      mutation: createDefinition,
      mutationKey: trpc.onboarding.createDefinition.mutationKey(),
      success: "Task definition created",
    },
    {
      mutation: createAssignment,
      mutationKey: trpc.onboarding.createAssignment.mutationKey(),
      success: "Assignment created",
    },
    {
      mutation: recordReminder,
      mutationKey: trpc.onboarding.recordReminder.mutationKey(),
      success: "Reminder queued",
    },
    {
      mutation: reopen,
      mutationKey: trpc.onboarding.reopen.mutationKey(),
      success: "Assignment reopened",
    },
    {
      mutation: waive,
      mutationKey: trpc.onboarding.waive.mutationKey(),
      success: "Assignment waived",
    },
    {
      mutation: override,
      mutationKey: trpc.onboarding.override.mutationKey(),
      success: "Organizer override recorded",
    },
    {
      mutation: cancelAssignment,
      mutationKey: trpc.onboarding.cancelAssignment.mutationKey(),
      success: "Assignment canceled",
    },
    {
      mutation: rejectEvidence,
      mutationKey: trpc.onboarding.rejectEvidence.mutationKey(),
      success: "Evidence rejected",
    },
  ]);
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
  const [assignmentTimeError, setAssignmentTimeError] = useState<string>();

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
  const eventWindow = board.data.event;
  const assignmentFilters = {
    target: searchParams.get("target") ?? "all",
    due: searchParams.get("due") ?? "all",
    completion: searchParams.get("completion") ?? "all",
  };
  const assignmentTargetOptions = onboardingAssignmentTargetOptions(
    board.data.targets,
  );
  const filterNow = board.dataUpdatedAt;
  const filteredAssignments = board.data.assignments.filter((item) => {
    const target = assignmentTargetValue(item);
    const dueMatches =
      assignmentFilters.due === "all" ||
      (assignmentFilters.due === "none" && !item.dueAt) ||
      (assignmentFilters.due === "overdue" &&
        item.dueAt !== null &&
        Date.parse(item.dueAt) < filterNow) ||
      (assignmentFilters.due === "upcoming" &&
        item.dueAt !== null &&
        Date.parse(item.dueAt) >= filterNow);
    const completionMatches =
      assignmentFilters.completion === "all" ||
      (assignmentFilters.completion === "complete" && item.completed) ||
      (assignmentFilters.completion === "incomplete" && !item.completed);
    return (
      (assignmentFilters.target === "all" ||
        assignmentFilters.target === target) &&
      dueMatches &&
      completionMatches
    );
  });
  const viewCopy = {
    overview: {
      eyebrow: "Readiness overview",
      title: "Act on what is blocking the program.",
      detail: "Completion comes from current evidence, not a status checkbox.",
    },
    definitions: {
      eyebrow: "Task definitions",
      title: "Define each reusable requirement.",
      detail:
        "Definitions set the scope and evidence that assignments require.",
    },
    assignments: {
      eyebrow: "Task assignments",
      title: "Assign and resolve readiness work.",
      detail: "Target accepted work, review evidence, and handle exceptions.",
    },
  }[view];

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
    const dueAtResolution = assignment.dueAt
      ? resolveEventLocalDateTime({
          localDateTime: assignment.dueAt,
          timezone: eventWindow.timezone,
        })
      : undefined;
    if (dueAtResolution?.status === "invalid") {
      setAssignmentTimeError(
        "Choose a due time that exists in the event timezone.",
      );
      return;
    }
    if (dueAtResolution?.status === "ambiguous") {
      setAssignmentTimeError(
        "Choose a due time that occurs once in the event timezone.",
      );
      return;
    }
    setAssignmentTimeError(undefined);
    createAssignment.mutate({
      slug,
      taskDefinitionId: selectedDefinition.id,
      target,
      required: assignment.required,
      dueAt: dueAtResolution?.iso ?? null,
    });
  }

  function reasonFor(action: string): string | undefined {
    const reason = window.prompt(`Reason to ${action}`)?.trim();
    return reason || undefined;
  }

  function updateAssignmentFilter(
    name: "target" | "due" | "completion",
    value: string,
  ) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === "all") next.delete(name);
      else next.set(name, value);
      return next;
    });
  }

  return (
    <div className="page onboarding-page">
      <Link className="arrow-link" to={`/events/${slug}`}>
        ← Back to event
      </Link>
      <section className="review-heading">
        <div>
          <div className="eyebrow">{viewCopy.eyebrow}</div>
          <h1>{viewCopy.title}</h1>
          <p>{viewCopy.detail}</p>
        </div>
      </section>
      <nav aria-label="Readiness" className="readiness-navigation">
        <NavLink end to={`/events/${slug}/readiness`}>
          Overview
        </NavLink>
        <NavLink to={`/events/${slug}/readiness/task-definitions`}>
          Task definitions
        </NavLink>
        <NavLink to={`/events/${slug}/readiness/task-assignments`}>
          Task assignments
        </NavLink>
      </nav>
      {onboardingStatus.error && (
        <MutationStatus error={onboardingStatus.error} />
      )}
      {onboardingStatus.success && (
        <MutationStatus success={onboardingStatus.success} />
      )}
      {view === "assignments" &&
        communicationFailures.data?.some(
          (failure) => failure.purpose === "task_reminder",
        ) && (
          <p className="form-error" role="alert">
            A task reminder failed. Open communications to retry delivery.
          </p>
        )}
      {view === "assignments" && communicationFailures.isError && (
        <p className="form-error" role="alert">
          Reminder delivery status is unavailable. Try again before you leave
          task assignments.
        </p>
      )}
      {view === "definitions" && (
        <div className="onboarding-builders readiness-definition-layout">
          <form className="form-board" onSubmit={addDefinition}>
            <div className="eyebrow">New task definition</div>
            <h2>Define the readiness task</h2>
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
              {createDefinition.isPending
                ? "Creating…"
                : "Create task definition"}
            </button>
          </form>
          <section
            aria-labelledby="definitions-title"
            className="definition-list"
          >
            <div className="eyebrow">Existing definitions</div>
            <h2 id="definitions-title">Reusable requirements</h2>
            {board.data.definitions.length === 0 ? (
              <p>No task definitions yet.</p>
            ) : (
              board.data.definitions.map((candidate) => (
                <article className="definition-row" key={candidate.id}>
                  <strong>{candidate.name}</strong>
                  <span>
                    {formatTaskScope(candidate.scope)} ·{" "}
                    {formatCompletionMechanism(candidate.completionMechanism)}
                  </span>
                </article>
              ))
            )}
          </section>
        </div>
      )}
      {view === "assignments" && (
        <div className="onboarding-builders readiness-assignment-layout">
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
            <Field
              hint={`Event runs ${formatEventDateRange(eventWindow.startsOn, eventWindow.endsOn)} · ${eventWindow.timezone}`}
              label="Due date and time"
              name="assignment-due"
            >
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
              {assignmentTimeError && (
                <span className="form-error" role="alert">
                  {assignmentTimeError}
                </span>
              )}
              {assignment.dueAt.slice(0, 10) > eventWindow.endsOn && (
                <span className="form-warning" role="status">
                  The due date is after the event ends. Check this is
                  intentional.
                </span>
              )}
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
              {createAssignment.isPending ? "Creating…" : "Create assignment"}
            </button>
          </form>
        </div>
      )}
      {view === "overview" && (
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
                    ? formatDeadline(item.nextDueAt, eventWindow.timezone)
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
                    ? formatDeadline(speaker.nextDueAt, eventWindow.timezone)
                    : "No due date"}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {view === "assignments" && (
        <section className="assignment-cards">
          <div className="assignment-filters" aria-label="Assignment filters">
            <label>
              <span>Target</span>
              <select
                aria-label="Filter by target"
                onChange={(event) =>
                  updateAssignmentFilter("target", event.target.value)
                }
                value={assignmentFilters.target}
              >
                <option value="all">All targets</option>
                {assignmentTargetOptions.map((target) => (
                  <option key={target.value} value={target.value}>
                    {target.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Due state</span>
              <select
                aria-label="Filter by due state"
                onChange={(event) =>
                  updateAssignmentFilter("due", event.target.value)
                }
                value={assignmentFilters.due}
              >
                <option value="all">All</option>
                <option value="overdue">Overdue</option>
                <option value="upcoming">Upcoming</option>
                <option value="none">No due date</option>
              </select>
            </label>
            <label>
              <span>Completion state</span>
              <select
                aria-label="Filter by completion state"
                onChange={(event) =>
                  updateAssignmentFilter("completion", event.target.value)
                }
                value={assignmentFilters.completion}
              >
                <option value="all">All</option>
                <option value="incomplete">Incomplete</option>
                <option value="complete">Complete</option>
              </select>
            </label>
          </div>
          <p className="assignment-filter-count" role="status">
            Showing {filteredAssignments.length} of{" "}
            {board.data.assignments.length} assignments
          </p>
          {filteredAssignments.length === 0 && (
            <BoardStatus
              label="No assignments match"
              detail="Change a filter to see other readiness assignments."
            />
          )}
          {filteredAssignments.map((item) => (
            <article className="task-card" key={item.id}>
              <div>
                <div className="eyebrow">
                  Revision {item.completionRevision}
                </div>
                <h3>{item.name}</h3>
                <p>
                  {item.required ? "Required" : "Optional"} ·{" "}
                  {item.completionMechanism}
                </p>
                <p>
                  Target: {assignmentTargetLabel(item, board.data.targets)} ·{" "}
                  {item.dueAt
                    ? `Due ${formatDeadline(item.dueAt, eventWindow.timezone)}`
                    : "No due date"}
                </p>
                {item.lastReminderAt && (
                  <p>
                    Last reminder queued{" "}
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
                  disabled={onboardingStatus.isPendingFor(
                    recordReminder,
                    "assignmentId",
                    item.id,
                  )}
                  onClick={() =>
                    recordReminder.mutate({ assignmentId: item.id })
                  }
                  type="button"
                >
                  {onboardingStatus.isPendingFor(
                    recordReminder,
                    "assignmentId",
                    item.id,
                  )
                    ? "Sending…"
                    : "Send reminder"}
                </button>
                <button
                  className="text-button"
                  disabled={onboardingStatus.isPendingFor(
                    reopen,
                    "assignmentId",
                    item.id,
                  )}
                  onClick={() => {
                    const reason = reasonFor("reopen this assignment");
                    if (reason)
                      reopen.mutate({ assignmentId: item.id, reason });
                  }}
                  type="button"
                >
                  {onboardingStatus.isPendingFor(
                    reopen,
                    "assignmentId",
                    item.id,
                  )
                    ? "Reopening…"
                    : "Reopen"}
                </button>
                <button
                  className="text-button"
                  disabled={onboardingStatus.isPendingFor(
                    waive,
                    "assignmentId",
                    item.id,
                  )}
                  onClick={() => {
                    const reason = reasonFor("waive this assignment");
                    if (reason) waive.mutate({ assignmentId: item.id, reason });
                  }}
                  type="button"
                >
                  {onboardingStatus.isPendingFor(waive, "assignmentId", item.id)
                    ? "Waiving…"
                    : "Waive"}
                </button>
                <button
                  className="text-button"
                  disabled={onboardingStatus.isPendingFor(
                    override,
                    "assignmentId",
                    item.id,
                  )}
                  onClick={() => {
                    const reason = reasonFor("override this assignment");
                    if (reason)
                      override.mutate({ assignmentId: item.id, reason });
                  }}
                  type="button"
                >
                  {onboardingStatus.isPendingFor(
                    override,
                    "assignmentId",
                    item.id,
                  )
                    ? "Overriding…"
                    : "Organizer override"}
                </button>
                <button
                  className="text-button"
                  disabled={onboardingStatus.isPendingFor(
                    cancelAssignment,
                    "assignmentId",
                    item.id,
                  )}
                  onClick={() => {
                    if (window.confirm("Cancel this assignment?")) {
                      cancelAssignment.mutate({ assignmentId: item.id });
                    }
                  }}
                  type="button"
                >
                  {onboardingStatus.isPendingFor(
                    cancelAssignment,
                    "assignmentId",
                    item.id,
                  )
                    ? "Canceling…"
                    : "Cancel assignment"}
                </button>
              </div>
              <EvidenceHistory
                evidence={item.evidence}
                onReject={(evidenceId) => {
                  const reason = reasonFor("reject this evidence");
                  if (reason) rejectEvidence.mutate({ evidenceId, reason });
                }}
                pendingEvidenceId={
                  item.evidence.find((evidence) =>
                    onboardingStatus.isPendingFor(
                      rejectEvidence,
                      "evidenceId",
                      evidence.id,
                    ),
                  )?.id
                }
                timezone={eventWindow.timezone}
              />
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

function formatTaskScope(
  scope: "event_speaker" | "program_item" | "program_item_speaker",
): string {
  if (scope === "event_speaker") return "Event-speaker task";
  if (scope === "program_item") return "Program-item task";
  return "Program-item-speaker task";
}

function formatCompletionMechanism(
  mechanism: "manual" | "profile" | "form" | "file",
): string {
  if (mechanism === "manual") return "Manual confirmation";
  if (mechanism === "profile") return "Speaker profile";
  if (mechanism === "form") return "Form response";
  return "File upload";
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

function onboardingAssignmentTargetOptions(targets: {
  speakers: Array<{ userId: string; name: string }>;
  programItems: Array<{
    id: string;
    title: string;
    speakers: Array<{ id: string; name: string }>;
  }>;
}) {
  return [
    ...onboardingTargetOptions(targets, "event_speaker"),
    ...onboardingTargetOptions(targets, "program_item"),
    ...onboardingTargetOptions(targets, "program_item_speaker"),
  ];
}

function assignmentTargetValue(assignment: {
  targetUserId: string | null;
  targetProgramItemId: string | null;
  targetSubmissionSpeakerId: string | null;
}): string {
  if (assignment.targetUserId)
    return `event_speaker:${assignment.targetUserId}`;
  if (assignment.targetProgramItemId)
    return `program_item:${assignment.targetProgramItemId}`;
  return `program_item_speaker:${assignment.targetSubmissionSpeakerId}`;
}

function assignmentTargetLabel(
  assignment: Parameters<typeof assignmentTargetValue>[0],
  targets: Parameters<typeof onboardingAssignmentTargetOptions>[0],
): string {
  const value = assignmentTargetValue(assignment);
  return (
    onboardingAssignmentTargetOptions(targets).find(
      (target) => target.value === value,
    )?.label ?? "Unavailable target"
  );
}

type TaskEvidence = {
  id: string;
  kind: string;
  createdAt: string;
  rejectedReason: string | null;
  supersededBy: string | null;
  fileId: string | null;
  fileName: string | null;
};

function EvidenceHistory({
  evidence,
  onReject,
  pendingEvidenceId,
  timezone,
}: {
  evidence: TaskEvidence[];
  onReject?: (evidenceId: string) => void;
  pendingEvidenceId?: string | undefined;
  timezone: string;
}) {
  if (evidence.length === 0) return null;
  const fileEvidence = evidence
    .filter(
      (item): item is TaskEvidence & { fileId: string; fileName: string } =>
        Boolean(item.fileId && item.fileName),
    )
    .toSorted(
      (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
    );
  const versions = new Map(
    fileEvidence.map((item, index) => [item.id, index + 1]),
  );
  const latestFile = fileEvidence.findLast((item) => !item.supersededBy);
  return (
    <div className="evidence-history">
      <div className="eyebrow">Evidence history</div>
      {evidence.map((item) => (
        <div className="evidence-row" key={item.id}>
          <span>
            {item.fileName && item.fileId ? (
              <>
                <strong>Version {versions.get(item.id)}</strong> ·{" "}
                <a href={`/api/task-files/${item.fileId}`}>{item.fileName}</a>
                {latestFile?.id === item.id && (
                  <span className="latest-file">Latest</span>
                )}
              </>
            ) : (
              item.kind
            )}
          </span>
          <span>
            {item.fileId && (
              <time dateTime={item.createdAt}>
                Uploaded {formatDeadline(item.createdAt, timezone)}
              </time>
            )}
            {item.rejectedReason
              ? `${item.fileId ? " · " : ""}Rejected: ${item.rejectedReason}`
              : item.supersededBy
                ? `${item.fileId ? " · " : ""}Superseded`
                : !item.fileId
                  ? "Current history"
                  : ""}
          </span>
          {onReject && !item.rejectedReason && !item.supersededBy && (
            <button
              className="text-button"
              disabled={pendingEvidenceId === item.id}
              onClick={() => onReject(item.id)}
              type="button"
            >
              {pendingEvidenceId === item.id ? "Rejecting…" : "Reject"}
            </button>
          )}
        </div>
      ))}
    </div>
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
    trpc.onboarding.confirmManual.mutationOptions({
      onSuccess: async () => {
        trackBrowserEvent("onboarding_task_completed");
        await refresh();
      },
    }),
  );
  const saveDraft = useMutation(
    trpc.onboarding.saveFormDraft.mutationOptions(),
  );
  const submitForm = useMutation(
    trpc.onboarding.submitForm.mutationOptions({
      onSuccess: async () => {
        trackBrowserEvent("onboarding_task_completed");
        await refresh();
      },
    }),
  );
  const upload = useMutation(
    trpc.onboarding.uploadFile.mutationOptions({
      onSuccess: async () => {
        trackBrowserEvent("onboarding_task_completed");
        await refresh();
      },
      onSettled: () => setUploadingFor(undefined),
    }),
  );
  const taskStatus = useMutationStatuses([
    {
      mutation: confirm,
      mutationKey: trpc.onboarding.confirmManual.mutationKey(),
      success: "Task confirmed",
    },
    {
      mutation: saveDraft,
      mutationKey: trpc.onboarding.saveFormDraft.mutationKey(),
      success: "Draft saved",
    },
    {
      mutation: submitForm,
      mutationKey: trpc.onboarding.submitForm.mutationKey(),
      success: "Response submitted",
    },
    {
      mutation: upload,
      mutationKey: trpc.onboarding.uploadFile.mutationKey(),
      success: "File uploaded",
    },
  ]);
  const [answers, setAnswers] = useState<
    Record<string, Record<string, string>>
  >({});
  const [uploadingFor, setUploadingFor] = useState<string>();
  const [uploadError, setUploadError] = useState<string>();
  const [eventFilter, setEventFilter] = useState("all");

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
    try {
      await saveDraft.mutateAsync({
        assignmentId,
        answers: answers[assignmentId] ?? savedAnswers ?? {},
      });
      await submitForm.mutateAsync({ assignmentId });
    } catch {
      return;
    }
  }

  async function uploadFile(assignmentId: string, file: File | undefined) {
    if (!file || uploadingFor) return;
    setUploadError(undefined);
    if (file.size > MAX_STORED_FILE_BYTES) {
      setUploadError("Choose a file no larger than 10 MB.");
      return;
    }
    setUploadingFor(assignmentId);
    try {
      const contentBase64 = await browserFileToBase64(file);
      upload.mutate({
        assignmentId,
        fileName: file.name,
        contentType: file.type || "application/octet-stream",
        contentBase64,
      });
    } catch {
      setUploadingFor(undefined);
      setUploadError("The file could not be read. Choose it again.");
    }
  }

  const filteredTasks = tasks.data.filter(
    (task) => eventFilter === "all" || task.eventSlug === eventFilter,
  );
  const taskEvents = [
    ...new Map(
      tasks.data.map((task) => [task.eventSlug, task.eventName]),
    ).entries(),
  ];

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
      <MutationStatus
        error={taskStatus.error ?? uploadError}
        success={taskStatus.success}
      />
      {taskEvents.length > 1 && (
        <label className="task-event-filter">
          <span>Filter by event</span>
          <select
            onChange={(event) => setEventFilter(event.target.value)}
            value={eventFilter}
          >
            <option value="all">All events</option>
            {taskEvents.map(([slug, name]) => (
              <option key={slug} value={slug}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {tasks.data.length === 0 && (
        <BoardStatus
          label="No onboarding tasks"
          detail="Accepted program work and assigned requirements will appear here."
        />
      )}
      <section className="assignment-cards">
        {filteredTasks.map((task) => {
          const fields = task.formFields ?? [];
          return (
            <article className="task-card" key={task.id}>
              <div>
                <div className="eyebrow">
                  {task.eventName} · {task.required ? "Required" : "Optional"} ·
                  Revision {task.completionRevision}
                </div>
                <h2>{task.name}</h2>
                <p>
                  {task.dueAt
                    ? `Due ${formatDeadline(task.dueAt, task.eventTimezone)}`
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
                  disabled={taskStatus.isPendingFor(
                    confirm,
                    "assignmentId",
                    task.id,
                  )}
                  onClick={() => confirm.mutate({ assignmentId: task.id })}
                  type="button"
                >
                  {taskStatus.isPendingFor(confirm, "assignmentId", task.id)
                    ? "Confirming…"
                    : "Confirm complete"}
                </button>
              )}
              {task.completionMechanism === "file" && (
                <Field
                  hint="Any file type up to 10 MB"
                  label="Upload current file"
                  name={`file-${task.id}`}
                >
                  <input
                    disabled={Boolean(uploadingFor)}
                    id={`file-${task.id}`}
                    onChange={(event) =>
                      void uploadFile(task.id, event.target.files?.[0])
                    }
                    type="file"
                  />
                  {uploadingFor === task.id && (
                    <span className="upload-pending" role="status">
                      Uploading…
                    </span>
                  )}
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
                    {saveDraft.isPending
                      ? "Saving…"
                      : submitForm.isPending
                        ? "Submitting…"
                        : "Submit response"}
                  </button>
                </form>
              )}
              <EvidenceHistory
                evidence={task.evidence}
                timezone={task.eventTimezone}
              />
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

type LocalProposalFile = { file: File; uploadId: string };

const PROPOSAL_FILE_DATABASE = "openboard-proposal-files";
const PROPOSAL_FILE_STORE = "files";

async function saveLocalProposalFile(
  draftId: string,
  fieldKey: string,
  value: LocalProposalFile,
) {
  const database = await openProposalFileDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PROPOSAL_FILE_STORE, "readwrite");
    transaction
      .objectStore(PROPOSAL_FILE_STORE)
      .put(value, `${draftId}:${fieldKey}`);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("The local file could not be saved."),
      );
  });
  database.close();
}

async function loadLocalProposalFiles(draftId: string) {
  const database = await openProposalFileDatabase();
  const entries = await new Promise<Array<[string, LocalProposalFile]>>(
    (resolve, reject) => {
      const request = database
        .transaction(PROPOSAL_FILE_STORE)
        .objectStore(PROPOSAL_FILE_STORE)
        .openCursor();
      const files: Array<[string, LocalProposalFile]> = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(files);
          return;
        }
        if (typeof cursor.key !== "string") {
          cursor.continue();
          return;
        }
        const key = cursor.key;
        if (key.startsWith(`${draftId}:`)) {
          files.push([
            key.slice(draftId.length + 1),
            cursor.value as LocalProposalFile,
          ]);
        }
        cursor.continue();
      };
      request.onerror = () =>
        reject(
          request.error ?? new Error("The local files could not be read."),
        );
    },
  );
  database.close();
  return Object.fromEntries(entries);
}

async function deleteLocalProposalFiles(draftId: string) {
  const database = await openProposalFileDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PROPOSAL_FILE_STORE, "readwrite");
    const request = transaction.objectStore(PROPOSAL_FILE_STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (
        typeof cursor.key === "string" &&
        cursor.key.startsWith(`${draftId}:`)
      ) {
        cursor.delete();
      }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("The local files could not be cleared."),
      );
  });
  database.close();
}

function openProposalFileDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(PROPOSAL_FILE_DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(PROPOSAL_FILE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error("The local file database could not open."),
      );
  });
}

function acceptedBrowserFile(acceptedTypes: string[], contentType: string) {
  const normalized = contentType.toLowerCase();
  return acceptedTypes.some(
    (accepted) =>
      accepted === normalized ||
      (accepted.endsWith("/*") && normalized.startsWith(accepted.slice(0, -1))),
  );
}

function formatAcceptedTypes(acceptedTypes: string[]) {
  return acceptedTypes.join(", ");
}

type ReviewPageMode = "overview" | "assignments" | "decisions" | "my-reviews";
type ReviewSort = "original" | "average-desc" | "average-asc";
type ReviewRoundState = "draft" | "open" | "closed" | "published-lock";

function ReviewPage() {
  const { slug = "" } = useParams();
  const location = useLocation();
  const trpc = useTRPC();
  const event = useQuery(trpc.events.get.queryOptions({ slug }));
  const requestedPath = reviewPathFromLocation(location.pathname);
  const mutationStatus = useReviewMutationStatus([
    {
      mutationKey: trpc.reviews.openRound.mutationKey(),
      success: "Reviewing opened",
    },
    {
      mutationKey: trpc.reviews.closeRound.mutationKey(),
      success: "Reviewing closed",
    },
    {
      mutationKey: trpc.reviews.reopenRound.mutationKey(),
      success: "Round reopened",
    },
    {
      mutationKey: trpc.reviews.assign.mutationKey(),
      success: "Reviewer assigned",
    },
    {
      mutationKey: trpc.reviews.revokeAssignment.mutationKey(),
      success: "Assignment revoked",
    },
    {
      mutationKey: trpc.decisions.queue.mutationKey(),
      success: "Outcome queued",
    },
    {
      mutationKey: trpc.decisions.publish.mutationKey(),
      success: "Decisions published",
    },
    {
      mutationKey: trpc.reviews.save.mutationKey(),
      success: "Review saved",
    },
  ]);

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

  const target = reviewLandingPath(slug, requestedPath, event.data.permissions);
  if (target !== location.pathname) return <Navigate to={target} replace />;

  const mode = reviewMode(requestedPath);

  return (
    <>
      <MutationStatus
        error={mutationStatus.error}
        success={mutationStatus.success}
      />
      {mode === "my-reviews" ? (
        <ReviewerAssignments permissions={event.data.permissions} slug={slug} />
      ) : (
        <OrganizerReviewBoard
          mode={mode}
          permissions={event.data.permissions}
          slug={slug}
        />
      )}
    </>
  );
}

function useReviewMutationStatus(
  entries: Array<{ mutationKey: MutationKey; success: string }>,
): { error?: string; success?: string } {
  const [mountedAt] = useState(Date.now);
  const [expiredAttempt, setExpiredAttempt] = useState<number>();
  const attempts = useMutationState<{
    mutationKey: MutationKey;
    status: "idle" | "pending" | "success" | "error";
    submittedAt: number;
    error: string | null;
  }>({
    filters: {
      predicate: (mutation) =>
        entries.some(
          (entry) =>
            hashKey(entry.mutationKey) ===
            hashKey(mutation.options.mutationKey ?? []),
        ),
    },
    select: (mutation) => ({
      mutationKey: mutation.options.mutationKey ?? [],
      status: mutation.state.status,
      submittedAt: mutation.state.submittedAt,
      error:
        mutation.state.error instanceof Error
          ? mutation.state.error.message
          : null,
    }),
  });
  const latest = attempts
    .filter((attempt) => attempt.submittedAt >= mountedAt)
    .toSorted((left, right) => right.submittedAt - left.submittedAt)[0];
  const entry = latest
    ? entries.find(
        (candidate) =>
          hashKey(candidate.mutationKey) === hashKey(latest.mutationKey),
      )
    : undefined;
  useEffect(() => {
    if (latest?.status !== "success") return;
    const timer = window.setTimeout(
      () => setExpiredAttempt(latest.submittedAt),
      4_000,
    );
    return () => window.clearTimeout(timer);
  }, [latest]);
  if (latest?.status === "error") {
    return { error: latest.error ?? "The action could not be completed." };
  }
  return latest?.status === "success" &&
    latest.submittedAt !== expiredAttempt &&
    entry
    ? { success: entry.success }
    : {};
}

function reviewPathFromLocation(pathname: string): ReviewPath {
  const path = pathname.match(
    /\/review(?:\/(?:assignments|decisions|my-reviews))?$/,
  )?.[0];
  return (path?.slice(1) as ReviewPath | undefined) ?? "review";
}

function reviewMode(path: ReviewPath): ReviewPageMode {
  if (path === "review/assignments") return "assignments";
  if (path === "review/decisions") return "decisions";
  if (path === "review/my-reviews") return "my-reviews";
  return "overview";
}

function ReviewLocalNavigation({
  permissions,
  slug,
}: {
  permissions: Array<"organizer" | "reviewer">;
  slug: string;
}) {
  const organizer = permissions.includes("organizer");
  const reviewer = permissions.includes("reviewer");
  return (
    <nav aria-label="Review navigation" className="review-navigation">
      {organizer && (
        <>
          <NavLink end to={`/events/${slug}/review`}>
            Overview
          </NavLink>
          <NavLink to={`/events/${slug}/review/assignments`}>
            Assignments
          </NavLink>
          <NavLink to={`/events/${slug}/review/decisions`}>Decisions</NavLink>
        </>
      )}
      {reviewer && (
        <NavLink to={`/events/${slug}/review/my-reviews`}>My reviews</NavLink>
      )}
    </nav>
  );
}

function OrganizerReviewBoard({
  mode,
  permissions,
  slug,
}: {
  mode: Exclude<ReviewPageMode, "my-reviews">;
  permissions: Array<"organizer" | "reviewer">;
  slug: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const board = useQuery(trpc.reviews.organizerBoard.queryOptions({ slug }));
  const communicationFailures = useQuery(
    trpc.communications.failures.queryOptions({ slug }),
  );
  const refresh = async () => {
    await queryClient.invalidateQueries(
      trpc.reviews.organizerBoard.queryFilter({ slug }),
    );
    await queryClient.invalidateQueries(
      trpc.reviews.mine.queryFilter({ slug }),
    );
  };
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
      onSuccess: async (_result, input) => {
        trackBrowserEvent("decision_published");
        setSelectedForPublication({});
        await refresh();
        await queryClient.invalidateQueries(
          trpc.onboarding.organizerBoard.queryFilter({ slug }),
        );
        await queryClient.invalidateQueries(
          trpc.agendas.working.queryFilter({ slug }),
        );
        await queryClient.invalidateQueries(
          trpc.submissions.list.queryFilter(),
        );
        await Promise.all(
          input.selections.map(({ submissionId }) =>
            queryClient.invalidateQueries(
              trpc.submissions.get.queryFilter({ submissionId }),
            ),
          ),
        );
      },
    }),
  );
  const reviewBoardStatus = useMutationStatuses([
    {
      mutation: openRound,
      mutationKey: trpc.reviews.openRound.mutationKey(),
      success: "Reviewing opened",
    },
    {
      mutation: closeRound,
      mutationKey: trpc.reviews.closeRound.mutationKey(),
      success: "Reviewing closed",
    },
    {
      mutation: reopenRound,
      mutationKey: trpc.reviews.reopenRound.mutationKey(),
      success: "Round reopened",
    },
    {
      mutation: assign,
      mutationKey: trpc.reviews.assign.mutationKey(),
      success: "Reviewer assigned",
    },
    {
      mutation: revoke,
      mutationKey: trpc.reviews.revokeAssignment.mutationKey(),
      success: "Assignment revoked",
    },
    {
      mutation: queue,
      mutationKey: trpc.decisions.queue.mutationKey(),
      success: "Outcome queued",
    },
    {
      mutation: publish,
      mutationKey: trpc.decisions.publish.mutationKey(),
      success: "Decisions published",
    },
  ]);
  const [reviewerBySubmission, setReviewerBySubmission] = useState<
    Record<string, string>
  >({});
  const [reviewSort, setReviewSort] = useState<ReviewSort>("original");

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
  const submissions =
    mode !== "overview" || reviewSort === "original"
      ? board.data.submissions
      : board.data.submissions
          .map((submission, index) => ({ submission, index }))
          .toSorted((left, right) => {
            const leftAverage = left.submission.review.average;
            const rightAverage = right.submission.review.average;
            if (leftAverage === null) {
              return rightAverage === null ? left.index - right.index : 1;
            }
            if (rightAverage === null) return -1;
            const direction = reviewSort === "average-asc" ? 1 : -1;
            return (
              (leftAverage - rightAverage) * direction ||
              left.index - right.index
            );
          })
          .map(({ submission }) => submission);
  const roundState = board.data.round.state;
  const roundIsClosed =
    roundState === "closed" || roundState === "published-lock";

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
          <div className="eyebrow">
            {mode === "overview"
              ? "Review round"
              : mode === "assignments"
                ? "Reviewer assignments"
                : "Program decisions"}
          </div>
          <h1>
            {mode === "overview"
              ? board.data.round.name
              : mode === "assignments"
                ? "Put every proposal in good hands."
                : "Queue first. Publish together."}
          </h1>
          <p>
            {reviewSummary(
              mode,
              board.data.submissions.length,
              board.data.reviewers.length,
              queued.length,
            )}
          </p>
        </div>
        {mode === "overview" && (
          <div className="round-control">
            <div className="round-state">
              <span className={`status-chip status-${roundState}`}>
                {roundState === "published-lock"
                  ? "Published lock"
                  : roundState}
              </span>
              {roundState === "draft" && <span>Reviewing has not opened.</span>}
              {roundState === "closed" && <span>Reviewing is closed.</span>}
              {roundState === "published-lock" && (
                <span>
                  Outcomes are published. This review round is permanently
                  locked and cannot reopen.
                </span>
              )}
            </div>
            {roundState === "draft" && (
              <button
                className="primary-button"
                disabled={openRound.isPending}
                onClick={() => openRound.mutate({ slug })}
                type="button"
              >
                {openRound.isPending ? "Opening…" : "Open reviewing"}
              </button>
            )}
            {roundState === "open" && (
              <button
                className="primary-button"
                disabled={closeRound.isPending}
                onClick={closeWithConfirmation}
                type="button"
              >
                {closeRound.isPending ? "Closing…" : "Close reviewing"}
              </button>
            )}
            {roundState === "closed" && (
              <button
                className="text-button"
                disabled={reopenRound.isPending}
                onClick={() => reopenRound.mutate({ slug })}
                type="button"
              >
                {reopenRound.isPending ? "Reopening…" : "Reopen round"}
              </button>
            )}
          </div>
        )}
      </section>
      <ReviewLocalNavigation permissions={permissions} slug={slug} />
      {mode === "overview" && board.data.submissions.length > 1 && (
        <label className="review-sort">
          Sort proposals
          <select
            onChange={(event) =>
              setReviewSort(event.target.value as ReviewSort)
            }
            value={reviewSort}
          >
            <option value="original">Submission order</option>
            <option value="average-desc">Average, high to low</option>
            <option value="average-asc">Average, low to high</option>
          </select>
        </label>
      )}
      {mode === "assignments" && board.data.reviewers.length > 0 && (
        <section aria-label="Reviewer progress" className="reviewer-progress">
          <div className="eyebrow">Reviewer progress</div>
          <div className="reviewer-progress-list">
            {board.data.reviewers.map((reviewer) => (
              <div className="reviewer-progress-row" key={reviewer.id}>
                <span>{reviewer.name || reviewer.email}</span>
                <strong>
                  {reviewer.completed}/{reviewer.assigned} reviewed
                </strong>
              </div>
            ))}
          </div>
        </section>
      )}
      {mode === "decisions" &&
        communicationFailures.data?.some((failure) =>
          failure.purpose.startsWith("decision_"),
        ) && (
          <p className="form-error" role="alert">
            A decision message failed. Open communications to retry delivery.
          </p>
        )}
      {mode === "decisions" && communicationFailures.isError && (
        <p className="form-error" role="alert">
          Decision delivery status is unavailable. Try again before you leave
          review.
        </p>
      )}
      {board.data.submissions.length === 0 && (
        <BoardStatus
          label="No proposals to review"
          detail="Open the CFP and wait for the first final submission."
        />
      )}
      <div className="review-list">
        {submissions.map((submission) => {
          const hasPublishedDecision =
            submission.decision.status === "accepted" ||
            submission.decision.status === "declined";
          return (
            <article
              className={`review-proposal review-proposal-${mode}`}
              key={submission.id}
            >
              <div className="review-proposal-copy">
                <div className="eyebrow">
                  {submission.track} · {submission.format}
                </div>
                <h2>{submission.title}</h2>
                <p>{submission.abstract}</p>
                <SubmissionFileLinks files={submission.fileAnswers} />
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
                {mode === "overview" &&
                  submission.review.assignments.some(
                    (assignment) => assignment.score !== null,
                  ) && (
                    <div className="saved-reviews">
                      <div className="eyebrow">Saved reviews</div>
                      {submission.review.assignments.flatMap((assignment) =>
                        assignment.score === null ? (
                          []
                        ) : (
                          <blockquote key={assignment.id}>
                            <div>
                              <strong>
                                {assignment.reviewerName ||
                                  assignment.reviewerEmail}
                              </strong>
                              <span>Score {assignment.score}</span>
                            </div>
                            <p>
                              {assignment.comment || "No comment provided."}
                            </p>
                          </blockquote>
                        ),
                      )}
                    </div>
                  )}
              </div>
              {mode !== "overview" && (
                <div className="review-controls">
                  {mode === "decisions" && (
                    <>
                      <Field
                        label="Internal outcome"
                        name={`decision-${submission.id}`}
                      >
                        <select
                          disabled={
                            hasPublishedDecision ||
                            submission.status === "withdrawn" ||
                            reviewBoardStatus.isPendingFor(
                              queue,
                              "submissionId",
                              submission.id,
                            )
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
                          <option value="accept_queued">
                            Queue acceptance
                          </option>
                          <option value="decline_queued">Queue decline</option>
                          {hasPublishedDecision && (
                            <option value={submission.decision.status}>
                              {submission.decision.status}
                            </option>
                          )}
                        </select>
                      </Field>
                      {roundIsClosed &&
                        submission.decision.status.endsWith("_queued") && (
                          <label className="publication-selection">
                            <input
                              checked={Boolean(
                                selectedForPublication[submission.id],
                              )}
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
                    </>
                  )}
                  {mode === "assignments" &&
                    !hasPublishedDecision &&
                    submission.status === "active" &&
                    !roundIsClosed && (
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
                            reviewBoardStatus.isPendingFor(
                              assign,
                              "submissionId",
                              submission.id,
                            )
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
                          {reviewBoardStatus.isPendingFor(
                            assign,
                            "submissionId",
                            submission.id,
                          )
                            ? "Assigning…"
                            : "Assign"}
                        </button>
                      </div>
                    )}
                  {mode === "assignments" && (
                    <div className="assignment-list">
                      {submission.review.assignments.map((assignment) => (
                        <div className="assignment-row" key={assignment.id}>
                          <span>
                            {assignment.reviewerName ||
                              assignment.reviewerEmail}{" "}
                            · {assignment.score ?? "not scored"}
                          </span>
                          {!roundIsClosed && (
                            <button
                              className="text-button"
                              disabled={reviewBoardStatus.isPendingFor(
                                revoke,
                                "assignmentId",
                                assignment.id,
                              )}
                              onClick={() =>
                                revoke.mutate({
                                  slug,
                                  assignmentId: assignment.id,
                                })
                              }
                              type="button"
                            >
                              {reviewBoardStatus.isPendingFor(
                                revoke,
                                "assignmentId",
                                assignment.id,
                              )
                                ? "Revoking…"
                                : "Revoke"}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {mode === "decisions" && roundIsClosed && queued.length > 0 && (
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
    </div>
  );
}

function reviewSummary(
  mode: Exclude<ReviewPageMode, "my-reviews">,
  proposals: number,
  reviewers: number,
  queued: number,
): string {
  if (mode === "assignments") {
    return `${proposals} ${pluralize(proposals, "proposal")} · ${reviewers} active ${pluralize(reviewers, "reviewer")}`;
  }
  if (mode === "decisions") {
    return `${queued} of ${proposals} ${pluralize(proposals, "outcome")} queued`;
  }
  return `${proposals} ${pluralize(proposals, "proposal")} · ${queued} queued ${pluralize(queued, "outcome")}`;
}

function ReviewerAssignments({
  permissions,
  slug,
}: {
  permissions: Array<"organizer" | "reviewer">;
  slug: string;
}) {
  const trpc = useTRPC();
  const assignments = useQuery(trpc.reviews.mine.queryOptions({ slug }));

  if (assignments.isPending) {
    return <FullPageStatus label="Opening assignments" />;
  }
  if (assignments.isError) {
    return (
      <div className="page">
        <BoardStatus
          label="Assignments unavailable"
          detail={assignments.error.message}
        />
      </div>
    );
  }

  return (
    <section className="page review-page">
      <Link className="arrow-link" to={`/events/${slug}`}>
        ← Back to event
      </Link>
      <div className="review-heading">
        <div>
          <div className="eyebrow">Your blinded assignments</div>
          <h1>Read the work, not the name.</h1>
          <p>Scores remain editable while the review round is open.</p>
        </div>
      </div>
      <ReviewLocalNavigation permissions={permissions} slug={slug} />
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
    roundState: ReviewRoundState;
    submission: {
      id: string;
      title: string;
      abstract: string;
      format: string;
      track: string;
      fileAnswers: Array<
        Pick<StoredFile, "contentType" | "fileName" | "sizeBytes" | "url"> & {
          id: string;
          fieldKey: string;
        }
      >;
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
      onSuccess: async () => {
        if (!assignment.review) trackBrowserEvent("review_completed");
        await queryClient.invalidateQueries(
          trpc.reviews.mine.queryFilter({ slug }),
        );
        await queryClient.invalidateQueries(
          trpc.reviews.organizerBoard.queryFilter({ slug }),
        );
      },
    }),
  );
  const editable = assignment.roundState === "open";
  const unavailableMessage =
    assignment.roundState === "published-lock"
      ? "Score and comment controls are permanently unavailable because outcomes from this review round are published."
      : assignment.roundState === "draft"
        ? "Score and comment controls are unavailable until an organizer opens this review round."
        : assignment.roundState === "closed"
          ? "Score and comment controls are unavailable because this review round is closed."
          : undefined;
  const unavailableMessageId = `review-unavailable-${assignment.assignmentId}`;
  const saveMessage = save.isPending
    ? "Saving review…"
    : save.isSuccess &&
        save.variables.score === score &&
        (save.variables.comment ?? "") === (comment.trim() || "")
      ? "Review saved"
      : undefined;
  const saveErrorMessage =
    save.error?.data?.code === "CONFLICT"
      ? save.error.message
      : "Review could not be saved. Your score and comment are still here. Try again.";

  return (
    <article className="review-proposal reviewer-card">
      <div className="review-proposal-copy">
        <div className="eyebrow">
          {assignment.submission.track} · {assignment.submission.format}
        </div>
        <h2>{assignment.submission.title}</h2>
        <p>{assignment.submission.abstract}</p>
        <SubmissionFileLinks files={assignment.submission.fileAnswers} />
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
        {unavailableMessage && (
          <p className="review-unavailable" id={unavailableMessageId}>
            {unavailableMessage}
          </p>
        )}
        <Field label="Score" name={`score-${assignment.assignmentId}`}>
          <select
            aria-describedby={
              unavailableMessage ? unavailableMessageId : undefined
            }
            disabled={!editable}
            id={`score-${assignment.assignmentId}`}
            onChange={(event) => {
              save.reset();
              setScore(Number(event.target.value));
            }}
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
            aria-describedby={
              unavailableMessage ? unavailableMessageId : undefined
            }
            disabled={!editable}
            id={`comment-${assignment.assignmentId}`}
            maxLength={5000}
            onChange={(event) => {
              save.reset();
              setComment(event.target.value);
            }}
            value={comment}
          />
        </Field>
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
        {save.isError ? (
          <p className="review-save-status review-save-error" role="alert">
            {saveErrorMessage}
          </p>
        ) : saveMessage ? (
          <p className="review-save-status" role="status">
            {saveMessage}
          </p>
        ) : null}
      </form>
    </article>
  );
}

function SubmissionFileLinks({
  files,
}: {
  files: Array<
    Pick<StoredFile, "fileName" | "url"> & { id: string; fieldKey: string }
  >;
}) {
  if (files.length === 0) return null;
  return (
    <div className="submission-files">
      <div className="eyebrow">Files</div>
      {files.map((file) => (
        <a href={file.url} key={file.id}>
          {file.fileName}
        </a>
      ))}
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
  const revokeStatus = useMutationStatuses([
    {
      mutation: revoke,
      mutationKey: trpc.eventTeam.revokeRole.mutationKey(),
      success: "Role revoked",
    },
    {
      mutation: revokeInvitation,
      mutationKey: trpc.eventTeam.revokeInvitation.mutationKey(),
      success: "Invitation revoked",
    },
  ]);

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
          {invite.error && (
            <p className="form-error" role="alert">
              {invite.error.message}
            </p>
          )}
          <MutationStatus
            error={revokeStatus.error}
            success={revokeStatus.success}
          />
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
                  {member.userId !== team.data.owner?.id && (
                    <button
                      className="text-button"
                      disabled={revokeStatus.isPendingFor(
                        revoke,
                        "roleId",
                        member.id,
                      )}
                      onClick={() =>
                        revoke.mutate({
                          slug,
                          roleId: member.id,
                        })
                      }
                      type="button"
                    >
                      {revokeStatus.isPendingFor(revoke, "roleId", member.id)
                        ? "Revoking…"
                        : "Revoke"}
                    </button>
                  )}
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
                      disabled={revokeStatus.isPendingFor(
                        revokeInvitation,
                        "invitationId",
                        invitation.id,
                      )}
                      onClick={() =>
                        revokeInvitation.mutate({
                          slug,
                          invitationId: invitation.id,
                        })
                      }
                      type="button"
                    >
                      {revokeStatus.isPendingFor(
                        revokeInvitation,
                        "invitationId",
                        invitation.id,
                      )
                        ? "Revoking…"
                        : "Revoke"}
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

function TracksPage() {
  const { slug = "" } = useParams();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const event = useQuery(trpc.events.get.queryOptions({ slug }));
  const tracks = useQuery(trpc.tracks.list.queryOptions({ slug }));
  const cfp = useQuery(trpc.cfps.getSetup.queryOptions({ slug }));
  const refreshTracks = async () => {
    await queryClient.invalidateQueries(trpc.tracks.list.queryFilter({ slug }));
    await queryClient.invalidateQueries(
      trpc.cfps.publicByEventSlug.queryFilter({ slug }),
    );
  };
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
  const optionStatus = useMutationStatuses([
    {
      mutation: createTrack,
      mutationKey: trpc.tracks.create.mutationKey(),
      success: "Track created",
    },
    {
      mutation: updateTrack,
      mutationKey: trpc.tracks.update.mutationKey(),
      success: "Track renamed",
    },
    {
      mutation: archiveTrack,
      mutationKey: trpc.tracks.archive.mutationKey(),
      success: "Track archived",
    },
    {
      mutation: reorderTracks,
      mutationKey: trpc.tracks.reorder.mutationKey(),
      success: "Tracks reordered",
    },
  ]);

  if (event.isPending || tracks.isPending || cfp.isPending) {
    return <FullPageStatus label="Opening tracks" />;
  }
  const error = event.error ?? tracks.error ?? cfp.error;
  if (error) {
    return (
      <div className="page">
        <BoardStatus label="Tracks unavailable" detail={error.message} />
      </div>
    );
  }
  if (!event.data || !tracks.data || cfp.data === undefined) {
    return <FullPageStatus label="Opening tracks" />;
  }
  const structureLocked = Boolean(
    cfp.data.open?.structureLocked || cfp.data.draft?.structureLocked,
  );

  return (
    <FocusedOptionPage
      eventName={event.data.name}
      mutationError={optionStatus.error}
      mutationSuccess={optionStatus.success}
      title="Tracks"
    >
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
        archiving={(id) =>
          optionStatus.isPendingFor(archiveTrack, "trackId", id)
        }
        renaming={(id) => optionStatus.isPendingFor(updateTrack, "trackId", id)}
        reordering={reorderTracks.isPending}
        onCreate={(name) => createTrack.mutateAsync({ slug, name })}
        onRename={(id, name) => updateTrack.mutate({ slug, trackId: id, name })}
        onArchive={(id) => {
          if (window.confirm("Archive this track?")) {
            archiveTrack.mutate({ slug, trackId: id });
          }
        }}
        onReorder={(orderedIds) => reorderTracks.mutate({ slug, orderedIds })}
      />
    </FocusedOptionPage>
  );
}

function RoomsPage() {
  const { slug = "" } = useParams();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const event = useQuery(trpc.events.get.queryOptions({ slug }));
  const rooms = useQuery(trpc.rooms.list.queryOptions({ slug }));
  const refreshRooms = async () => {
    await queryClient.invalidateQueries(trpc.rooms.list.queryFilter({ slug }));
    await queryClient.invalidateQueries(
      trpc.agendas.working.queryFilter({ slug }),
    );
  };
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
  const optionStatus = useMutationStatuses([
    {
      mutation: createRoom,
      mutationKey: trpc.rooms.create.mutationKey(),
      success: "Room created",
    },
    {
      mutation: updateRoom,
      mutationKey: trpc.rooms.update.mutationKey(),
      success: "Room renamed",
    },
    {
      mutation: archiveRoom,
      mutationKey: trpc.rooms.archive.mutationKey(),
      success: "Room archived",
    },
    {
      mutation: reorderRooms,
      mutationKey: trpc.rooms.reorder.mutationKey(),
      success: "Rooms reordered",
    },
  ]);

  if (event.isPending || rooms.isPending) {
    return <FullPageStatus label="Opening rooms" />;
  }
  const error = event.error ?? rooms.error;
  if (error) {
    return (
      <div className="page">
        <BoardStatus label="Rooms unavailable" detail={error.message} />
      </div>
    );
  }
  if (!event.data || !rooms.data) {
    return <FullPageStatus label="Opening rooms" />;
  }

  return (
    <FocusedOptionPage
      eventName={event.data.name}
      mutationError={optionStatus.error}
      mutationSuccess={optionStatus.success}
      title="Rooms"
    >
      <OptionEditor
        creating={createRoom.isPending}
        disabled={false}
        title="Rooms"
        detail="Rooms define where agenda items can be placed."
        error={
          createRoom.error ??
          updateRoom.error ??
          archiveRoom.error ??
          reorderRooms.error
        }
        items={rooms.data}
        archiving={(id) => optionStatus.isPendingFor(archiveRoom, "roomId", id)}
        renaming={(id) => optionStatus.isPendingFor(updateRoom, "roomId", id)}
        reordering={reorderRooms.isPending}
        onCreate={(name) => createRoom.mutateAsync({ slug, name })}
        onRename={(id, name) => updateRoom.mutate({ slug, roomId: id, name })}
        onArchive={(id) => {
          if (window.confirm("Archive this room?")) {
            archiveRoom.mutate({ slug, roomId: id });
          }
        }}
        onReorder={(orderedIds) => reorderRooms.mutate({ slug, orderedIds })}
      />
    </FocusedOptionPage>
  );
}

function FocusedOptionPage({
  children,
  eventName,
  mutationError,
  mutationSuccess,
  title,
}: {
  children: ReactNode;
  eventName: string;
  mutationError: string | undefined;
  mutationSuccess: string | undefined;
  title: string;
}) {
  return (
    <div className="page setup-page">
      <section className="page-heading setup-heading">
        <div>
          <div className="eyebrow">{eventName}</div>
          <h1>{title}</h1>
        </div>
      </section>
      <MutationStatus error={mutationError} success={mutationSuccess} />
      <div className="focused-option-board">{children}</div>
    </div>
  );
}

function CfpManagePage() {
  const { slug = "" } = useParams();
  const trpc = useTRPC();
  const event = useQuery(trpc.events.get.queryOptions({ slug }));
  const cfp = useQuery(trpc.cfps.getSetup.queryOptions({ slug }));

  if (event.isPending || cfp.isPending) {
    return <FullPageStatus label="Opening CFP management" />;
  }
  const error = event.error ?? cfp.error;
  if (error) {
    return (
      <div className="page">
        <BoardStatus
          label="CFP management unavailable"
          detail={error.message}
        />
      </div>
    );
  }
  if (!event.data || cfp.data === undefined) {
    return <FullPageStatus label="Opening CFP management" />;
  }

  return (
    <div className="page setup-page">
      <section className="page-heading setup-heading">
        <div>
          <div className="eyebrow">Program intake</div>
          <h1>{event.data.name} CFP</h1>
        </div>
      </section>
      {cfp.data.open && (
        <CfpBuilder
          cfp={cfp.data.open}
          key="open-cfp"
          endsOn={event.data.endsOn}
          slug={slug}
          startsOn={event.data.startsOn}
          timezone={event.data.timezone}
        />
      )}
      <CfpBuilder
        cfp={cfp.data.draft}
        key={`draft-${cfp.data.open?.id ?? "none"}`}
        endsOn={event.data.endsOn}
        slug={slug}
        startsOn={event.data.startsOn}
        timezone={event.data.timezone}
      />
    </div>
  );
}

function OptionEditor({
  archiving,
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
  renaming,
  reordering,
}: {
  archiving: (id: string) => boolean;
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
  renaming: (id: string) => boolean;
  reordering: boolean;
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
              disabled={disabled || renaming(item.id)}
              name="name"
              aria-label={`${singular} name: ${item.name}`}
            />
            <button
              className="mini-button"
              disabled={disabled || renaming(item.id)}
              type="submit"
            >
              {renaming(item.id) ? "Saving…" : "Save"}
            </button>
            <button
              className="mini-button"
              disabled={disabled || reordering || index === 0}
              aria-label={`Move ${item.name} up`}
              onClick={() => move(index, -1)}
              type="button"
            >
              {reordering ? "Moving…" : "Move up"}
            </button>
            <button
              className="mini-button"
              disabled={disabled || reordering || index === items.length - 1}
              aria-label={`Move ${item.name} down`}
              onClick={() => move(index, 1)}
              type="button"
            >
              {reordering ? "Moving…" : "Move down"}
            </button>
            <button
              className="mini-button danger-button"
              disabled={disabled || archiving(item.id)}
              onClick={() => onArchive(item.id)}
              type="button"
            >
              {archiving(item.id) ? "Archiving…" : "Archive"}
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
  const queryClient = useQueryClient();
  const invitation = useQuery(trpc.invitations.get.queryOptions({ secret }));
  const accept = useMutation(
    trpc.invitations.accept.mutationOptions({
      onSuccess: async (result) => {
        await queryClient.invalidateQueries(trpc.events.list.queryFilter());
        await queryClient.invalidateQueries(
          trpc.speakerProfile.getOwn.queryFilter(),
        );
        await queryClient.invalidateQueries(trpc.onboarding.mine.queryFilter());
        await queryClient.invalidateQueries(
          trpc.submissions.list.queryFilter(),
        );
        await queryClient.invalidateQueries(
          trpc.events.get.queryFilter({ slug: result.eventSlug }),
        );
        void navigate(`/events/${result.eventSlug}`, { replace: true });
      },
    }),
  );
  const decline = useMutation(trpc.invitations.decline.mutationOptions());
  const acceptanceKey = `openboard:pending-invitation-acceptance:${secret}`;
  const acceptanceStarted = useRef(false);
  const [switchAccount, setSwitchAccount] = useState<
    | { status: "idle" }
    | { status: "pending" }
    | { status: "error"; message: string }
  >({ status: "idle" });
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
    setSwitchAccount({ status: "pending" });
    const result = await authClient.signOut();
    if (result.error) {
      setSwitchAccount({
        status: "error",
        message: result.error.message ?? "Sign out failed. Try again.",
      });
      return;
    }
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
              disabled={switchAccount.status === "pending"}
              onClick={() => void signInWithInvitedEmail()}
              type="button"
            >
              {switchAccount.status === "pending"
                ? "Signing out…"
                : "Sign out and continue"}
            </button>
          </div>
        )}
        {switchAccount.status === "error" && (
          <p className="form-error" role="alert">
            {switchAccount.message}
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
  const queryClient = useQueryClient();
  const invitation = useQuery(
    trpc.submissionSpeakerInvitations.get.queryOptions({ secret }),
  );
  const accept = useMutation(
    trpc.submissionSpeakerInvitations.accept.mutationOptions({
      onSuccess: async (result) => {
        await queryClient.invalidateQueries(trpc.events.list.queryFilter());
        await queryClient.invalidateQueries(
          trpc.speakerProfile.getOwn.queryFilter(),
        );
        await queryClient.invalidateQueries(trpc.onboarding.mine.queryFilter());
        await queryClient.invalidateQueries(
          trpc.submissions.list.queryFilter(),
        );
        await queryClient.invalidateQueries(
          trpc.submissions.get.queryFilter({
            submissionId: result.submissionId,
          }),
        );
        void navigate(`/submissions/${result.submissionId}`, { replace: true });
      },
    }),
  );
  const decline = useMutation(
    trpc.submissionSpeakerInvitations.decline.mutationOptions(),
  );
  const [switchAccount, setSwitchAccount] = useState<
    | { status: "idle" }
    | { status: "pending" }
    | { status: "error"; message: string }
  >({ status: "idle" });

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
    setSwitchAccount({ status: "pending" });
    const result = await authClient.signOut();
    if (result.error) {
      setSwitchAccount({
        status: "error",
        message: result.error.message ?? "Sign out failed. Try again.",
      });
      return;
    }
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
              disabled={switchAccount.status === "pending"}
              onClick={() => void signInWithInvitedSpeakerEmail()}
              type="button"
            >
              {switchAccount.status === "pending"
                ? "Signing out…"
                : "Sign out and continue"}
            </button>
          </div>
        )}
        {switchAccount.status === "error" && (
          <p className="form-error" role="alert">
            {switchAccount.message}
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

function SpeakerProfilePage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const profileQuery = trpc.speakerProfile.getOwn.queryOptions();
  const profileState = useQuery(profileQuery);
  const [draft, setDraft] = useState<{
    values: SpeakerProfileInput;
    expectedRevision: number | null;
  }>();
  const [headshotFile, setHeadshotFile] = useState<{
    file: File;
    contentType: SpeakerHeadshotUpload["contentType"];
  }>();
  const [headshotPreviewUrl, setHeadshotPreviewUrl] = useState<string>();
  const [headshotError, setHeadshotError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const save = useMutation(
    trpc.speakerProfile.saveOwn.mutationOptions({
      onSuccess: async (saved) => {
        setDraft({
          values: { displayName: saved.displayName, bio: saved.bio },
          expectedRevision: saved.revision,
        });
        setHeadshotFile(undefined);
        setHeadshotPreviewUrl(undefined);
        queryClient.setQueryData(profileQuery.queryKey, (current) =>
          current
            ? { ...current, profile: saved, suggestedDisplayName: null }
            : current,
        );
        await queryClient.invalidateQueries(
          trpc.speakerProfile.getOwn.queryFilter(),
        );
        await queryClient.invalidateQueries(trpc.onboarding.mine.queryFilter());
        await queryClient.invalidateQueries(
          trpc.onboarding.organizerBoard.queryFilter(),
        );
        await queryClient.invalidateQueries(trpc.agendas.working.queryFilter());
      },
      onError: async (error) => {
        if (error.data?.code !== "CONFLICT") return;
        const latest = await queryClient.fetchQuery(profileQuery);
        setDraft({
          values: latest.profile
            ? {
                displayName: latest.profile.displayName,
                bio: latest.profile.bio,
              }
            : {
                displayName: latest.suggestedDisplayName ?? "",
                bio: "",
              },
          expectedRevision: latest.profile?.revision ?? null,
        });
        setHeadshotFile(undefined);
        setHeadshotPreviewUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return undefined;
        });
      },
    }),
  );
  const saveStatus = useMutationStatuses([
    {
      mutation: save,
      mutationKey: trpc.speakerProfile.saveOwn.mutationKey(),
      success: "Profile saved",
    },
  ]);
  useEffect(
    () => () => {
      if (headshotPreviewUrl) URL.revokeObjectURL(headshotPreviewUrl);
    },
    [headshotPreviewUrl],
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

  const current =
    draft?.values ??
    (profileState.data.profile
      ? {
          displayName: profileState.data.profile.displayName,
          bio: profileState.data.profile.bio,
        }
      : {
          displayName: profileState.data.suggestedDisplayName ?? "",
          bio: "",
        });
  function updateProfile(values: Partial<SpeakerProfileInput>) {
    setDraft((existing) => ({
      values: { ...(existing?.values ?? current), ...values },
      expectedRevision:
        existing?.expectedRevision ??
        profileState.data?.profile?.revision ??
        null,
    }));
  }
  function selectHeadshot(file?: File) {
    const contentType = speakerHeadshotUploadSchema.shape.contentType.safeParse(
      file?.type,
    );
    const valid =
      file && contentType.success && file.size <= MAX_STORED_FILE_BYTES;
    if (headshotPreviewUrl) URL.revokeObjectURL(headshotPreviewUrl);
    setHeadshotError(
      file && !valid
        ? "Choose a JPEG, PNG, or WebP image under 10 MB."
        : undefined,
    );
    setHeadshotFile(
      valid ? { file, contentType: contentType.data } : undefined,
    );
    setHeadshotPreviewUrl(valid ? URL.createObjectURL(file) : undefined);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (headshotError) return;
    const expectedRevision =
      draft?.expectedRevision ?? profileState.data?.profile?.revision ?? null;
    setIsSubmitting(true);
    let contentBase64: string | undefined;
    if (headshotFile) {
      try {
        contentBase64 = await browserFileToBase64(headshotFile.file);
      } catch {
        setHeadshotError("The headshot could not be read. Choose it again.");
        setIsSubmitting(false);
        return;
      }
    }
    setHeadshotError(undefined);
    try {
      await save.mutateAsync({
        ...current,
        expectedRevision,
        ...(headshotFile && contentBase64
          ? {
              headshot: {
                fileName: headshotFile.file.name,
                contentType: headshotFile.contentType,
                contentBase64,
              },
            }
          : {}),
      });
    } catch {
      return;
    } finally {
      setIsSubmitting(false);
    }
  }
  const pending = isSubmitting || save.isPending;
  const headshotUrl =
    headshotPreviewUrl ?? profileState.data.profile?.headshotUrl;

  return (
    <div className="page setup-page">
      <Link className="arrow-link" to="/">
        ← My events
      </Link>
      <section className="page-heading compact-heading">
        <div>
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
        </div>
      </section>
      <section className="form-board submission-form">
        <form onSubmit={(event) => void submit(event)}>
          <fieldset className="submission-fields" disabled={pending}>
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
            <Field
              hint="Optional. Add a biography when you are ready to publish one."
              label="Bio"
              name="speaker-profile-bio"
            >
              <textarea
                id="speaker-profile-bio"
                value={current.bio}
                onChange={(event) => updateProfile({ bio: event.target.value })}
              />
            </Field>
            <Field
              hint="JPEG, PNG, or WebP. Maximum size 10 MB."
              label="Headshot"
              name="speaker-profile-headshot"
            >
              {headshotUrl && (
                <div className="headshot-preview">
                  <img alt="Headshot preview" src={headshotUrl} />
                </div>
              )}
              <input
                accept="image/jpeg,image/png,image/webp"
                id="speaker-profile-headshot"
                onChange={(event) => selectHeadshot(event.target.files?.[0])}
                type="file"
              />
            </Field>
          </fieldset>
          {headshotError && (
            <p className="form-error" role="alert">
              {headshotError}
            </p>
          )}
          {saveStatus.error && <MutationStatus error={saveStatus.error} />}
          {saveStatus.success && (
            <MutationStatus success={saveStatus.success} />
          )}
          <div className="submission-actions">
            <button
              className="primary-button"
              disabled={pending || Boolean(headshotError)}
              type="submit"
            >
              {pending ? "Saving…" : "Save profile"}
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
  startsOn,
  timezone,
}: {
  cfp:
    | (CfpDefinitionInput & {
        id: string;
        status: "draft" | "open";
        structureLocked: boolean;
        publicationStatus: "draft" | "open" | "closed";
        publicationStatusRefreshMs?: number | null;
      })
    | null;
  endsOn: string;
  slug: string;
  startsOn: string;
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
      : emptyCfpDefinition(startsOn, endsOn, timezone),
  );
  const [deadlineLocalDateTime, setDeadlineLocalDateTime] = useState(() =>
    isoToEventLocalDateTime({
      instant: cfp?.deadline ?? definition.deadline,
      timezone,
    }),
  );
  const [validationError, setValidationError] = useState<{
    message: string;
    path: (string | number)[];
  }>();
  const refresh = async () => {
    await queryClient.invalidateQueries(
      trpc.cfps.getSetup.queryFilter({ slug }),
    );
    await queryClient.invalidateQueries(
      trpc.cfps.publicByEventSlug.queryFilter({ slug }),
    );
    await queryClient.invalidateQueries(
      trpc.events.workspace.queryFilter({ slug }),
    );
  };
  const create = useMutation(
    trpc.cfps.createDraft.mutationOptions({ onSuccess: refresh }),
  );
  const update = useMutation(
    trpc.cfps.updateDraft.mutationOptions({ onSuccess: refresh }),
  );
  const open = useMutation(
    trpc.cfps.open.mutationOptions({
      onSuccess: async () => {
        trackBrowserEvent("cfp_published");
        await refresh();
      },
    }),
  );
  const cfpStatus = useMutationStatuses([
    {
      mutation: create,
      mutationKey: trpc.cfps.createDraft.mutationKey(),
      success: "Draft created",
    },
    {
      mutation: update,
      mutationKey: trpc.cfps.updateDraft.mutationKey(),
      success: "CFP saved",
    },
    {
      mutation: open,
      mutationKey: trpc.cfps.open.mutationKey(),
      success: "CFP opened",
    },
  ]);
  const formId = cfp?.id ?? "new";
  const [deadlineBounds] = useState(() =>
    cfpDeadlineInputBounds({ endsOn, timezone }),
  );
  const storedDeadline = cfp
    ? isoToEventLocalDateTime({ instant: cfp.deadline, timezone })
    : undefined;
  const deadlineMin =
    deadlineLocalDateTime === storedDeadline &&
    storedDeadline < deadlineBounds.min
      ? storedDeadline
      : deadlineBounds.min;
  const displayStatus = cfp?.publicationStatus ?? "draft";
  const formLabel =
    displayStatus === "draft"
      ? "Draft configuration"
      : displayStatus === "open"
        ? "Public proposal form"
        : "Closed proposal form";

  useEffect(() => {
    if (!cfp?.publicationStatusRefreshMs) return;
    const timeout = window.setTimeout(
      () =>
        void queryClient.invalidateQueries(
          trpc.cfps.getSetup.queryFilter({ slug }),
        ),
      Math.min(cfp.publicationStatusRefreshMs + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(timeout);
  }, [cfp?.publicationStatusRefreshMs, queryClient, slug, trpc]);

  function parsedDefinition(input: {
    allowExpiredStoredDeadline: boolean;
  }): CfpDefinitionInput | undefined {
    const currentBounds = cfpDeadlineInputBounds({ endsOn, timezone });
    const resolution = resolveEventLocalDateTime({
      localDateTime: deadlineLocalDateTime,
      timezone,
    });
    const deadline =
      resolution.status === "resolved" ? resolution.iso : undefined;
    const deadlineError = deadlineInputError({
      deadline,
      localDateTime: deadlineLocalDateTime,
      max: currentBounds.max,
      min: currentBounds.min,
      allowExpired:
        input.allowExpiredStoredDeadline &&
        deadlineLocalDateTime === storedDeadline,
    });
    if (deadlineError) {
      setValidationError(deadlineError);
      return undefined;
    }
    const parsed = cfpDefinitionInputSchema.safeParse(definition);
    if (!parsed.success) {
      setValidationError(cfpValidationError(parsed.error.issues[0]));
      return undefined;
    }
    if (
      instantFallsAfterLocalDate({
        instant: parsed.data.deadline,
        localDate: endsOn,
        timezone,
      })
    ) {
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
    const parsed = parsedDefinition({
      allowExpiredStoredDeadline: Boolean(cfp),
    });
    if (!parsed) return;
    if (cfp) {
      update.mutate({
        slug,
        cfpId: cfp.id,
        expectedDeadline: cfp.deadline,
        ...parsed,
      });
    } else create.mutate({ slug, ...parsed });
  }

  function saveAndOpen() {
    const parsed = parsedDefinition({ allowExpiredStoredDeadline: false });
    if (!parsed) return;
    if (!cfp) {
      setValidationError({
        message: "Create the draft before opening it.",
        path: [],
      });
      return;
    }

    open.mutate({
      slug,
      cfpId: cfp.id,
      expectedDeadline: cfp.deadline,
      ...parsed,
    });
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

  const deadlineBeforeStart =
    definition.deadline !== "" &&
    instantFallsBeforeLocalDate({
      instant: definition.deadline,
      localDate: startsOn,
      timezone,
    });
  return (
    <section className="cfp-builder">
      <div className="builder-title">
        <div>
          <div className="eyebrow">{formLabel}</div>
          <h2>{cfp ? cfp.name : "Draft your CFP"}</h2>
        </div>
        {cfp && (
          <span className={`status-chip status-${displayStatus}`}>
            {displayStatus}
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
            <Field
              hint={`Event runs ${formatEventDateRange(startsOn, endsOn)} · ${timezone}`}
              label="Deadline"
              name={`cfp-deadline-${formId}`}
            >
              <input
                id={`cfp-deadline-${formId}`}
                max={deadlineBounds.max}
                min={deadlineMin}
                type="datetime-local"
                value={deadlineLocalDateTime}
                onChange={(event) => {
                  const localDateTime = event.target.value;
                  setDeadlineLocalDateTime(localDateTime);
                  const resolution = resolveEventLocalDateTime({
                    localDateTime,
                    timezone,
                  });
                  const deadline =
                    resolution.status === "resolved"
                      ? resolution.iso
                      : undefined;
                  setDefinition((current) => ({
                    ...current,
                    deadline: deadline ?? "",
                  }));
                  setValidationError(
                    deadlineInputError({
                      deadline,
                      localDateTime,
                      max: deadlineBounds.max,
                      min: deadlineBounds.min,
                      allowExpired: localDateTime === storedDeadline,
                    }),
                  );
                }}
                onInvalid={(event) =>
                  setValidationError(
                    deadlineInputError({
                      deadline: definition.deadline,
                      localDateTime: event.currentTarget.value,
                      max: deadlineBounds.max,
                      min: deadlineBounds.min,
                      allowExpired:
                        event.currentTarget.value === storedDeadline,
                    }),
                  )
                }
              />
              {deadlineBeforeStart && (
                <span className="form-warning" role="status">
                  The deadline is before the event starts. Check the CFP closes
                  when you intend.
                </span>
              )}
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
              <button
                disabled={cfp?.structureLocked}
                type="button"
                onClick={() => addField("file")}
              >
                + File
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
        {cfpStatus.error && <MutationStatus error={cfpStatus.error} />}
        {cfpStatus.success && <MutationStatus success={cfpStatus.success} />}
        {(validationError?.path[0] !== "customFields" || cfpStatus.error) &&
          validationError && (
            <p className="form-error" role="alert">
              {validationError.message}
            </p>
          )}
        <div className="builder-actions">
          <button
            className="primary-button"
            disabled={create.isPending || update.isPending}
            type="submit"
          >
            {create.isPending
              ? "Creating…"
              : update.isPending
                ? "Saving…"
                : cfp?.structureLocked
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
              {open.isPending
                ? "Publishing…"
                : "Publish CFP and open submissions"}
            </button>
          )}
          {displayStatus === "open" && (
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
          <Field
            hint="Separate types with commas, for example application/pdf or image/*"
            label="Accepted MIME types"
            name={fieldId("field-types")}
          >
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
              max="10"
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

const ABSTRACT_HINT =
  "Summarize what you will cover and what attendees will learn.";

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
  const [selectedFiles, setSelectedFiles] = useState<
    Record<string, LocalProposalFile>
  >({});
  const [fileError, setFileError] = useState<string>();
  const uploadFile = useMutation(trpc.submissions.uploadFile.mutationOptions());
  const update = useMutation(
    trpc.submissions.updateOwn.mutationOptions({
      onSuccess: async (saved) => {
        setSelectedFiles({});
        setEditState({
          submissionId: saved.id,
          content: submissionContent(saved),
          revision: saved.revision,
        });
        await queryClient.invalidateQueries(
          trpc.submissions.get.queryFilter(submissionInput),
        );
        await queryClient.invalidateQueries(
          trpc.submissions.list.queryFilter(),
        );
        await queryClient.invalidateQueries(
          trpc.reviews.organizerBoard.queryFilter({ slug: saved.event.slug }),
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
      onSuccess: async (withdrawn) => {
        setEditState(undefined);
        await queryClient.invalidateQueries(
          trpc.submissions.get.queryFilter(submissionInput),
        );
        await queryClient.invalidateQueries(
          trpc.submissions.list.queryFilter(),
        );
        await queryClient.invalidateQueries(
          trpc.reviews.organizerBoard.queryFilter({
            slug: withdrawn.event.slug,
          }),
        );
      },
    }),
  );
  const submissionStatus = useMutationStatuses([
    {
      mutation: update,
      mutationKey: trpc.submissions.updateOwn.mutationKey(),
      success: "Proposal saved",
    },
    {
      mutation: withdraw,
      mutationKey: trpc.submissions.withdrawOwn.mutationKey(),
      success: "Proposal withdrawn",
    },
  ]);

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

  async function save(event: FormEvent) {
    event.preventDefault();
    setFileError(undefined);
    const nextFileAnswers = { ...currentContent.fileAnswers };
    try {
      for (const field of visibleCustomFields(
        loadedSubmission.form.customFields,
        currentContent.customAnswers,
      )) {
        if (field.type !== "file") continue;
        const selected = selectedFiles[field.key];
        if (!selected) continue;
        const saved = await uploadFile.mutateAsync({
          slug: loadedSubmission.event.slug,
          cfpId: loadedSubmission.cfp.id,
          clientDraftId: loadedSubmission.id,
          uploadId: selected.uploadId,
          fieldKey: field.key,
          customAnswers: currentContent.customAnswers,
          fileName: selected.file.name,
          contentType: selected.file.type || "application/octet-stream",
          contentBase64: await browserFileToBase64(selected.file),
        });
        nextFileAnswers[field.key] = saved.id;
      }
    } catch (error) {
      setFileError(
        error instanceof Error
          ? error.message
          : "The file could not be uploaded.",
      );
      return;
    }
    update.mutate({
      submissionId: submissionInput.submissionId,
      expectedRevision:
        editState?.submissionId === loadedSubmission.id
          ? editState.revision
          : loadedSubmission.revision,
      ...currentContent,
      fileAnswers: nextFileAnswers,
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
          <form onSubmit={(event) => void save(event)}>
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
              <Field
                hint={ABSTRACT_HINT}
                label="Abstract"
                name="submission-abstract"
              >
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
                  file={
                    selectedFiles[field.key]?.file
                      ? { fileName: selectedFiles[field.key]!.file.name }
                      : loadedSubmission.fileAnswers[field.key]
                  }
                  onChange={(value) =>
                    changeContent((current) => ({
                      ...current,
                      customAnswers: {
                        ...current.customAnswers,
                        [field.key]: value,
                      },
                    }))
                  }
                  onFileChange={(file) => {
                    if (field.type !== "file" || !file) return;
                    if (
                      file.size > field.maxSizeMb * 1_000_000 ||
                      !acceptedBrowserFile(field.acceptedTypes, file.type)
                    ) {
                      setFileError(
                        `Choose ${formatAcceptedTypes(field.acceptedTypes)} up to ${field.maxSizeMb} MB.`,
                      );
                      return;
                    }
                    setFileError(undefined);
                    setSelectedFiles((current) => ({
                      ...current,
                      [field.key]: { file, uploadId: crypto.randomUUID() },
                    }));
                  }}
                  onFileInvalid={() =>
                    setFileError(`Choose a file for ${field.label}.`)
                  }
                />
              ))}
            </fieldset>
            {submissionStatus.error && (
              <MutationStatus error={submissionStatus.error} />
            )}
            {fileError && <MutationStatus error={fileError} />}
            {submissionStatus.success && (
              <MutationStatus success={submissionStatus.success} />
            )}
            {(editable || submission.data.permissions.canWithdraw) && (
              <div className="submission-actions">
                <button
                  className="primary-button"
                  disabled={
                    !editable || update.isPending || uploadFile.isPending
                  }
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
  const [removingSpeakers, setRemovingSpeakers] = useState<
    Record<string, Submission["proposedSpeakers"][number]>
  >({});
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
        const pendingSpeaker = previousSubmission?.proposedSpeakers.find(
          (speaker) => speaker.id === speakerId,
        );
        if (pendingSpeaker) {
          setRemovingSpeakers((current) => ({
            ...current,
            [speakerId]: pendingSpeaker,
          }));
        }
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
        return { pendingSpeaker };
      },
      onError: (_error, _input, context) => {
        if (!context?.pendingSpeaker) return;
        const pendingSpeaker = context.pendingSpeaker;
        queryClient.setQueryData(submissionQuery.queryKey, (current) =>
          current &&
          !current.proposedSpeakers.some(
            (speaker) => speaker.id === pendingSpeaker.id,
          )
            ? {
                ...current,
                proposedSpeakers: [...current.proposedSpeakers, pendingSpeaker],
              }
            : current,
        );
      },
      onSettled: async (_data, _error, { speakerId }) => {
        await refresh();
        setRemovingSpeakers((current) => {
          const next = { ...current };
          delete next[speakerId];
          return next;
        });
      },
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
  const speakerStatus = useMutationStatuses([
    {
      mutation: add,
      mutationKey: trpc.submissions.addSpeaker.mutationKey(),
      success: "Speaker added",
    },
    {
      mutation: remove,
      mutationKey: trpc.submissions.removeSpeaker.mutationKey(),
      success: "Speaker removed",
    },
    {
      mutation: replace,
      mutationKey: trpc.submissions.replaceSpeakerInvitation.mutationKey(),
      success: "Invitation replaced",
    },
    {
      mutation: resend,
      mutationKey: trpc.submissions.resendSpeakerInvitation.mutationKey(),
      success: "Invitation renewed",
    },
  ]);
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
        {[
          ...submission.proposedSpeakers,
          ...Object.values(removingSpeakers).filter(
            (pendingSpeaker) =>
              !submission.proposedSpeakers.some(
                (speaker) => speaker.id === pendingSpeaker.id,
              ),
          ),
        ].map((speaker) => (
          <div
            className="speaker-row"
            data-speaker-id={speaker.id}
            key={speaker.id}
          >
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
                    disabled={speakerStatus.isPendingFor(
                      replace,
                      "speakerId",
                      speaker.id,
                    )}
                    onClick={() =>
                      replace.mutate({
                        ...submissionInput,
                        speakerId: speaker.id,
                        replacesInvitationId: speaker.invitation?.id ?? "",
                      })
                    }
                    type="button"
                  >
                    {speakerStatus.isPendingFor(
                      replace,
                      "speakerId",
                      speaker.id,
                    )
                      ? "Sending…"
                      : "Send new invitation"}
                  </button>
                )}
              {submission.permissions.canManageSpeakers &&
                !speaker.claimed &&
                speaker.invitation?.status !== "pending" && (
                  <button
                    className="text-button"
                    disabled={speakerStatus.isPendingFor(
                      resend,
                      "speakerId",
                      speaker.id,
                    )}
                    onClick={() =>
                      resend.mutate({
                        ...submissionInput,
                        speakerId: speaker.id,
                      })
                    }
                    type="button"
                  >
                    {speakerStatus.isPendingFor(resend, "speakerId", speaker.id)
                      ? "Sending…"
                      : "Send invitation"}
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
                    disabled={
                      speakerStatus.isPendingFor(
                        remove,
                        "speakerId",
                        speaker.id,
                      ) || isOnlyProposedSpeaker
                    }
                    onClick={() =>
                      remove.mutate({
                        ...submissionInput,
                        speakerId: speaker.id,
                      })
                    }
                    type="button"
                  >
                    {speakerStatus.isPendingFor(remove, "speakerId", speaker.id)
                      ? "Removing…"
                      : "Remove"}
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
      {speakerStatus.error && <MutationStatus error={speakerStatus.error} />}
      {speakerStatus.success && (
        <MutationStatus success={speakerStatus.success} />
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
  const queryClient = useQueryClient();
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
  const [selectedFiles, setSelectedFiles] = useState<
    Record<string, LocalProposalFile>
  >({});
  const [fileError, setFileError] = useState<string>();
  const pendingSubmissionStarted = useRef(false);
  const draftKey = proposalDraftKey(slug);
  const submit = useMutation(
    trpc.submissions.submit.mutationOptions({
      onSuccess: async (submission) => {
        trackBrowserEvent("proposal_submitted");
        if (draftKey) window.localStorage.removeItem(draftKey);
        await deleteLocalProposalFiles(draft.clientDraftId);
        await queryClient.invalidateQueries(
          trpc.submissions.list.queryFilter(),
        );
        await queryClient.invalidateQueries(
          trpc.reviews.organizerBoard.queryFilter({
            slug: submission.event.slug,
          }),
        );
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
  const uploadFile = useMutation(trpc.submissions.uploadFile.mutationOptions());
  const { coreAnswers, customAnswers, step } = draft;

  useEffect(() => {
    window.localStorage.setItem(draftKey, JSON.stringify(draft));
  }, [draft, draftKey]);

  useEffect(() => {
    void loadLocalProposalFiles(draft.clientDraftId).then(setSelectedFiles);
  }, [draft.clientDraftId]);

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
      fileAnswers: draft.fileAnswers,
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
    void submitWithFiles();
  });

  useEffect(() => {
    if (
      draft.submitAfterSignIn &&
      session.data &&
      cfp.data &&
      !submit.isPending &&
      !pendingSubmissionStarted.current
    ) {
      pendingSubmissionStarted.current = true;
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

  async function selectProposalFile(
    field: Extract<CustomField, { type: "file" }>,
    file?: File,
  ) {
    setFileError(undefined);
    if (!file) return;
    if (
      file.size > field.maxSizeMb * 1_000_000 ||
      !acceptedBrowserFile(field.acceptedTypes, file.type)
    ) {
      setFileError(
        `Choose ${formatAcceptedTypes(field.acceptedTypes)} up to ${field.maxSizeMb} MB.`,
      );
      return;
    }
    const selected = { file, uploadId: crypto.randomUUID() };
    setSelectedFiles((current) => ({ ...current, [field.key]: selected }));
    setDraft((current) => ({
      ...current,
      fileAnswers: { ...current.fileAnswers, [field.key]: undefined } as Record<
        string,
        StoredFileId
      >,
    }));
    await saveLocalProposalFile(draft.clientDraftId, field.key, selected);
  }

  async function submitWithFiles() {
    if (!cfp.data || !session.data) return;
    setFileError(undefined);
    const visible = visibleCustomFields(cfp.data.customFields, customAnswers);
    const nextFileAnswers = { ...draft.fileAnswers };
    try {
      for (const field of visible) {
        if (field.type !== "file") continue;
        const selected = selectedFiles[field.key];
        if (!selected) continue;
        const saved = await uploadFile.mutateAsync({
          slug,
          cfpId: cfp.data.cfpId,
          clientDraftId: draft.clientDraftId,
          uploadId: selected.uploadId,
          fieldKey: field.key,
          customAnswers,
          fileName: selected.file.name,
          contentType: selected.file.type || "application/octet-stream",
          contentBase64: await browserFileToBase64(selected.file),
        });
        nextFileAnswers[field.key] = saved.id;
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
        fileAnswers: nextFileAnswers,
      });
      if (!parsed.success) {
        setProposalError(
          parsed.error.issues[0]?.message ??
            "Check the proposal before submitting.",
        );
        return;
      }
      setDraft((current) => ({ ...current, fileAnswers: nextFileAnswers }));
      submit.mutate({
        slug,
        cfpId: cfp.data.cfpId,
        clientDraftId: draft.clientDraftId,
        ...parsed.data,
      });
    } catch (error) {
      setFileError(
        error instanceof Error
          ? error.message
          : "The file could not be uploaded. Try again.",
      );
    }
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
      const speakerEmail = parsed.value.proposedSpeakers[0]!.email;
      setSignInPending(true);
      const result = await beginEmailSignIn(speakerEmail, returnTo);
      setSignInPending(false);
      if (result.error) {
        setProposalError("The sign-in code could not be sent. Try again.");
        return;
      }
      setDraft(pendingDraft);
      window.localStorage.setItem(draftKey, JSON.stringify(pendingDraft));
      void navigate(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }

    await submitWithFiles();
  }

  if (cfp.isPending)
    return <FullPageStatus label="Opening call for proposals" />;
  if (cfp.isError)
    return (
      <main className="public-cfp">
        <BoardStatus
          label={
            cfp.error.message === "This call for proposals is closed."
              ? "This CFP is closed"
              : "This CFP is not open"
          }
          detail={cfp.error.message}
        />
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
          <small>
            Event{" "}
            {formatEventDateRange(
              cfp.data.event.startsOn,
              cfp.data.event.endsOn,
            )}
          </small>
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
                  hint={ABSTRACT_HINT}
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
                      file={
                        selectedFiles[field.key]?.file
                          ? { fileName: selectedFiles[field.key]!.file.name }
                          : draft.fileAnswers[field.key]
                            ? ({
                                id: draft.fileAnswers[field.key],
                                fileName: "Uploaded file",
                              } as StoredFile)
                            : undefined
                      }
                      onChange={(value) =>
                        setCustomAnswers((current) => ({
                          ...current,
                          [field.key]: value,
                        }))
                      }
                      onFileChange={(file) =>
                        void selectProposalFile(
                          field as Extract<CustomField, { type: "file" }>,
                          file,
                        )
                      }
                      onFileInvalid={() =>
                        setFileError(`Choose a file for ${field.label}.`)
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
                    submit.isPending ||
                    uploadFile.isPending ||
                    session.isPending ||
                    signInPending
                  }
                  type="submit"
                >
                  {signInPending
                    ? "Sending code…"
                    : submit.isPending || uploadFile.isPending
                      ? "Submitting…"
                      : session.data
                        ? "Submit proposal"
                        : "Sign in and submit"}
                </button>
              )}
            </div>
            {(proposalError || fileError || submit.error) && (
              <p className="form-error" role="alert">
                {proposalError ?? fileError ?? submit.error?.message}
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
  file,
  onChange,
  onFileChange,
  onFileInvalid,
}: {
  disabled: boolean;
  field: CustomField;
  value: string;
  file: (Pick<StoredFile, "fileName"> & { url?: string }) | undefined;
  onChange: (value: string) => void;
  onFileChange?: (file: File | undefined) => void;
  onFileInvalid?: () => void;
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
        hint={`${formatAcceptedTypes(field.acceptedTypes)} · Up to ${field.maxSizeMb} MB`}
        label={field.label}
        name={field.key}
        required={field.required}
      >
        <input
          accept={field.acceptedTypes.join(",")}
          disabled={disabled}
          id={field.key}
          required={field.required && !file}
          type="file"
          onChange={(event) => onFileChange?.(event.target.files?.[0])}
          onInvalid={onFileInvalid}
        />
        {file &&
          (file.url ? (
            <a href={file.url}>{file.fileName}</a>
          ) : (
            <span>{file.fileName}</span>
          ))}
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

function emptyCfpDefinition(
  startsOn: string,
  endsOn: string,
  timezone: string,
): CfpDefinitionInput {
  return {
    name: "",
    deadline: defaultCfpDeadline({ startsOn, endsOn, timezone }),
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
    fileAnswers: {},
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
    fileAnswers: Object.fromEntries(
      Object.entries(submission.fileAnswers).map(([key, file]) => [
        key,
        file.id,
      ]),
    ),
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

function deadlineInputError(input: {
  allowExpired: boolean;
  deadline: string | undefined;
  localDateTime: string;
  max: string;
  min: string;
}): { message: string; path: (string | number)[] } | undefined {
  if (!input.localDateTime) {
    return {
      message: "Choose a deadline.",
      path: ["deadline"],
    };
  }
  if (!input.allowExpired && input.localDateTime < input.min) {
    return {
      message: "Choose a deadline in the future.",
      path: ["deadline"],
    };
  }
  if (input.localDateTime > input.max) {
    return {
      message: "Choose a deadline on or before the event end date.",
      path: ["deadline"],
    };
  }
  if (!input.deadline) {
    return {
      message: "Choose a deadline that exists in the event timezone.",
      path: ["deadline"],
    };
  }
  return undefined;
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
