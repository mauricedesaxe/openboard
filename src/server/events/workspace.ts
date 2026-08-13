import { desc, eq, sql } from "drizzle-orm";

import { ORGANIZER_CFP_AREA } from "../../shared/event-routes";
import type { UserId } from "../../shared/events";
import { getWorkingAgenda } from "../agendas/repository";
import { getCfpSetup } from "../cfps/repository";
import { listCommunicationFailures } from "../communications/repository";
import type { Database } from "../database/client";
import { cfps, reviewRounds } from "../database/schema";
import { listEventTeam } from "../event-team/repository";
import { getOrganizerOnboardingBoard } from "../onboarding/repository";
import {
  getOrganizerReviewBoard,
  listOwnReviewAssignments,
} from "../reviews/repository";

import { findEventForUser } from "./repository";

export async function getEventWorkspace(
  database: Database,
  userId: UserId,
  slug: string,
) {
  const event = await findEventForUser(database, userId, slug);
  if (!event) return undefined;

  const organizer = event.permissions.includes("organizer");
  const reviewer = event.permissions.includes("reviewer");
  const [cfp, review, agenda, readiness, communications, team, reviewerRound] =
    await Promise.all([
      organizer ? getCfpSetup(database, userId, slug) : null,
      organizer ? getOrganizerReviewBoard(database, userId, slug) : null,
      organizer ? getWorkingAgenda(database, userId, slug) : null,
      organizer ? getOrganizerOnboardingBoard(database, userId, slug) : null,
      organizer ? listCommunicationFailures(database, userId, slug) : null,
      event.access === "owner" ? listEventTeam(database, userId, slug) : null,
      reviewer ? getReviewerRound(database, event.id) : null,
    ]);
  const myReviews = reviewerRound
    ? await listOwnReviewAssignments(database, userId, slug, reviewerRound.id)
    : [];

  const attention = organizer
    ? organizerAttention(slug, {
        cfp,
        review,
        agenda,
        readiness,
        communications,
        team,
      })
    : [];
  const remainingReviews = myReviews.filter(
    (assignment) => assignment.review === null,
  ).length;

  return {
    event,
    attention,
    reviewer: reviewer
      ? {
          roundStatus: reviewerRound?.status ?? "unavailable",
          remaining: remainingReviews,
          assigned: myReviews.length,
          cfpDeadline: reviewerRound?.cfpDeadline ?? null,
        }
      : null,
    statuses: organizer
      ? [
          cfpStatus(cfp),
          reviewStatus(review),
          agendaStatus(agenda),
          readinessStatus(readiness),
          ...(event.access === "owner" ? [teamStatus(team)] : []),
          communicationStatus(communications),
        ]
      : [],
  };
}

async function getReviewerRound(database: Database, eventId: string) {
  const [round] = await database
    .select({
      id: reviewRounds.id,
      status: reviewRounds.status,
      cfpDeadline: cfps.deadline,
    })
    .from(reviewRounds)
    .innerJoin(cfps, eq(cfps.id, reviewRounds.cfpId))
    .where(eq(reviewRounds.eventId, eventId))
    .orderBy(
      sql`CASE ${cfps.status} WHEN 'open' THEN 0 ELSE 1 END`,
      desc(reviewRounds.createdAt),
    )
    .limit(1);
  return round ?? null;
}

type OrganizerState = {
  cfp: Awaited<ReturnType<typeof getCfpSetup>> | null;
  review: Awaited<ReturnType<typeof getOrganizerReviewBoard>> | null;
  agenda: Awaited<ReturnType<typeof getWorkingAgenda>> | null;
  readiness: Awaited<ReturnType<typeof getOrganizerOnboardingBoard>> | null;
  communications: Awaited<ReturnType<typeof listCommunicationFailures>> | null;
  team: Awaited<ReturnType<typeof listEventTeam>> | null;
};

type AttentionItem = {
  key: string;
  severity: "critical" | "warning";
  title: string;
  detail: string;
  count: number;
  href: string;
  deadline: string | null;
};

