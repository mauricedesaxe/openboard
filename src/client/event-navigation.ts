import { ORGANIZER_CFP_AREA } from "../shared/event-routes";

export type NavigationEvent = {
  name: string;
  slug: string;
  access: "owner" | "organizer" | "reviewer";
  permissions: Array<"organizer" | "reviewer">;
};

export function eventSlugFromPath(pathname: string): string | undefined {
  return pathname.match(/^\/events\/([^/]+)(?:\/|$)/)?.[1];
}

export function eventSwitchPath(
  pathname: string,
  event: NavigationEvent,
): string {
  const area = pathname.match(/^\/events\/[^/]+\/([^/]+)/)?.[1] ?? "";
  const organizerOnly = new Set([
    "tracks",
    "rooms",
    "cfp",
    "agenda",
    "readiness",
    "onboarding",
    "communications",
    "settings",
  ]);
  const ownerOnly = area === "team";
  if (
    (organizerOnly.has(area) && !event.permissions.includes("organizer")) ||
    (ownerOnly && event.access !== "owner")
  ) {
    return `/events/${event.slug}`;
  }
  const targetArea = area === "cfp" ? ORGANIZER_CFP_AREA : area;
  return `/events/${event.slug}${targetArea ? `/${targetArea}` : ""}`;
}
