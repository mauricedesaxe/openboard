import { describe, expect, test, vi } from "vitest";

import {
  createBrowserTelemetry,
  didCompleteOnboarding,
  sanitizeBrowserError,
} from "../src/client/browser-telemetry";
import { reportRoute } from "../src/shared/problem-reports";

describe("browser telemetry", () => {
  test("turns private URLs into stable route context", () => {
    expect(reportRoute("/events/northstar/review/decisions")).toBe(
      "/events/:slug/review/decisions",
    );
    expect(reportRoute("/submissions/private-submission-id")).toBe(
      "/submissions/:submissionId",
    );
    expect(reportRoute("/invitations/private-secret")).toBe(
      "/invitations/:secret",
    );
    expect(reportRoute("/speaker-invitations/private-secret")).toBe(
      "/speaker-invitations/:secret",
    );
    expect(reportRoute("/unknown/private-value")).toBe("/other");
  });

  test("removes private browser context before an error is sent", () => {
    const error = sanitizeBrowserError(
      {
        breadcrumbs: [{ message: "speaker biography" }],
        contexts: { response: { data: "proposal answers" } },
        extra: { answers: "proposal answers" },
        fingerprint: ["speaker@example.com"],
        exception: { values: [{ type: "Error", value: "Controlled failure" }] },
        message: "speaker biography",
        request: {
          cookies: { session: "private" },
          data: { code: "123456" },
          headers: { authorization: "private" },
          query_string: "code=123456",
          url: "https://openboard.example/submissions/private-id?code=123456",
        },
        user: { email: "speaker@example.com", id: "user-123" },
        tags: { email: "speaker@example.com" },
        transaction: "/submissions/private-id",
      },
      "/submissions/private-id",
    );

    expect(error).toEqual({
      exception: { values: [{ type: "Error", value: "Browser error" }] },
      request: {
        url: "https://openboard.example/submissions/:submissionId",
      },
      tags: { route: "/submissions/:submissionId" },
      user: { id: "user-123" },
    });
  });

  test("emits onboarding completion only after the final required task", () => {
    const previous = [
      {
        completed: true,
        eventSlug: "northstar",
        id: "first",
        required: true,
      },
      {
        completed: false,
        eventSlug: "northstar",
        id: "final",
        required: true,
      },
      {
        completed: false,
        eventSlug: "northstar",
        id: "optional",
        required: false,
      },
    ];

    expect(
      didCompleteOnboarding(
        previous,
        previous.map((task) =>
          task.id === "final" ? { ...task, completed: true } : task,
        ),
        "final",
      ),
    ).toBe(true);
    expect(
      didCompleteOnboarding(
        previous,
        previous.map((task) =>
          task.id === "first" ? { ...task, completed: true } : task,
        ),
        "first",
      ),
    ).toBe(false);
    expect(
      didCompleteOnboarding(
        previous,
        previous.map((task) =>
          task.id === "optional" ? { ...task, completed: true } : task,
        ),
        "optional",
      ),
    ).toBe(false);
  });

  test("initializes collection and emits only named safe events", () => {
    const command = vi.fn();
    let pathname = "/events/northstar/agenda";
    const telemetry = createBrowserTelemetry({
      command,
      environment: "preview",
      pathname: () => pathname,
      release: "abc123",
    });

    telemetry.initialize();
    telemetry.pageView();
    telemetry.identify("user-123");
    telemetry.track("agenda_published");
    pathname = "/events/northstar/review/decisions";
    telemetry.pageView();
    telemetry.identify(undefined);

    expect(command.mock.calls[0]?.[0]).toBe("config");
    expect(command).toHaveBeenCalledWith("init", {
      autoPageview: false,
      environment: "preview",
      release: "abc123",
    });
    expect(command).toHaveBeenCalledWith("track", "page-load", {
      url: "/events/:slug/agenda",
    });
    expect(command).toHaveBeenCalledWith("track", "page-change", {
      url: "/events/:slug/review/decisions",
    });
    expect(command).toHaveBeenCalledWith("user", { id: "user-123" });
    expect(command).toHaveBeenCalledWith("track", "agenda_published", {
      route: "/events/:slug/agenda",
    });
    expect(command).toHaveBeenCalledWith("user", null);
  });
});
