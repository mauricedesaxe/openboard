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
  track: (event: BrowserTelemetryEvent) => void;
};

export function createBrowserTelemetry(input: {
  command: BetterStackCommand;
  environment: string;
  pathname: () => string;
  release: string;
}): BrowserTelemetry {
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
        autoPageview: true,
        environment: input.environment,
        release: input.release,
      });
    },
    identify(userId) {
      input.command("user", userId ? { id: userId } : null);
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
}

export function trackBrowserEvent(event: BrowserTelemetryEvent): void {
  browserTelemetry?.track(event);
}

export function sanitizeBrowserError(
  event: BrowserError,
  pathname: string,
): BrowserError {
  const sanitized = { ...event };
  delete sanitized.breadcrumbs;
  delete sanitized.extra;

  const route = browserRoute(pathname);
  sanitized.tags = { ...recordValue(event.tags), route };

  const user = recordValue(event.user);
  sanitized.user = typeof user.id === "string" ? { id: user.id } : undefined;

  const request = recordValue(event.request);
  const requestUrl = typeof request.url === "string" ? request.url : undefined;
  sanitized.request = requestUrl
    ? { url: safeRequestUrl(requestUrl, route) }
    : undefined;

  return withoutUndefined(sanitized);
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
  const command: BetterStackCommand & { q?: unknown[][]; l?: number } =
    browserWindow.betterstack ??
    ((...args: unknown[]) => {
      command.q = command.q ?? [];
      command.q.push(args);
    });
  command.l = Date.now();
  browserWindow.betterstack = command;

  const script = document.createElement("script");
  script.async = true;
  script.crossOrigin = "anonymous";
  script.src = `https://betterstack.net/b.js?t=${encodeURIComponent(token)}`;
  document.head.appendChild(script);
  return command;
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function withoutUndefined(value: BrowserError): BrowserError {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  );
}