function organizerAttention(
  slug: string,
  state: OrganizerState,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const route = (area: string) => `/events/${slug}/${area}`;
  const openCfp = state.cfp?.open;
  const draftCfp = state.cfp?.draft;
  if (!openCfp && !draftCfp) {
    items.push(
      attention(
        "cfp",
        "warning",
        "The CFP is not configured",
        "Create the proposal form before inviting submissions.",
        1,
        route(ORGANIZER_CFP_AREA),
        null,
      ),
    );
  } else if (!openCfp && draftCfp) {
    items.push(
      attention(
        "cfp",
        "warning",
        "The CFP is still a draft",
        "Open it when the proposal form is ready.",
        1,
        route(ORGANIZER_CFP_AREA),
        draftCfp.deadline,
      ),
    );
  } else if (openCfp) {
    const days = daysUntil(openCfp.deadline);
    if (days < 0) {
      items.push(
        attention(
          "cfp",
          "critical",
          "The CFP deadline passed",
          "Close proposal intake or update the deadline.",
          1,
          route(ORGANIZER_CFP_AREA),
          openCfp.deadline,
        ),
      );
    } else if (days <= 7) {
      items.push(
        attention(
          "cfp",
          "warning",
          `The CFP closes in ${days} ${days === 1 ? "day" : "days"}`,
          "Check the form and deadline before intake closes.",
          1,
          route(ORGANIZER_CFP_AREA),
          openCfp.deadline,
        ),
      );
    }
  }

  if (state.review) {
    const incomplete = state.review.submissions.reduce(
      (count, submission) =>
        count +
        Math.max(0, submission.review.assigned - submission.review.completed),
      0,
    );
    const queued = state.review.submissions.filter((submission) =>
      submission.decision.status.endsWith("_queued"),
    ).length;
    if (incomplete > 0)
      items.push(
        attention(
          "review",
          "warning",
          `${incomplete} ${incomplete === 1 ? "review is" : "reviews are"} incomplete`,
          "Follow up before the review round closes.",
          incomplete,
          route("review"),
          null,
        ),
      );
    if (queued > 0)
      items.push(
        attention(
          "decisions",
          "critical",
          `${queued} queued ${queued === 1 ? "decision is" : "decisions are"} unpublished`,
          "Publish queued outcomes to notify submitters.",
          queued,
          route("review/decisions"),
          null,
        ),
      );
  }

  if (state.agenda) {
    const unplaced = state.agenda.unplacedProgramItems.length;
    const conflicts = state.agenda.items.filter(
      (item) => !item.canceled && item.conflicts.length > 0,
    ).length;
    if (conflicts > 0)
      items.push(
        attention(
          "agenda-conflicts",
          "critical",
          `${conflicts} agenda ${conflicts === 1 ? "item has" : "items have"} conflicts`,
          "Resolve room or speaker overlaps before publication.",
          conflicts,
          route("agenda"),
          null,
        ),
      );
    if (unplaced > 0)
      items.push(
        attention(
          "unplaced",
          "warning",
          `${unplaced} accepted ${unplaced === 1 ? "item is" : "items are"} unplaced`,
          "Place each accepted program item on the agenda.",
          unplaced,
          route("agenda"),
          null,
        ),
      );
  }

  if (state.readiness) {
    const blockers = state.readiness.assignments.filter(
      (assignment) => assignment.required && !assignment.completed,
    ).length;
    if (blockers > 0)
      items.push(
        attention(
          "readiness",
          "warning",
          `${blockers} readiness ${blockers === 1 ? "blocker remains" : "blockers remain"}`,
          "Review incomplete speaker requirements.",
          blockers,
          route("readiness"),
          null,
        ),
      );
  }
  if (state.communications && state.communications.length > 0) {
    items.push(
      attention(
        "communications",
        "critical",
        `${state.communications.length} ${state.communications.length === 1 ? "communication failed" : "communications failed"}`,
        "Retry delivery or inspect the terminal failure.",
        state.communications.length,
        route("communications/deliveries"),
        null,
      ),
    );
  }
  if (state.team) {
    const pending = state.team.invitations.filter(
      (invitation) => invitation.usable,
    ).length;
    const expired = state.team.invitations.filter(
      (invitation) => invitation.status === "pending" && !invitation.usable,
    ).length;
    if (expired > 0)
      items.push(
        attention(
          "team-expired",
          "critical",
          `${expired} team ${expired === 1 ? "invitation has" : "invitations have"} expired`,
          "Replace each expired invitation to send a usable link.",
          expired,
          route("team"),
          null,
        ),
      );
    if (pending > 0)
      items.push(
        attention(
          "team",
          "warning",
          `${pending} team ${pending === 1 ? "invitation is" : "invitations are"} pending`,
          "Follow up before each active invitation expires.",
          pending,
          route("team"),
          null,
        ),
      );
  }

  return items.sort((left, right) => {
    const severity = severityRank(left.severity) - severityRank(right.severity);
    if (severity !== 0) return severity;
    return deadlineTime(left.deadline) - deadlineTime(right.deadline);
  });
}

