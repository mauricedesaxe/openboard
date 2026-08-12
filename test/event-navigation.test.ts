import { describe, expect, test } from "vitest";

import {
  eventSlugFromPath,
  eventSwitchPath,
  type NavigationEvent,
} from "../src/client/event-navigation";

const owner: NavigationEvent = {
  name: "Owner event",
  slug: "owner-event",
  access: "owner",
  permissions: ["organizer", "reviewer"],
};
const reviewer: NavigationEvent = {
  name: "Reviewer event",
  slug: "reviewer-event",
  access: "reviewer",
  permissions: ["reviewer"],
};

describe("event navigation", () => {
  test("reads the active event from an event route", () => {
    expect(eventSlugFromPath("/events/current-event/review")).toBe(
      "current-event",
    );
    expect(eventSlugFromPath("/tasks")).toBeUndefined();
  });

  test("preserves an accessible area when switching events", () => {
    expect(eventSwitchPath("/events/current/review", reviewer)).toBe(
      "/events/reviewer-event/review",
    );
    expect(eventSwitchPath("/events/current/cfp/manage", owner)).toBe(
      "/events/owner-event/cfp/manage",
    );
    expect(
      eventSwitchPath("/events/current/communications/deliveries", owner),
    ).toBe("/events/owner-event/communications/deliveries");
  });

  test("opens Home when the target event cannot access the area", () => {
    expect(eventSwitchPath("/events/current/agenda", reviewer)).toBe(
      "/events/reviewer-event",
    );
    expect(eventSwitchPath("/events/current/team", reviewer)).toBe(
      "/events/reviewer-event",
    );
  });
});
