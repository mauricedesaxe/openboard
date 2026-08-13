import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/database/client";
import { sendEventInvitation } from "../src/server/event-team/delivery";
import { createInvitation } from "../src/server/event-team/repository";
import type { UserId } from "../src/shared/events";

const testEnvironment = env as unknown as { DB: D1Database };
const worker = exports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

type TrpcResponse<T> =
  | { result: { data: T } }
  | {
      error: {
        json: { message: string; data: { code: string; httpStatus: number } };
      };
    };

describe("invite the event team", () => {
  test("replaces invitations and accepts an additive role once", async () => {
    const owner = await signIn("team-owner@example.com", "192.0.2.30");
    await createEvent(owner.cookie, "team-event");

    const first = await callTrpc<{ id: string }>(
      "eventTeam.invite",
      { slug: "team-event", email: "reviewer@example.com", role: "reviewer" },
      owner.cookie,
    );
    expect(first.status).toBe(200);
    const firstInvitation = getResult(first.body);
    const firstSecret = await getInvitationSecret("reviewer@example.com");

    const replacement = await callTrpc<{ id: string }>(
      "eventTeam.invite",
      {
        slug: "team-event",
        email: "reviewer+corrected@example.com",
        role: "reviewer",
        replacesInvitationId: firstInvitation.id,
      },
      owner.cookie,
    );
    expect(replacement.status).toBe(200);
    const replacementInvitation = getResult(replacement.body);
    expect(replacementInvitation.id).not.toBe(firstInvitation.id);
    const attempts = await testEnvironment.DB.prepare(
      `SELECT status, secret_hash AS secretHash
       FROM invitations
       WHERE event_id = (SELECT id FROM events WHERE slug = ?)
       ORDER BY created_at`,
    )
      .bind("team-event")
      .all<{ status: string; secretHash: string }>();
    expect(attempts.results.map((attempt) => attempt.status)).toEqual([
      "revoked",
      "pending",
    ]);
    expect(attempts.results.map((attempt) => attempt.secretHash)).not.toContain(
      firstSecret,
    );

    const oldAttempt = await callTrpc(
      "invitations.get",
      { secret: firstSecret },
      undefined,
      "query",
    );
    expect(oldAttempt.status).toBe(409);

    const recipient = await signIn(
      "reviewer+corrected@example.com",
      "192.0.2.31",
    );
    const replacementSecret = await getInvitationSecret(
      "reviewer+corrected@example.com",
    );
    const wrongRecipient = await signIn("wrong@example.com", "192.0.2.37");
    const wrongAcceptance = await callTrpc(
      "invitations.accept",
      { secret: replacementSecret },
      wrongRecipient.cookie,
    );
    expect(wrongAcceptance.status).toBe(403);
    const accepted = await callTrpc<{ eventSlug: string; role: string }>(
      "invitations.accept",
      { secret: replacementSecret },
      recipient.cookie,
    );
    expect(accepted.status).toBe(200);
    expect(getResult(accepted.body)).toEqual({
      eventSlug: "team-event",
      role: "reviewer",
    });

    const replay = await callTrpc(
      "invitations.accept",
      { secret: replacementSecret },
      recipient.cookie,
    );
    expect(replay.status).toBe(409);

    await callTrpc(
      "eventTeam.invite",
      {
        slug: "team-event",
        email: "reviewer+corrected@example.com",
        role: "organizer",
      },
      owner.cookie,
    );
    const organizerSecret = await getInvitationSecret(
      "reviewer+corrected@example.com",
    );
    const additiveAcceptance = await callTrpc(
      "invitations.accept",
      { secret: organizerSecret },
      recipient.cookie,
    );
    expect(additiveAcceptance.status).toBe(200);

    const roles = await testEnvironment.DB.prepare(
      `SELECT role, revoked_at AS revokedAt
       FROM event_roles
       WHERE event_id = (SELECT id FROM events WHERE slug = ?)
         AND user_id = ?
       ORDER BY role`,
    )
      .bind("team-event", recipient.userId)
      .all<{ role: string; revokedAt: number | null }>();
    expect(roles.results).toEqual([
      { role: "organizer", revokedAt: null },
      { role: "reviewer", revokedAt: null },
    ]);

    const visibleEvent = await callTrpc(
      "events.get",
      { slug: "team-event" },
      recipient.cookie,
      "query",
    );
    expect(visibleEvent.status).toBe(200);
  });

  test("lets recipients decline without an account and rejects expired secrets", async () => {
    const owner = await signIn("decline-owner@example.com", "192.0.2.32");
    await createEvent(owner.cookie, "decline-event");

    await callTrpc(
      "eventTeam.invite",
      {
        slug: "decline-event",
        email: "decline@example.com",
        role: "organizer",
      },
      owner.cookie,
    );
    const declineSecret = await getInvitationSecret("decline@example.com");
    const declined = await callTrpc("invitations.decline", {
      secret: declineSecret,
    });
    expect(declined.status).toBe(200);

    const declinedReplay = await callTrpc("invitations.decline", {
      secret: declineSecret,
    });
    expect(declinedReplay.status).toBe(409);
    const declinedUser = await testEnvironment.DB.prepare(
      "SELECT id FROM user WHERE email = ?",
    )
      .bind("decline@example.com")
      .first();
    expect(declinedUser).toBeNull();

    await callTrpc(
      "eventTeam.invite",
      { slug: "decline-event", email: "expired@example.com", role: "reviewer" },
      owner.cookie,
    );
    const expiredSecret = await getInvitationSecret("expired@example.com");
    await testEnvironment.DB.prepare(
      "UPDATE invitations SET expires_at = ? WHERE email = ?",
    )
      .bind(Date.now() - 1, "expired@example.com")
      .run();
    const expired = await callTrpc(
      "invitations.get",
      { secret: expiredSecret },
      undefined,
      "query",
    );
    expect(expired.status).toBe(409);

    const firstResend = await callTrpc<{
      outcome: string;
      id: string;
    }>(
      "eventTeam.invite",
      { slug: "decline-event", email: "resend@example.com", role: "reviewer" },
      owner.cookie,
    );
    const firstResendInvitation = getResult(firstResend.body);
    expect(firstResendInvitation.outcome).toBe("sent");
    const firstResendSecret = await getInvitationSecret("resend@example.com");
    const duplicateResend = await callTrpc<{
      outcome: string;
      id: string;
      email: string;
      role: string;
      expiresAt: string;
    }>(
      "eventTeam.invite",
      { slug: "decline-event", email: "resend@example.com", role: "reviewer" },
      owner.cookie,
    );
    const duplicateResult = getResult(duplicateResend.body);
    expect(duplicateResult).toMatchObject({
      outcome: "already_pending",
      id: firstResendInvitation.id,
      email: "resend@example.com",
      role: "reviewer",
    });
    expect(typeof duplicateResult.expiresAt).toBe("string");
    expect(await getInvitationSecret("resend@example.com")).toBe(
      firstResendSecret,
    );
    const duplicateAttempts = await testEnvironment.DB.prepare(
      "SELECT status FROM invitations WHERE email = ? ORDER BY created_at",
    )
      .bind("resend@example.com")
      .all<{ status: string }>();
    expect(duplicateAttempts.results).toEqual([{ status: "pending" }]);

    const explicitResend = await callTrpc<{ outcome: string }>(
      "eventTeam.invite",
      {
        slug: "decline-event",
        email: "resend@example.com",
        role: "reviewer",
        replacesInvitationId: firstResendInvitation.id,
      },
      owner.cookie,
    );
    expect(getResult(explicitResend.body).outcome).toBe("sent");
    const secondResendSecret = await getInvitationSecret("resend@example.com");
    expect(secondResendSecret).not.toBe(firstResendSecret);
    const supersededResend = await callTrpc(
      "invitations.get",
      { secret: firstResendSecret },
      undefined,
      "query",
    );
    expect(supersededResend.status).toBe(409);
    const resendAttempts = await testEnvironment.DB.prepare(
      "SELECT status FROM invitations WHERE email = ? ORDER BY created_at",
    )
      .bind("resend@example.com")
      .all<{ status: string }>();
    expect(resendAttempts.results).toEqual([
      { status: "revoked" },
      { status: "pending" },
    ]);

    const cancellable = await callTrpc<{ id: string }>(
      "eventTeam.invite",
      {
        slug: "decline-event",
        email: "cancelled@example.com",
        role: "reviewer",
      },
      owner.cookie,
    );
    const cancelledSecret = await getInvitationSecret("cancelled@example.com");
    const revoked = await callTrpc(
      "eventTeam.revokeInvitation",
      {
        slug: "decline-event",
        invitationId: getResult(cancellable.body).id,
      },
      owner.cookie,
    );
    expect(revoked.status).toBe(200);
    const revokedInvitation = await callTrpc(
      "invitations.get",
      { secret: cancelledSecret },
      undefined,
      "query",
    );
    expect(revokedInvitation.status).toBe(409);
  });

  test("limits team management to the owner and revokes reviewer assignments", async () => {
    const owner = await signIn("access-owner@example.com", "192.0.2.33");
    const organizer = await signIn("organizer@example.com", "192.0.2.34");
    const reviewer = await signIn(
      "assigned-reviewer@example.com",
      "192.0.2.35",
    );
    const unrelated = await signIn("outsider@example.com", "192.0.2.36");
    await createEvent(owner.cookie, "access-event");

    const organizerRoleId = await inviteAndAccept({
      ownerCookie: owner.cookie,
      recipientCookie: organizer.cookie,
      email: "organizer@example.com",
      role: "organizer",
      slug: "access-event",
    });
    const reviewerRoleId = await inviteAndAccept({
      ownerCookie: owner.cookie,
      recipientCookie: reviewer.cookie,
      email: "assigned-reviewer@example.com",
      role: "reviewer",
      slug: "access-event",
    });

    const ownerList = await callTrpc<{
      roles: Array<{ id: string; userId: string; role: string }>;
    }>("eventTeam.list", { slug: "access-event" }, owner.cookie, "query");
    expect(ownerList.status).toBe(200);

    const ownerRoles = getResult(ownerList.body).roles.filter(
      (role) => role.userId === owner.userId,
    );
    expect(ownerRoles.map((role) => role.role).sort()).toEqual([
      "organizer",
      "reviewer",
    ]);
    for (const ownerRole of ownerRoles) {
      const ownerRoleRevocation = await callTrpc(
        "eventTeam.revokeRole",
        { slug: "access-event", roleId: ownerRole.id },
        owner.cookie,
      );
      expect(ownerRoleRevocation.status).toBe(404);
    }
    const activeOwnerRoles = await testEnvironment.DB.prepare(
      `SELECT role FROM event_roles
       WHERE event_id = (SELECT id FROM events WHERE slug = ?)
         AND user_id = ?
         AND revoked_at IS NULL
       ORDER BY role`,
    )
      .bind("access-event", owner.userId)
      .all<{ role: string }>();
    expect(activeOwnerRoles.results.map(({ role }) => role)).toEqual([
      "organizer",
      "reviewer",
    ]);

    for (const actor of [organizer, reviewer, unrelated]) {
      const forbidden = await callTrpc(
        "eventTeam.invite",
        { slug: "access-event", email: "new@example.com", role: "reviewer" },
        actor.cookie,
      );
      expect(forbidden.status).toBe(404);

      const forbiddenList = await callTrpc(
        "eventTeam.list",
        { slug: "access-event" },
        actor.cookie,
        "query",
      );
      expect(forbiddenList.status).toBe(404);
    }

    const cancellable = await callTrpc<{ id: string }>(
      "eventTeam.invite",
      {
        slug: "access-event",
        email: "matrix-cancel@example.com",
        role: "reviewer",
      },
      owner.cookie,
    );
    for (const actor of [organizer, reviewer, unrelated]) {
      const forbiddenRevocation = await callTrpc(
        "eventTeam.revokeInvitation",
        {
          slug: "access-event",
          invitationId: getResult(cancellable.body).id,
        },
        actor.cookie,
      );
      expect(forbiddenRevocation.status).toBe(404);
    }
    const ownerRevocation = await callTrpc(
      "eventTeam.revokeInvitation",
      {
        slug: "access-event",
        invitationId: getResult(cancellable.body).id,
      },
      owner.cookie,
    );
    expect(ownerRevocation.status).toBe(200);

    const event = await testEnvironment.DB.prepare(
      "SELECT id FROM events WHERE slug = ?",
    )
      .bind("access-event")
      .first<{ id: string }>();
    expect(event).toBeTruthy();
    const track = getResult(
      await callTrpc<{ id: string }>(
        "tracks.create",
        { slug: "access-event", name: "Review track" },
        owner.cookie,
      ).then((response) => response.body),
    );
    const draft = getResult(
      await callTrpc<{
        id: string;
        name: string;
        deadline: string;
        formats: string[];
        customFields: unknown[];
      }>(
        "cfps.createDraft",
        {
          slug: "access-event",
          name: "Review access CFP",
          deadline: "2027-05-01T00:00:00Z",
          formats: ["Talk"],
          customFields: [],
        },
        owner.cookie,
      ).then((response) => response.body),
    );
    await callTrpc(
      "cfps.open",
      { slug: "access-event", cfpId: draft.id, ...draft },
      owner.cookie,
    );
    const proposal = getResult(
      await callTrpc<{ id: string }>(
        "submissions.submit",
        {
          slug: "access-event",
          cfpId: draft.id,
          clientDraftId: crypto.randomUUID(),
          title: "Reviewer access history",
          abstract: "Preserve the assignment when its event role is revoked.",
          format: "Talk",
          trackId: track.id,
          proposedSpeakers: [
            { name: "Event Owner", email: "access-owner@example.com" },
          ],
          customAnswers: {},
        },
        owner.cookie,
      ).then((response) => response.body),
    );
    const round = await testEnvironment.DB.prepare(
      "SELECT id FROM review_rounds WHERE cfp_id = ?",
    )
      .bind(draft.id)
      .first<{ id: string }>();
    expect(round).toBeTruthy();
    await testEnvironment.DB.prepare(
      `INSERT INTO reviewer_assignments
       (id, event_id, review_round_id, submission_id, reviewer_user_id,
        assigned_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        event?.id,
        round?.id,
        proposal.id,
        reviewer.userId,
        owner.userId,
        Date.now(),
      )
      .run();

    for (const actor of [organizer, reviewer, unrelated]) {
      const forbiddenRevocation = await callTrpc(
        "eventTeam.revokeRole",
        { slug: "access-event", roleId: reviewerRoleId },
        actor.cookie,
      );
      expect(forbiddenRevocation.status).toBe(404);
    }

    const revoke = await callTrpc(
      "eventTeam.revokeRole",
      { slug: "access-event", roleId: reviewerRoleId },
      owner.cookie,
    );
    expect(revoke.status).toBe(200);
    const assignment = await testEnvironment.DB.prepare(
      `SELECT revoked_at AS revokedAt, revoked_by_user_id AS revokedByUserId
       FROM reviewer_assignments WHERE reviewer_user_id = ?`,
    )
      .bind(reviewer.userId)
      .first<{ revokedAt: number | null; revokedByUserId: string | null }>();
    expect(assignment?.revokedAt).toEqual(expect.any(Number));
    expect(assignment?.revokedByUserId).toBe(owner.userId);

    const reviewerEvent = await callTrpc(
      "events.get",
      { slug: "access-event" },
      reviewer.cookie,
      "query",
    );
    expect(reviewerEvent.status).toBe(404);

    const organizerEvent = await callTrpc(
      "events.get",
      { slug: "access-event" },
      organizer.cookie,
      "query",
    );
    expect(organizerEvent.status).toBe(200);
    expect(organizerRoleId).not.toBe(reviewerRoleId);
  });

  test("allows only one terminal outcome when accept and decline race", async () => {
    const owner = await signIn("race-owner@example.com", "192.0.2.38");
    const recipient = await signIn("race-recipient@example.com", "192.0.2.39");
    await createEvent(owner.cookie, "race-event");
    await callTrpc(
      "eventTeam.invite",
      {
        slug: "race-event",
        email: "race-recipient@example.com",
        role: "reviewer",
      },
      owner.cookie,
    );
    const secret = await getInvitationSecret("race-recipient@example.com");

    const [acceptance, decline] = await Promise.all([
      callTrpc("invitations.accept", { secret }, recipient.cookie),
      callTrpc("invitations.decline", { secret }),
    ]);
    expect([acceptance.status, decline.status].sort()).toEqual([200, 409]);

    const invitation = await testEnvironment.DB.prepare(
      "SELECT status FROM invitations WHERE email = ?",
    )
      .bind("race-recipient@example.com")
      .first<{ status: string }>();
    const role = await testEnvironment.DB.prepare(
      "SELECT id FROM event_roles WHERE user_id = ? AND revoked_at IS NULL",
    )
      .bind(recipient.userId)
      .first<{ id: string }>();
    expect(invitation?.status).toBe(
      acceptance.status === 200 ? "accepted" : "declined",
    );
    expect(Boolean(role)).toBe(acceptance.status === 200);
  });

  test("allows only one replacement for a source invitation", async () => {
    const owner = await signIn("replace-owner@example.com", "192.0.2.41");
    await createEvent(owner.cookie, "replace-race-event");
    const source = getResult(
      (
        await callTrpc<{ id: string }>(
          "eventTeam.invite",
          {
            slug: "replace-race-event",
            email: "replace-source@example.com",
            role: "reviewer",
          },
          owner.cookie,
        )
      ).body,
    );

    const replacements = await Promise.all([
      callTrpc(
        "eventTeam.invite",
        {
          slug: "replace-race-event",
          email: "replace-first@example.com",
          role: "reviewer",
          replacesInvitationId: source.id,
        },
        owner.cookie,
      ),
      callTrpc(
        "eventTeam.invite",
        {
          slug: "replace-race-event",
          email: "replace-second@example.com",
          role: "reviewer",
          replacesInvitationId: source.id,
        },
        owner.cookie,
      ),
    ]);
    expect(replacements.map(({ status }) => status).sort()).toEqual([200, 409]);

    const rows = await testEnvironment.DB.prepare(
      `SELECT status, replacement_for_invitation_id AS sourceId
       FROM invitations
       WHERE event_id = (SELECT id FROM events WHERE slug = ?)
       ORDER BY created_at`,
    )
      .bind("replace-race-event")
      .all<{ status: string; sourceId: string | null }>();
    expect(
      rows.results.filter(({ sourceId }) => sourceId === source.id),
    ).toHaveLength(1);
    expect(
      rows.results.filter(({ status }) => status === "pending"),
    ).toHaveLength(1);
  });

  test("allows either acceptance or replacement to claim an invitation", async () => {
    const owner = await signIn("claim-owner@example.com", "192.0.2.43");
    const recipient = await signIn("claim-recipient@example.com", "192.0.2.44");
    await createEvent(owner.cookie, "claim-race-event");
    const source = getResult(
      (
        await callTrpc<{ id: string }>(
          "eventTeam.invite",
          {
            slug: "claim-race-event",
            email: "claim-recipient@example.com",
            role: "reviewer",
          },
          owner.cookie,
        )
      ).body,
    );
    const secret = await getInvitationSecret("claim-recipient@example.com");

    const [acceptance, replacement] = await Promise.all([
      callTrpc("invitations.accept", { secret }, recipient.cookie),
      callTrpc(
        "eventTeam.invite",
        {
          slug: "claim-race-event",
          email: "claim-corrected@example.com",
          role: "reviewer",
          replacesInvitationId: source.id,
        },
        owner.cookie,
      ),
    ]);
    expect([acceptance.status, replacement.status].sort()).toEqual([200, 409]);

    const sourceRow = await testEnvironment.DB.prepare(
      "SELECT status FROM invitations WHERE id = ?",
    )
      .bind(source.id)
      .first<{ status: string }>();
    const role = await testEnvironment.DB.prepare(
      "SELECT id FROM event_roles WHERE invitation_id = ? AND revoked_at IS NULL",
    )
      .bind(source.id)
      .first<{ id: string }>();
    expect(sourceRow?.status).toBe(
      acceptance.status === 200 ? "accepted" : "revoked",
    );
    expect(Boolean(role)).toBe(acceptance.status === 200);
  });

  test("keeps a failed email delivery resendable", async () => {
    const owner = await signIn("delivery-owner@example.com", "192.0.2.40");
    await createEvent(owner.cookie, "delivery-event");
    const database = createDatabase(testEnvironment.DB);
    const input = {
      slug: "delivery-event",
      email: "delivery-recipient@example.com",
      role: "organizer" as const,
    };
    const first = await createInvitation(
      database,
      owner.userId as UserId,
      input,
    );
    expect(first.ok).toBe(true);
    if (!first.ok || first.outcome !== "created") return;

    const failingConfig: AppConfig = {
      appEnv: "production",
      appUrl: "https://localhost",
      authSecret: "test-secret-that-is-at-least-thirty-two-characters",
      email: {
        type: "cloudflare",
        from: "auth@example.com",
        sender: {
          send: () => Promise.reject(new Error("Email service unavailable")),
        },
      },
    };
    await expect(
      sendEventInvitation(failingConfig, first.value),
    ).rejects.toThrow("Email service unavailable");

    const duplicate = await createInvitation(
      database,
      owner.userId as UserId,
      input,
    );
    expect(duplicate.ok && duplicate.outcome).toBe("already_pending");
    if (!duplicate.ok) return;
    expect(duplicate.value.id).toBe(first.value.id);

    const retry = await createInvitation(database, owner.userId as UserId, {
      ...input,
      replacesInvitationId: first.value.id,
    });
    expect(retry.ok && retry.outcome).toBe("created");
    if (!retry.ok || retry.outcome !== "created") return;
    expect(retry.value.id).not.toBe(first.value.id);
    const attempts = await testEnvironment.DB.prepare(
      "SELECT status FROM invitations WHERE email = ? ORDER BY created_at",
    )
      .bind(input.email)
      .all<{ status: string }>();
    expect(attempts.results).toEqual([
      { status: "revoked" },
      { status: "pending" },
    ]);
  });
});

async function inviteAndAccept(input: {
  ownerCookie: string;
  recipientCookie: string;
  email: string;
  role: "organizer" | "reviewer";
  slug: string;
}): Promise<string> {
  await callTrpc(
    "eventTeam.invite",
    { slug: input.slug, email: input.email, role: input.role },
    input.ownerCookie,
  );
  const secret = await getInvitationSecret(input.email);
  await callTrpc("invitations.accept", { secret }, input.recipientCookie);
  const role = await testEnvironment.DB.prepare(
    `SELECT event_roles.id
     FROM event_roles
     INNER JOIN user ON user.id = event_roles.user_id
     WHERE user.email = ? AND event_roles.role = ? AND event_roles.revoked_at IS NULL`,
  )
    .bind(input.email, input.role)
    .first<{ id: string }>();
  expect(role).toBeTruthy();
  return role?.id ?? "";
}

async function createEvent(cookie: string, slug: string): Promise<void> {
  const response = await callTrpc(
    "events.create",
    {
      name: slug,
      slug,
      startsOn: "2027-05-12",
      endsOn: "2027-05-14",
      timezone: "Europe/London",
    },
    cookie,
  );
  expect(response.status).toBe(200);
}

async function getInvitationSecret(email: string): Promise<string> {
  const response = await workerFetch(
    `/api/dev/invitation-secret?email=${encodeURIComponent(email)}`,
  );
  expect(response.status).toBe(200);
  const body = await response.json<{ secret: string }>();
  return body.secret;
}

async function signIn(
  email: string,
  ipAddress: string,
): Promise<{ cookie: string; userId: string }> {
  const headers = {
    "CF-Connecting-IP": ipAddress,
    "Content-Type": "application/json",
  };
  const requestCode = await workerFetch(
    "/api/auth/email-otp/send-verification-otp",
    {
      method: "POST",
      body: JSON.stringify({ email, type: "sign-in" }),
      headers,
    },
  );
  expect(requestCode.status).toBe(200);
  const captured = await workerFetch(
    `/api/dev/auth-code?email=${encodeURIComponent(email)}`,
  );
  const { code } = await captured.json<{ code: string }>();
  const verify = await workerFetch("/api/auth/sign-in/email-otp", {
    method: "POST",
    body: JSON.stringify({ email, otp: code }),
    headers,
  });
  expect(verify.status).toBe(200);
  const cookie = verify.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const user = await testEnvironment.DB.prepare(
    "SELECT id FROM user WHERE email = ?",
  )
    .bind(email)
    .first<{ id: string }>();
  return { cookie, userId: user?.id ?? "" };
}

async function callTrpc<T = unknown>(
  procedure: string,
  input: unknown,
  cookie?: string,
  type: "mutation" | "query" = "mutation",
): Promise<{ status: number; body: TrpcResponse<T> }> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (cookie) headers.set("Cookie", cookie);
  const path =
    type === "query"
      ? `/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `/api/trpc/${procedure}`;
  const response = await workerFetch(
    path,
    type === "query"
      ? { method: "GET", headers }
      : { method: "POST", headers, body: JSON.stringify(input) },
  );
  return {
    status: response.status,
    body: await response.json<TrpcResponse<T>>(),
  };
}

function getResult<T>(response: TrpcResponse<T>): T {
  if ("error" in response) throw new Error(response.error.json.message);
  return response.result.data;
}

function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  return worker.default.fetch(new Request(`https://localhost${path}`, init));
}
