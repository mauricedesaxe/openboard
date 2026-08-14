import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  callTrpc,
  getResult,
  signIn,
  testEnvironment,
  workerFetch,
} from "./support";

const idSchema = z.object({ id: z.string() });
const assignmentSchema = z.object({ id: z.string() });
const fileAnswerSchema = z.object({
  fieldKey: z.string(),
  id: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  url: z.string(),
});
const boardSchema = z.object({
  round: z.object({
    id: z.string(),
    status: z.enum(["draft", "open", "closed"]),
  }),
  reviewers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      assigned: z.number().int(),
      completed: z.number().int(),
    }),
  ),
  submissions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(["active", "withdrawn"]),
      fileAnswers: z.array(fileAnswerSchema),
      decision: z.object({
        status: z.enum([
          "pending",
          "accept_queued",
          "decline_queued",
          "accepted",
          "declined",
        ]),
        revision: z.number().int(),
      }),
      review: z.object({
        assigned: z.number().int(),
        completed: z.number().int(),
        average: z.number().nullable(),
        assignments: z.array(
          z.object({
            id: z.string(),
            reviewerUserId: z.string(),
            reviewerName: z.string(),
            reviewerEmail: z.string(),
            score: z.number().nullable(),
            comment: z.string().nullable(),
          }),
        ),
      }),
    }),
  ),
});
const mineSchema = z.array(
  z.object({
    assignmentId: z.string(),
    roundStatus: z.enum(["draft", "open", "closed"]),
    submission: z.object({
      id: z.string(),
      title: z.string(),
      abstract: z.string(),
      format: z.string(),
      track: z.string(),
      fileAnswers: z.array(fileAnswerSchema),
    }),
    review: z
      .object({ score: z.number(), comment: z.string().nullable() })
      .nullable(),
  }),
);
const ownerSubmissionSchema = z.object({
  decision: z.object({
    status: z.enum(["pending", "accepted", "declined"]),
  }),
});

