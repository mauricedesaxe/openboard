import { ORGANIZER_CFP_AREA } from "../shared/event-routes";

export type NavigationEvent = {
  name: string;
  slug: string;
  access: "owner" | "organizer" | "reviewer" | "submitter";
  permissions: Array<"organizer" | "reviewer">;
};

export type ReviewPath =
  "review" | "review/assignments" | "review/decisions" | "review/my-reviews";

export function eventSlugFromPath(pathname: string): string | undefined {
  return pathname.match(/^\/events\/([^/]+)(?:\/|$)/)?.[1];
}

export function eventSwitchPath(
  pathname: string,
  event: NavigationEvent,
): string {
  const route = pathname.match(/^\/events\/[^/]+\/(.+)$/)?.[1] ?? "";
  const area = route.split("/")[0] ?? "";
  const organizerOnly = new Set([
    "tracks",
    "rooms",
    "cfp",
    "agenda",
    "readiness",
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
  const reviewPath = route.match(
    /^review(?:\/(?:assignments|decisions|my-reviews))?$/,
  )?.[0] as ReviewPath | undefined;
  if (reviewPath) {
    return reviewLandingPath(event.slug, reviewPath, event.permissions);
  }
  const targetArea = area === "cfp" ? ORGANIZER_CFP_AREA : route;
  return `/events/${event.slug}${targetArea ? `/${targetArea}` : ""}`;
}

export function reviewLandingPath(
  slug: string,
  requestedPath: ReviewPath,
  permissions: NavigationEvent["permissions"],
): string {
  const organizer = permissions.includes("organizer");
  const reviewer = permissions.includes("reviewer");
  const requestedForReviewer = requestedPath === "review/my-reviews";
  if (
    (requestedForReviewer && reviewer) ||
    (!requestedForReviewer && organizer)
  ) {
    return `/events/${slug}/${requestedPath}`;
  }
  if (organizer) return `/events/${slug}/review`;
  if (reviewer) return `/events/${slug}/review/my-reviews`;
  return `/events/${slug}`;
}
