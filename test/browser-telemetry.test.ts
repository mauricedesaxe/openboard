import { describe, expect, test, vi } from "vitest";

import {
  browserRoute,
  createBrowserTelemetry,
  sanitizeBrowserError,
} from "../src/client/browser-telemetry";

describe("browser telemetry", () => {
  test("turns private URLs into stable route context", () => {
    expect(browserRoute("/events/northstar/review/decisions")).toBe(
      "/events/:slug/review/decisions",
    );
    expect(browserRoute("/submissions/private-submission-id")).toBe(
      "/submissions/:submissionId",
    );
    expect(browserRoute("/invitations/private-secret")).toBe(
      "/invitations/:secret",
    );
    expect(browserRoute("/speaker-invitations/private-secret")).toBe(
      "/speaker-invitations/:secret",
    );
  });

  test("removes private browser context before an error is sent", () => {
    const error = sanitizeBrowserError(
      {
        breadcrumbs: [{ message: "speaker biography" }],
        extra: { answers: "proposal answers" },
        exception: { values: [{ type: "Error", value: "Controlled failure" }] },
        request: {
          cookies: { session: "private" },
          data: { code: "123456" },
          headers: { authorization: "private" },
          query_string: "code=123456",
          url: "https://openboard.example/submissions/private-id?code=123456",
        },
        user: { email: "speaker@example.com", id: "user-123" },
      },
      "/submissions/private-id",
    );

    expect(error).toEqual({
      exception: { values: [{ type: "Error", value: "Controlled failure" }] },
      request: {
        url: "https://openboard.example/submissions/:submissionId",
      },
      tags: { route: "/submissions/:submissionId" },
      user: { id: "user-123" },
    });
  });

  test("initializes collection and emits only named safe events", () => {
    const command = vi.fn();
    const telemetry = createBrowserTelemetry({
      command,
      environment: "preview",
      pathname: () => "/events/northstar/agenda",
      release: "abc123",
    });

    telemetry.initialize();
    telemetry.identify("user-123");
    telemetry.track("agenda_published");
    telemetry.identify(undefined);

    expect(command.mock.calls[0]?.[0]).toBe("config");
    expect(command).toHaveBeenCalledWith("init", {
      autoPageview: true,
      environment: "preview",
      release: "abc123",
    });
    expect(command).toHaveBeenCalledWith("user", { id: "user-123" });
    expect(command).toHaveBeenCalledWith("track", "agenda_published", {
      route: "/events/:slug/agenda",
    });
    expect(command).toHaveBeenCalledWith("user", null);
  });
});