describe("review submissions and publish decisions", () => {
  test("limits proposal attachments to organizers and assigned reviewers", async () => {
    const slug = "review-attachments-2027";
    const owner = await signIn("review-file-owner@example.com");
    const organizer = await signIn("review-file-organizer@example.com");
    const reviewer = await signIn("review-file-assigned@example.com");
    const unassignedReviewer = await signIn(
      "review-file-unassigned@example.com",
    );
    const submissionOwner = await signIn("review-file-submit@example.com");

    await createEvent(owner.cookie, slug);
    await inviteAndAccept(
      owner.cookie,
      organizer.cookie,
      slug,
      "review-file-organizer@example.com",
      "organizer",
    );
    await inviteAndAccept(
      owner.cookie,
      reviewer.cookie,
      slug,
      "review-file-assigned@example.com",
      "reviewer",
    );
    await inviteAndAccept(
      owner.cookie,
      unassignedReviewer.cookie,
      slug,
      "review-file-unassigned@example.com",
      "reviewer",
    );
    const track = getResult(
      (
        await callTrpc(
          "tracks.create",
          { slug, name: "Software design" },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    const cfp = getResult(
      (
        await callTrpc(
          "cfps.createDraft",
          {
            slug,
            name: "Attachment review CFP",
            deadline: "2027-06-01T00:00:00Z",
            formats: ["Talk"],
            customFields: [
              {
                key: "outline",
                label: "Session outline",
                type: "file",
                required: true,
                acceptedTypes: ["application/pdf"],
                maxSizeMb: 1,
              },
            ],
          },
          owner.cookie,
        )
      ).body,
      z.object({
        id: z.string(),
        name: z.string(),
        deadline: z.string(),
        formats: z.array(z.string()),
        customFields: z.array(z.unknown()),
      }),
    );
    expect(
      (
        await callTrpc(
          "cfps.open",
          {
            slug,
            cfpId: cfp.id,
            expectedDeadline: cfp.deadline,
            name: cfp.name,
            deadline: cfp.deadline,
            formats: cfp.formats,
            customFields: cfp.customFields,
          },
          owner.cookie,
        )
      ).status,
    ).toBe(200);

    const clientDraftId = crypto.randomUUID();
    const fileContents = "%PDF-1.7 reviewer attachment";
    const uploaded = getResult(
      (
        await callTrpc(
          "submissions.uploadFile",
          {
            slug,
            cfpId: cfp.id,
            clientDraftId,
            uploadId: crypto.randomUUID(),
            fieldKey: "outline",
            customAnswers: {},
            fileName: "session outline.pdf",
            contentType: "application/pdf",
            contentBase64: btoa(fileContents),
          },
          submissionOwner.cookie,
        )
      ).body,
      z.object({ id: z.string() }),
    );
    const submission = getResult(
      (
        await callTrpc(
          "submissions.submit",
          {
            slug,
            cfpId: cfp.id,
            clientDraftId,
            title: "Review attachments without exposing them",
            abstract: "Keep proposal files private to the review workflow.",
            format: "Talk",
            trackId: track.id,
            proposedSpeakers: [
              { name: "Attachment Speaker", email: "attachment@example.com" },
            ],
            customAnswers: {},
            fileAnswers: { outline: uploaded.id },
          },
          submissionOwner.cookie,
        )
      ).body,
      idSchema,
    );
    const assignment = getResult(
      (
        await callTrpc(
          "reviews.assign",
          {
            slug,
            submissionId: submission.id,
            reviewerUserId: reviewer.userId,
          },
          owner.cookie,
        )
      ).body,
      assignmentSchema,
    );

    const board = getResult(
      (
        await callTrpc(
          "reviews.organizerBoard",
          { slug },
          owner.cookie,
          "query",
        )
      ).body,
      boardSchema,
    );
    const file = board.submissions[0]?.fileAnswers[0];
    expect(file).toMatchObject({
      fieldKey: "outline",
      id: uploaded.id,
      fileName: "session outline.pdf",
      contentType: "application/pdf",
      sizeBytes: fileContents.length,
    });
    expect(file?.url).toBe(`/api/submission-files/${uploaded.id}`);

    expect(
      (await workerFetch(file?.url ?? "/api/submission-files/missing")).status,
    ).toBe(404);
    expect(
      (
        await workerFetch(file?.url ?? "/api/submission-files/missing", {
          headers: { Cookie: unassignedReviewer.cookie },
        })
      ).status,
    ).toBe(404);
    const organizerDownload = await workerFetch(
      file?.url ?? "/api/submission-files/missing",
      { headers: { Cookie: organizer.cookie } },
    );
    expect(organizerDownload.status).toBe(200);
    expect(
      new TextDecoder().decode(await organizerDownload.arrayBuffer()),
    ).toBe(fileContents);

    expect(
      (await callTrpc("reviews.openRound", { slug }, owner.cookie)).status,
    ).toBe(200);
    const mine = getResult(
      (await callTrpc("reviews.mine", { slug }, reviewer.cookie, "query")).body,
      mineSchema,
    );
    expect(mine[0]?.submission.fileAnswers).toEqual([file]);
    const reviewerDownload = await workerFetch(
      file?.url ?? "/api/submission-files/missing",
      { headers: { Cookie: reviewer.cookie } },
    );
    expect(reviewerDownload.status).toBe(200);
    expect(reviewerDownload.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(reviewerDownload.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''session%20outline.pdf",
    );
    expect(reviewerDownload.headers.get("content-type")).toBe(
      "application/pdf",
    );
    expect(reviewerDownload.headers.get("x-content-type-options")).toBe(
      "nosniff",
    );
    expect(new TextDecoder().decode(await reviewerDownload.arrayBuffer())).toBe(
      fileContents,
    );

    expect(
      (
        await callTrpc(
          "reviews.revokeAssignment",
          { slug, assignmentId: assignment.id },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      getResult(
        (await callTrpc("reviews.mine", { slug }, reviewer.cookie, "query"))
          .body,
        mineSchema,
      ),
    ).toEqual([]);
    expect(
      (
        await workerFetch(file?.url ?? "/api/submission-files/missing", {
          headers: { Cookie: reviewer.cookie },
        })
      ).status,
    ).toBe(404);
  });

  test("runs one blinded round and publishes selected outcomes atomically", async () => {
    const slug = "review-flow-2027";
    const owner = await signIn("review-owner@example.com");
    const organizer = await signIn("review-organizer@example.com");
    const reviewer = await signIn("reviewer-one@example.com");
    const secondReviewer = await signIn("reviewer-two@example.com");
    const firstSubmissionOwner = await signIn("review-submit-one@example.com");
    const secondSubmissionOwner = await signIn("review-submit-two@example.com");
    const thirdSubmissionOwner = await signIn(
      "review-submit-three@example.com",
    );
    const unrelated = await signIn("review-outsider@example.com");

    await createEvent(owner.cookie, slug);
    await inviteAndAccept(
      owner.cookie,
      organizer.cookie,
      slug,
      organizerEmail,
      "organizer",
    );
    await inviteAndAccept(
      owner.cookie,
      reviewer.cookie,
      slug,
      reviewerEmail,
      "reviewer",
    );
    await inviteAndAccept(
      owner.cookie,
      secondReviewer.cookie,
      slug,
      secondReviewerEmail,
      "reviewer",
    );
    const track = getResult(
      (
        await callTrpc(
          "tracks.create",
          { slug, name: "Engineering" },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    const cfp = getResult(
      (
        await callTrpc(
          "cfps.createDraft",
          {
            slug,
            name: "OpenBoard CFP",
            deadline: "2027-06-01T00:00:00Z",
            formats: ["Talk"],
            customFields: [
              {
                key: "private_note",
                label: "Private identifying note",
                type: "short_text",
                required: false,
              },
            ],
          },
          owner.cookie,
        )
      ).body,
      z.object({
        id: z.string(),
        name: z.string(),
        deadline: z.string(),
        formats: z.array(z.string()),
        customFields: z.array(z.unknown()),
      }),
    );
    await callTrpc(
      "cfps.open",
      {
        slug,
        cfpId: cfp.id,
        expectedDeadline: cfp.deadline,
        name: cfp.name,
        deadline: cfp.deadline,
        formats: cfp.formats,
        customFields: cfp.customFields,
      },
      owner.cookie,
    );
    const first = await submitProposal(
      firstSubmissionOwner.cookie,
      slug,
      cfp.id,
      track.id,
      "A calm review system",
      "Visible abstract for the first proposal.",
    );
    await testEnvironment.DB.prepare(
      "UPDATE submission_speakers SET claimed_user_id = ? WHERE submission_id = ?",
    )
      .bind(firstSubmissionOwner.userId, first.id)
      .run();
    const second = await submitProposal(
      secondSubmissionOwner.cookie,
      slug,
      cfp.id,
      track.id,
      "A reliable agenda system",
      "Visible abstract for the second proposal.",
    );
    const withdrawn = await submitProposal(
      thirdSubmissionOwner.cookie,
      slug,
      cfp.id,
      track.id,
      "A withdrawn proposal",
      "This proposal leaves before publication.",
    );

    expect(
      (
        await callTrpc(
          "reviews.organizerBoard",
          { slug },
          unrelated.cookie,
          "query",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await callTrpc(
          "reviews.assign",
          { slug, submissionId: first.id, reviewerUserId: reviewer.userId },
          reviewer.cookie,
        )
      ).status,
    ).toBe(404);

    let board = getResult(
      (
        await callTrpc(
          "reviews.organizerBoard",
          { slug },
          organizer.cookie,
          "query",
        )
      ).body,
      boardSchema,
    );
    expect(board.round.status).toBe("draft");
    expect(board.reviewers.map((candidate) => candidate.email)).toEqual([
      "review-owner@example.com",
      reviewerEmail,
      secondReviewerEmail,
    ]);
    expect(
      board.reviewers.map(({ assigned, completed, email }) => ({
        assigned,
        completed,
        email,
      })),
    ).toEqual([
      { assigned: 0, completed: 0, email: "review-owner@example.com" },
      { assigned: 0, completed: 0, email: reviewerEmail },
      { assigned: 0, completed: 0, email: secondReviewerEmail },
    ]);
    const firstAssignment = getResult(
      (
        await callTrpc(
          "reviews.assign",
          { slug, submissionId: first.id, reviewerUserId: reviewer.userId },
          organizer.cookie,
        )
      ).body,
      assignmentSchema,
    );
    expect(
      (
        await callTrpc(
          "reviews.assign",
          {
            slug,
            submissionId: first.id,
            reviewerUserId: unrelated.userId,
          },
          organizer.cookie,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await callTrpc(
          "reviews.revokeAssignment",
          { slug, assignmentId: firstAssignment.id },
          unrelated.cookie,
        )
      ).status,
    ).toBe(404);
    const incompleteAssignment = getResult(
      (
        await callTrpc(
          "reviews.assign",
          {
            slug,
            submissionId: second.id,
            reviewerUserId: secondReviewer.userId,
          },
          owner.cookie,
        )
      ).body,
      assignmentSchema,
    );
    expect(
      (
        await callTrpc(
          "reviews.save",
          {
            assignmentId: firstAssignment.id,
            score: 4,
            comment: "Strong proposal.",
          },
          reviewer.cookie,
        )
      ).status,
    ).toBe(409);
    expect(
      (await callTrpc("reviews.openRound", { slug }, organizer.cookie)).status,
    ).toBe(200);
    const mine = getResult(
      (await callTrpc("reviews.mine", { slug }, reviewer.cookie, "query")).body,
      mineSchema,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      assignmentId: firstAssignment.id,
      roundStatus: "open",
      submission: {
        id: first.id,
        title: "A calm review system",
        abstract: "Visible abstract for the first proposal.",
        format: "Talk",
        track: "Engineering",
      },
      review: null,
    });
    expect(JSON.stringify(mine)).not.toContain(firstSubmissionOwner.userId);
    expect(JSON.stringify(mine)).not.toContain("review-submit-one@example.com");
    expect(JSON.stringify(mine)).not.toContain("Private identifying note");

    expect(
      (
        await callTrpc(
          "reviews.save",
          {
            assignmentId: firstAssignment.id,
            score: 4,
            comment: "Strong proposal.",
          },
          reviewer.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "reviews.save",
          {
            assignmentId: firstAssignment.id,
            score: 5,
            comment: "Ready to accept.",
          },
          reviewer.cookie,
        )
      ).status,
    ).toBe(200);
    board = getResult(
      (
        await callTrpc(
          "reviews.organizerBoard",
          { slug },
          owner.cookie,
          "query",
        )
      ).body,
      boardSchema,
    );
    expect(
      board.submissions.find((submission) => submission.id === first.id)
        ?.review,
    ).toMatchObject({
      assigned: 1,
      completed: 1,
      average: 5,
    });
    expect(board.reviewers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: reviewerEmail,
          assigned: 1,
          completed: 1,
        }),
        expect.objectContaining({
          email: secondReviewerEmail,
          assigned: 1,
          completed: 0,
        }),
      ]),
    );
    expect(
      board.submissions.find((submission) => submission.id === first.id)?.review
        .assignments[0],
    ).toMatchObject({
      reviewerEmail,
      score: 5,
      comment: "Ready to accept.",
    });

    expect(
      (
        await callTrpc(
          "reviews.revokeAssignment",
          { slug, assignmentId: firstAssignment.id },
          organizer.cookie,
        )
      ).status,
    ).toBe(200);
    board = getResult(
      (
        await callTrpc(
          "reviews.organizerBoard",
          { slug },
          owner.cookie,
          "query",
        )
      ).body,
      boardSchema,
    );
    expect(
      board.submissions.find((submission) => submission.id === first.id)
        ?.review,
    ).toMatchObject({
      assigned: 0,
      completed: 0,
      average: null,
      assignments: [],
    });
    const reassigned = getResult(
      (
        await callTrpc(
          "reviews.assign",
          { slug, submissionId: first.id, reviewerUserId: reviewer.userId },
          owner.cookie,
        )
      ).body,
      assignmentSchema,
    );
    expect(reassigned.id).not.toBe(firstAssignment.id);
    const reassignedMine = getResult(
      (await callTrpc("reviews.mine", { slug }, reviewer.cookie, "query")).body,
      mineSchema,
    );
    expect(reassignedMine[0]?.review).toBeNull();
    await callTrpc(
      "reviews.save",
      { assignmentId: reassigned.id, score: 3, comment: null },
      reviewer.cookie,
    );

    expect(
      (
        await callTrpc(
          "reviews.closeRound",
          { slug, allowMissingReviews: false },
          organizer.cookie,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await callTrpc(
          "reviews.closeRound",
          { slug, allowMissingReviews: true },
          organizer.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "reviews.revokeAssignment",
          { slug, assignmentId: reassigned.id },
          organizer.cookie,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await callTrpc(
          "reviews.save",
          { assignmentId: reassigned.id, score: 4, comment: null },
          reviewer.cookie,
        )
      ).status,
    ).toBe(409);

    await callTrpc(
      "decisions.queue",
      { slug, submissionId: first.id, status: "accept_queued" },
      organizer.cookie,
    );
    await callTrpc(
      "decisions.queue",
      { slug, submissionId: second.id, status: "decline_queued" },
      owner.cookie,
    );
    expect(
      getResult(
        (
          await callTrpc(
            "submissions.get",
            { submissionId: first.id },
            firstSubmissionOwner.cookie,
            "query",
          )
        ).body,
        ownerSubmissionSchema,
      ).decision.status,
    ).toBe("pending");

    expect(
      (await callTrpc("reviews.reopenRound", { slug }, organizer.cookie))
        .status,
    ).toBe(200);
    board = getResult(
      (
        await callTrpc(
          "reviews.organizerBoard",
          { slug },
          owner.cookie,
          "query",
        )
      ).body,
      boardSchema,
    );
    expect(
      board.submissions.map((submission) => submission.decision.status),
    ).toEqual(["pending", "pending", "pending"]);
    await callTrpc(
      "decisions.queue",
      { slug, submissionId: first.id, status: "accept_queued" },
      owner.cookie,
    );
    board = getResult(
      (
        await callTrpc(
          "reviews.organizerBoard",
          { slug },
          owner.cookie,
          "query",
        )
      ).body,
      boardSchema,
    );
    const queuedWhileOpen = board.submissions.find(
      (submission) => submission.id === first.id,
    );
    if (!queuedWhileOpen) throw new Error("Expected queued submission");
    expect(
      (
        await callTrpc(
          "decisions.publish",
          {
            slug,
            selections: [
              {
                submissionId: first.id,
                expectedStatus: "accept_queued",
                expectedRevision: queuedWhileOpen.decision.revision,
              },
            ],
          },
          owner.cookie,
        )
      ).status,
    ).toBe(409);

    await callTrpc(
      "reviews.closeRound",
      { slug, allowMissingReviews: true },
      owner.cookie,
    );
    await callTrpc(
      "decisions.queue",
      { slug, submissionId: second.id, status: "decline_queued" },
      owner.cookie,
    );
    board = getResult(
      (
        await callTrpc(
          "reviews.organizerBoard",
          { slug },
          owner.cookie,
          "query",
        )
      ).body,
      boardSchema,
    );
    const firstQueued = board.submissions.find(
      (submission) => submission.id === first.id,
    );
    const secondQueued = board.submissions.find(
      (submission) => submission.id === second.id,
    );
    expect(firstQueued?.decision.status).toBe("accept_queued");
    expect(secondQueued?.decision.status).toBe("decline_queued");
    if (!firstQueued || !secondQueued)
      throw new Error("Expected queued decisions");

    await callTrpc(
      "decisions.queue",
      { slug, submissionId: second.id, status: "pending" },
      owner.cookie,
    );
    const stalePublication = await callTrpc(
      "decisions.publish",
      {
        slug,
        selections: [
          {
            submissionId: first.id,
            expectedStatus: "accept_queued",
            expectedRevision: firstQueued.decision.revision,
          },
          {
            submissionId: second.id,
            expectedStatus: "decline_queued",
            expectedRevision: secondQueued.decision.revision,
          },
        ],
      },
      owner.cookie,
    );
    expect(stalePublication.status).toBe(409);
    expect(
      (
        await testEnvironment.DB.prepare(
          "SELECT COUNT(*) AS count FROM program_items",
        ).first<{ count: number }>()
      )?.count,
    ).toBe(0);

    await callTrpc(
      "decisions.queue",
      { slug, submissionId: second.id, status: "decline_queued" },
      owner.cookie,
    );
    board = getResult(
      (
        await callTrpc(
          "reviews.organizerBoard",
          { slug },
          owner.cookie,
          "query",
        )
      ).body,
      boardSchema,
    );
    const publishable = board.submissions.filter((submission) =>
      submission.decision.status.endsWith("_queued"),
    );
    const publishSelections = publishable.map((submission) => ({
      submissionId: submission.id,
      expectedStatus: submission.decision.status,
      expectedRevision: submission.decision.revision,
    }));
    await testEnvironment.DB.prepare(
      `CREATE TRIGGER reject_decision_communication
       BEFORE INSERT ON communications
       WHEN NEW.purpose IN ('decision_acceptance', 'decision_decline')
       BEGIN SELECT RAISE(ABORT, 'communication_insert_failed'); END`,
    ).run();
    expect(
      (
        await callTrpc(
          "decisions.publish",
          { slug, selections: publishSelections },
          organizer.cookie,
        )
      ).status,
    ).toBe(500);
    await testEnvironment.DB.prepare(
      "DROP TRIGGER reject_decision_communication",
    ).run();
    expect(
      await testEnvironment.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM decision_publications) AS publications,
           (SELECT COUNT(*) FROM communications WHERE purpose IN ('decision_acceptance', 'decision_decline')) AS communications,
           (SELECT COUNT(*) FROM review_audit_events) AS audits`,
      ).first(),
    ).toEqual({ publications: 0, communications: 0, audits: 0 });
    expect(
      new Map(
        (
          await testEnvironment.DB.prepare(
            "SELECT submission_id AS submissionId, status FROM decisions WHERE submission_id IN (?, ?)",
          )
            .bind(first.id, second.id)
            .all<{ submissionId: string; status: string }>()
        ).results.map((decision) => [decision.submissionId, decision.status]),
      ),
    ).toEqual(
      new Map([
        [first.id, "accept_queued"],
        [second.id, "decline_queued"],
      ]),
    );
    const published = await callTrpc(
      "decisions.publish",
      {
        slug,
        selections: publishSelections,
      },
      organizer.cookie,
    );
    expect(published.status).toBe(200);
    expect(
      (
        await callTrpc(
          "decisions.retryPublicationRecords",
          { slug },
          unrelated.cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      await testEnvironment.DB.prepare(
        "SELECT submission_id AS submissionId FROM program_items",
      ).all<{ submissionId: string }>(),
    ).toMatchObject({ results: [{ submissionId: first.id }] });
    const finalDecisions = await testEnvironment.DB.prepare(
      `SELECT submission_id AS submissionId, status
       FROM decisions
       WHERE submission_id IN (?, ?, ?)
       ORDER BY submission_id`,
    )
      .bind(first.id, second.id, withdrawn.id)
      .all<{ submissionId: string; status: string }>();
    expect(
      new Map(
        finalDecisions.results.map((decision) => [
          decision.submissionId,
          decision.status,
        ]),
      ),
    ).toEqual(
      new Map([
        [first.id, "accepted"],
        [second.id, "declined"],
        [withdrawn.id, "pending"],
      ]),
    );
    expect(
      (
        await testEnvironment.DB.prepare(
          "SELECT COUNT(*) AS count FROM review_audit_events",
        ).first<{ count: number }>()
      )?.count,
    ).toBe(2);
    await testEnvironment.DB.prepare("DELETE FROM review_audit_events").run();
    expect(
      (
        await callTrpc(
          "decisions.retryPublicationRecords",
          { slug },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "decisions.retryPublicationRecords",
          { slug },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      await testEnvironment.DB.prepare(
        `SELECT
             (SELECT COUNT(*) FROM communications WHERE purpose IN ('decision_acceptance', 'decision_decline')) AS communications,
             (SELECT COUNT(*) FROM review_audit_events) AS audits`,
      ).first<{ communications: number; audits: number }>(),
    ).toEqual({ communications: 3, audits: 2 });
    const decisionMessages = await testEnvironment.DB.prepare(
      "SELECT submission_id AS submissionId, recipient_user_id AS recipientUserId, recipient_invitation_id AS recipientInvitationId, purpose FROM communications WHERE purpose IN ('decision_acceptance', 'decision_decline') ORDER BY submission_id",
    ).all<{
      submissionId: string;
      recipientUserId: string | null;
      recipientInvitationId: string | null;
      purpose: string;
    }>();
    expect(decisionMessages.results).toHaveLength(3);
    expect(decisionMessages.results).toEqual(
      expect.arrayContaining([
        {
          submissionId: first.id,
          recipientUserId: firstSubmissionOwner.userId,
          recipientInvitationId: null,
          purpose: "decision_acceptance",
        },
        {
          submissionId: second.id,
          recipientUserId: secondSubmissionOwner.userId,
          recipientInvitationId: null,
          purpose: "decision_decline",
        },
      ]),
    );
    const invitedDecisionMessage = decisionMessages.results.find(
      (message) => message.recipientUserId === null,
    );
    expect(invitedDecisionMessage).toMatchObject({
      submissionId: second.id,
      purpose: "decision_decline",
    });
    expect(typeof invitedDecisionMessage?.recipientInvitationId).toBe("string");
    expect(
      getResult(
        (
          await callTrpc(
            "submissions.get",
            { submissionId: first.id },
            firstSubmissionOwner.cookie,
            "query",
          )
        ).body,
        ownerSubmissionSchema,
      ).decision.status,
    ).toBe("accepted");
    expect(
      (await callTrpc("reviews.reopenRound", { slug }, owner.cookie)).status,
    ).toBe(409);
    expect(
      (
        await callTrpc(
          "decisions.publish",
          { slug, selections: publishSelections },
          owner.cookie,
        )
      ).status,
    ).toBe(409);

    expect(
      (
        await callTrpc(
          "submissions.withdrawOwn",
          { submissionId: withdrawn.id },
          thirdSubmissionOwner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "decisions.queue",
          { slug, submissionId: withdrawn.id, status: "accept_queued" },
          owner.cookie,
        )
      ).status,
    ).toBe(409);
    expect(incompleteAssignment.id).toEqual(expect.any(String));
  });
});

const organizerEmail = "review-organizer@example.com";
const reviewerEmail = "reviewer-one@example.com";
const secondReviewerEmail = "reviewer-two@example.com";

async function createEvent(cookie: string, slug: string): Promise<void> {
  expect(
    (
      await callTrpc(
        "events.create",
        {
          name: "Review Flow Conference",
          slug,
          startsOn: "2027-08-10",
          endsOn: "2027-08-12",
          timezone: "Europe/Berlin",
        },
        cookie,
      )
    ).status,
  ).toBe(200);
}

async function inviteAndAccept(
  ownerCookie: string,
  recipientCookie: string,
  slug: string,
  email: string,
  role: "organizer" | "reviewer",
): Promise<void> {
  expect(
    (await callTrpc("eventTeam.invite", { slug, email, role }, ownerCookie))
      .status,
  ).toBe(200);
  const secretResponse = await workerFetch(
    `/api/dev/invitation-secret?email=${encodeURIComponent(email)}`,
  );
  const secret = z
    .object({ secret: z.string() })
    .parse(await secretResponse.json()).secret;
  expect(
    (await callTrpc("invitations.accept", { secret }, recipientCookie)).status,
  ).toBe(200);
}

async function submitProposal(
  cookie: string,
  slug: string,
  cfpId: string,
  trackId: string,
  title: string,
  abstract: string,
): Promise<{ id: string }> {
  const response = await callTrpc(
    "submissions.submit",
    {
      slug,
      cfpId,
      clientDraftId: crypto.randomUUID(),
      title,
      abstract,
      format: "Talk",
      trackId,
      proposedSpeakers: [
        { name: "Named Speaker", email: `${crypto.randomUUID()}@example.com` },
      ],
      customAnswers: { private_note: "The reviewer must not see this." },
    },
    cookie,
  );
  expect(response.status).toBe(200);
  return getResult(response.body, idSchema);
}
