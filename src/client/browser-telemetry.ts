export type BrowserTelemetryEvent =
  | "agenda_published"
  | "cfp_published"
  | "decision_published"
  | "event_created"
  | "onboarding_completed"
  | "proposal_submitted"
  | "review_completed"
  | "sign_in_completed";

type BrowserError = Record<string, unknown>;
type BetterStackCommand = (...args: unknown[]) => void;

type BrowserTelemetry = {
  identify: (userId: string | undefined) => void;
  initialize: () => void;
  pageView: () => void;
  track: (event: BrowserTelemetryEvent) => void;
};

const SIGN_IN_COMPLETED_KEY = "openboard:sign-in-completed";

export function createBrowserTelemetry(input: {
  command: BetterStackCommand;
  environment: string;
  pathname: () => string;
  release: string;
}): BrowserTelemetry {
  let currentPathname: string | undefined;
  return {
    initialize() {
      input.command("config", {
        sentry: {
          beforeBreadcrumb: () => null,
          beforeSend: (event: BrowserError) =>
            sanitizeBrowserError(event, input.pathname()),
          sampleRate: 1,
          sendDefaultPii: false,
        },
      });
      input.command("init", {
        autoPageview: false,
        environment: input.environment,
        release: input.release,
      });
      currentPathname = input.pathname();
      input.command("track", "page-load", {
        url: browserRoute(currentPathname),
      });
    },
    identify(userId) {
      input.command("user", userId ? { id: userId } : null);
    },
    pageView() {
      const pathname = input.pathname();
      if (pathname === currentPathname) return;
      currentPathname = pathname;
      input.command("track", "page-change", {
        url: browserRoute(pathname),
      });
    },
    track(event) {
      input.command("track", event, {
        route: browserRoute(input.pathname()),
      });
    },
  };
}

export function initializeBrowserTelemetry(): void {
  const token = optionalString(
    import.meta.env.VITE_BETTERSTACK_BROWSER_TOKEN as unknown,
  );
  const environment = optionalString(import.meta.env.VITE_APP_ENV as unknown);
  const release = optionalString(import.meta.env.VITE_APP_RELEASE as unknown);
  if (!token || !environment || !release) return;

  const command = installBetterStackCommand(token);
  browserTelemetry = createBrowserTelemetry({
    command,
    environment,
    pathname: () => window.location.pathname,
    release,
  });
  browserTelemetry.initialize();
}

export function identifyBrowserUser(userId: string | undefined): void {
  browserTelemetry?.identify(userId);
  if (
    !userId ||
    window.sessionStorage.getItem(SIGN_IN_COMPLETED_KEY) !== "true"
  ) {
    return;
  }
  window.sessionStorage.removeItem(SIGN_IN_COMPLETED_KEY);
  browserTelemetry?.track("sign_in_completed");
}

export function markBrowserSignInCompleted(): void {
  window.sessionStorage.setItem(SIGN_IN_COMPLETED_KEY, "true");
}

export function trackBrowserPageView(): void {
  browserTelemetry?.pageView();
}

export function trackBrowserEvent(event: BrowserTelemetryEvent): void {
  browserTelemetry?.track(event);
}

export function sanitizeBrowserError(
  event: BrowserError,
  pathname: string,
): BrowserError {
  const route = browserRoute(pathname);
  const user = recordValue(event.user);
  const request = recordValue(event.request);
  const requestUrl = typeof request.url === "string" ? request.url : undefined;
  return withoutUndefined({
    environment: stringValue(event.environment),
    event_id: stringValue(event.event_id),
    exception: safeException(event.exception),
    level: stringValue(event.level),
    platform: stringValue(event.platform),
    release: stringValue(event.release),
    request: requestUrl
      ? { url: safeRequestUrl(requestUrl, route) }
      : undefined,
    tags: { route },
    timestamp: numberValue(event.timestamp),
    user: typeof user.id === "string" ? { id: user.id } : undefined,
  });
}

export function didCompleteOnboarding(
  previous: readonly OnboardingTask[],
  latest: readonly OnboardingTask[],
  assignmentId: string,
): boolean {
  const changed = previous.find((task) => task.id === assignmentId);
  if (!changed) return false;

  return (
    !eventOnboardingComplete(previous, changed.eventSlug) &&
    eventOnboardingComplete(latest, changed.eventSlug)
  );
}

export function browserRoute(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "invitations" && segments.length >= 2) {
    return "/invitations/:secret";
  }
  if (segments[0] === "speaker-invitations" && segments.length >= 2) {
    return "/speaker-invitations/:secret";
  }
  if (segments[0] === "submissions" && segments.length >= 2) {
    return "/submissions/:submissionId";
  }
  if (segments[0] === "events" && segments.length >= 2) {
    return ["", "events", ":slug", ...segments.slice(2)].join("/");
  }
  return pathname || "/";
}

let browserTelemetry: BrowserTelemetry | undefined;

function installBetterStackCommand(token: string): BetterStackCommand {
  const browserWindow = window as Window & {
    betterstack?: BetterStackCommand & { q?: unknown[][]; l?: number };
  };
  const pending: unknown[][] = [];
  let loadedCommand: BetterStackCommand | undefined;
  const command: BetterStackCommand & { q?: unknown[][]; l?: number } = (
    ...args: unknown[]
  ) => {
    if (!loadedCommand) {
      pending.push(args);
      return;
    }
    const vendorCommand = loadedCommand;
    withSafeBrowserLocation(() => vendorCommand(...args));
  };
  command.q = [];
  command.l = Date.now();
  browserWindow.betterstack = command;

  const script = document.createElement("script");
  script.async = true;
  script.crossOrigin = "anonymous";
  script.src = `https://betterstack.net/b.js?t=${encodeURIComponent(token)}`;
  script.addEventListener("load", () => {
    const vendorCommand = browserWindow.betterstack;
    if (!vendorCommand || vendorCommand === command) return;
    loadedCommand = vendorCommand;
    for (const args of pending.splice(0)) command(...args);
  });
  document.head.appendChild(script);
  return command;
}

function withSafeBrowserLocation(run: () => void): void {
  const url = window.location.href;
  const state = window.history.state as unknown;
  const referrer = Object.getOwnPropertyDescriptor(document, "referrer");
  try {
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: "",
    });
    window.history.replaceState(
      state,
      "",
      browserRoute(window.location.pathname),
    );
    run();
  } finally {
    window.history.replaceState(state, "", url);
    if (referrer) Object.defineProperty(document, "referrer", referrer);
    else Reflect.deleteProperty(document, "referrer");
  }
}

function safeRequestUrl(url: string, route: string): string {
  try {
    return `${new URL(url).origin}${route}`;
  } catch {
    return route;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

type OnboardingTask = {
  completed: boolean;
  eventSlug: string;
  id: string;
  required: boolean;
};

function eventOnboardingComplete(
  tasks: readonly OnboardingTask[],
  eventSlug: string,
): boolean {
  const required = tasks.filter(
    (task) => task.eventSlug === eventSlug && task.required,
  );
  return required.length > 0 && required.every((task) => task.completed);
}

function safeException(value: unknown): BrowserError | undefined {
  const exception = recordValue(value);
  if (!Array.isArray(exception.values)) return undefined;
  const values = exception.values.flatMap((item) => {
    const type = stringValue(recordValue(item).type);
    return type ? [{ type, value: "Browser error" }] : [];
  });
  return values.length > 0 ? { values } : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function withoutUndefined(value: BrowserError): BrowserError {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  );
}