function attention(
  key: string,
  severity: AttentionItem["severity"],
  title: string,
  detail: string,
  count: number,
  href: string,
  deadline: string | null,
): AttentionItem {
  return { key, severity, title, detail, count, href, deadline };
}

function cfpStatus(cfp: OrganizerState["cfp"]) {
  const current = cfp?.open ?? cfp?.draft;
  return {
    key: "cfp",
    label: "CFP",
    value: current
      ? cfp?.open
        ? cfp.open.publicationStatus === "closed"
          ? "Closed"
          : "Open"
        : "Draft"
      : "Not configured",
    detail: current?.deadline
      ? `Deadline ${current.deadline.slice(0, 10)}`
      : "No proposal form",
    href: ORGANIZER_CFP_AREA,
  };
}

function reviewStatus(review: OrganizerState["review"]) {
  const completed =
    review?.submissions.reduce(
      (count, submission) => count + submission.review.completed,
      0,
    ) ?? 0;
  const assigned =
    review?.submissions.reduce(
      (count, submission) => count + submission.review.assigned,
      0,
    ) ?? 0;
  return {
    key: "review",
    label: "Review",
    value: review?.round.status ?? "Not started",
    detail: `${completed} of ${assigned} assigned reviews complete`,
    href: "review",
  };
}

function agendaStatus(agenda: OrganizerState["agenda"]) {
  const conflicts =
    agenda?.items.filter((item) => !item.canceled && item.conflicts.length > 0)
      .length ?? 0;
  return {
    key: "agenda",
    label: "Agenda",
    value:
      conflicts > 0
        ? `${conflicts} conflicts`
        : `${agenda?.items.length ?? 0} items`,
    detail: `${agenda?.unplacedProgramItems.length ?? 0} accepted items unplaced`,
    href: "agenda",
  };
}

function readinessStatus(readiness: OrganizerState["readiness"]) {
  const ready =
    readiness?.readiness.speakers.filter((speaker) => speaker.ready).length ??
    0;
  const total = readiness?.readiness.speakers.length ?? 0;
  return {
    key: "readiness",
    label: "Readiness",
    value: `${ready} of ${total} ready`,
    detail:
      total === 0
        ? "No accepted speakers"
        : `${total - ready} speakers blocked`,
    href: "readiness",
  };
}

function teamStatus(team: OrganizerState["team"]) {
  const people = team ? team.roles.length + 1 : 0;
  const pending =
    team?.invitations.filter((invitation) => invitation.usable).length ?? 0;
  const expired =
    team?.invitations.filter(
      (invitation) => invitation.status === "pending" && !invitation.usable,
    ).length ?? 0;
  return {
    key: "team",
    label: "Team",
    value: team
      ? `${people} ${people === 1 ? "person" : "people"}`
      : "Owner only",
    detail: team
      ? `${pending} active, ${expired} expired invitations`
      : "Team details are owner-only",
    href: "team",
  };
}

function communicationStatus(communications: OrganizerState["communications"]) {
  return {
    key: "communications",
    label: "Communications",
    value: communications?.length
      ? `${communications.length} failed`
      : "No failures",
    detail: communications?.length
      ? "Delivery needs attention"
      : "Delivery is clear",
    href: communications?.length
      ? "communications/deliveries"
      : "communications",
  };
}

function daysUntil(value: string): number {
  return Math.ceil((Date.parse(value) - Date.now()) / 86_400_000);
}

function severityRank(severity: AttentionItem["severity"]): number {
  return severity === "critical" ? 0 : 1;
}

function deadlineTime(deadline: string | null): number {
  return deadline ? Date.parse(deadline) : Number.POSITIVE_INFINITY;
}
