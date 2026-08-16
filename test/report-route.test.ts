import { describe, expect, test } from "vitest";

import { reportRoute } from "../src/shared/problem-reports";

describe("report route sanitization", () => {
  test("replaces invitation paths with a parameterized template", () => {
    expect(reportRoute("/invitations/abc123")).toBe("/invitations/:secret");
    expect(reportRoute("/invitations/xyz-999")).toBe("/invitations/:secret");
    expect(reportRoute("/invitations/abc/extra")).toBe("/invitations/:secret");
    expect(reportRoute("/invitations/very/long/path")).toBe(
      "/invitations/:secret",
    );
  });

  test("replaces speaker-invitation paths with a parameterized template", () => {
    expect(reportRoute("/speaker-invitations/abc123")).toBe(
      "/speaker-invitations/:secret",
    );
    expect(reportRoute("/speaker-invitations/xyz/extra")).toBe(
      "/speaker-invitations/:secret",
    );
  });

  test("replaces submission paths with a parameterized template", () => {
    expect(
      reportRoute("/submissions/00000000-0000-4000-8000-000000000001"),
    ).toBe("/submissions/:submissionId");
    expect(
      reportRoute("/submissions/00000000-0000-4000-8000-000000000002/extra"),
    ).toBe("/submissions/:submissionId");
  });

  test("replaces event paths with a parameterized slug", () => {
    expect(reportRoute("/events/my-event/agenda")).toBe("/events/:slug/agenda");
    expect(reportRoute("/events/conf-2027/cfp/manage/tracks")).toBe(
      "/events/:slug/cfp/manage/tracks",
    );
    expect(reportRoute("/events/devops")).toBe("/events/:slug");
  });

  test("keeps known static routes unchanged", () => {
    expect(reportRoute("/")).toBe("/");
    expect(reportRoute("/sign-in")).toBe("/sign-in");
    expect(reportRoute("/speaker-profile")).toBe("/speaker-profile");
    expect(reportRoute("/tasks")).toBe("/tasks");
  });

  test("falls back to /other for bare route prefixes without a secret", () => {
    expect(reportRoute("/invitations")).toBe("/other");
    expect(reportRoute("/speaker-invitations")).toBe("/other");
    expect(reportRoute("/submissions")).toBe("/other");
    expect(reportRoute("/events")).toBe("/other");
  });

  test("falls back to /other for unrecognized routes", () => {
    expect(reportRoute("/unknown")).toBe("/other");
    expect(reportRoute("/admin/dashboard")).toBe("/other");
    expect(reportRoute("")).toBe("/other");
  });
});
