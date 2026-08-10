import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

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

    const role = await testEnvironment.DB.prepare(
      `SELECT role, revoked_at AS revokedAt
       FROM event_roles
       WHERE event_id = (SELECT id FROM events WHERE slug = ?)
         AND user_id = ?`,
    )
      .bind("team-event", recipient.userId)
      .first<{ role: string; revokedAt: number | null }>();
    expect(role).toEqual({ role: "reviewer", revokedAt: null });

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

    for (const actor of [organizer, reviewer, unrelated]) {
      const forbidden = await callTrpc(
        "eventTeam.invite",
        { slug: "access-event", email: "new@example.com", role: "reviewer" },
        actor.cookie,
      );
      expect(forbidden.status).toBe(404);
    }

    const event = await testEnvironment.DB.prepare(
      "SELECT id FROM events WHERE slug = ?",
    )
      .bind("access-event")
      .first<{ id: string }>();
    expect(event).toBeTruthy();
    await testEnvironment.DB.prepare(
      `INSERT INTO reviewer_assignments
       (id, event_id, review_round_id, submission_id, reviewer_user_id,
        assigned_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        event?.id,
        crypto.randomUUID(),
        crypto.randomUUID(),
        reviewer.userId,
        owner.userId,
        Date.now(),
      )
      .run();

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
