import { describe, expect, test } from "vitest";
import { z } from "zod";

import { cfpSchema } from "../src/shared/cfps";

import {
  callTrpc,
  getResult,
  signIn,
  testEnvironment,
  workerFetch,
} from "./support";

const idSchema = z.object({ id: z.string() });
const evidenceSchema = z.object({ evidenceId: z.string() });
const mineSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    completionRevision: z.number(),
    completed: z.boolean(),
    evidence: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        createdAt: z.string(),
        rejectedReason: z.string().nullable(),
        supersededBy: z.string().nullable(),
        fileId: z.string().nullable(),
        fileName: z.string().nullable(),
      }),
    ),
  }),
);
const boardSchema = z.object({
  assignments: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      completed: z.boolean(),
      completionRevision: z.number(),
      lastReminderAt: z.string().nullable(),
      evidence: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          createdAt: z.string(),
        }),
      ),
    }),
  ),
  targets: z.object({
    speakers: z.array(
      z.object({
        key: z.string(),
        userId: z.string().nullable(),
        relationshipIds: z.array(z.string()),
      }),
    ),
    programItems: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        speakers: z.array(
          z.object({ id: z.string(), userId: z.string().nullable() }),
        ),
      }),
    ),
  }),
  readiness: z.object({
    speakers: z.array(
      z.object({
        key: z.string(),
        userId: z.string().nullable(),
        ready: z.boolean(),
        blockers: z.array(z.object({ requirement: z.string() })),
      }),
    ),
    programItems: z.array(
      z.object({
        id: z.string(),
        ready: z.boolean(),
        nextDueAt: z.string().nullable(),
        blockers: z.array(z.object({ requirement: z.string() })),
      }),
    ),
  }),
});

describe("complete speaker onboarding tasks", () => {
  test("derives readiness from current evidence while preserving every prior answer and file", async () => {
    const owner = await signIn("onboarding-owner@example.com");
    const maya = await signIn("onboarding-maya@example.com");
    const leo = await signIn("onboarding-leo@example.com");
    const unrelated = await signIn("onboarding-unrelated@example.com");
    const slug = "onboarding-flow-2027";
    await createAcceptedProgram({
      ownerCookie: owner.cookie,
      mayaCookie: maya.cookie,
      slug,
    });
    const initialBoard = await getBoard(owner.cookie, slug);
    const practical = initialBoard.targets.programItems.find(
      (item) => item.title === "Practical Agents",
    );
    const evaluating = initialBoard.targets.programItems.find(
      (item) => item.title === "Evaluating Agents",
    );
    const leoRelationship = practical?.speakers.find(
      (speaker) => speaker.userId === null,
    );
    if (!practical || !evaluating || !leoRelationship) {
      throw new Error("Expected accepted program targets");
    }

    const specificDefinition = await createDefinition(owner.cookie, {
      slug,
      name: "Speaker agreement",
      scope: "program_item_speaker",
      completionMechanism: "manual",
    });
    const preClaimAssignment = await createAssignment(owner.cookie, {
      slug,
      taskDefinitionId: specificDefinition.id,
      target: {
        scope: "program_item_speaker",
        submissionSpeakerId: leoRelationship.id,
      },
      required: true,
      dueAt: null,
    });
    const canceledAssignment = await createAssignment(owner.cookie, {
      slug,
      taskDefinitionId: specificDefinition.id,
      target: {
        scope: "program_item_speaker",
        submissionSpeakerId: leoRelationship.id,
      },
      required: false,
      dueAt: null,
    });
    await callTrpc(
      "onboarding.cancelAssignment",
      { assignmentId: canceledAssignment.id },
      owner.cookie,
    );
    expect(
      getResult(
        (await callTrpc("onboarding.mine", undefined, leo.cookie, "query"))
          .body,
        mineSchema,
      ),
    ).toEqual([]);
    const preClaimBoard = await getBoard(owner.cookie, slug);
    expect(
      preClaimBoard.readiness.speakers.find(
        (speaker) => speaker.key === leoRelationship.id,
      ),
    ).toMatchObject({
      userId: null,
      ready: false,
      blockers: [{ requirement: "Speaker agreement" }],
    });
    const assignmentsBeforeClaim = await assignmentCount();
    const invitationSecret = await getInvitationSecret(
      "onboarding-leo@example.com",
    );
    expect(
      (
        await callTrpc(
          "submissionSpeakerInvitations.accept",
          { secret: invitationSecret },
          leo.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      getResult(
        (await callTrpc("onboarding.mine", undefined, leo.cookie, "query"))
          .body,
        mineSchema,
      ).map((assignment) => assignment.id),
    ).toContain(preClaimAssignment.id);
    expect(
      getResult(
        (await callTrpc("onboarding.mine", undefined, leo.cookie, "query"))
          .body,
        mineSchema,
      ).map((assignment) => assignment.id),
    ).not.toContain(canceledAssignment.id);
    expect(await assignmentCount()).toBe(assignmentsBeforeClaim);
    await callTrpc(
      "onboarding.confirmManual",
      { assignmentId: preClaimAssignment.id },
      leo.cookie,
    );
    expect(
      (
        await callTrpc(
          "onboarding.confirmManual",
          { assignmentId: preClaimAssignment.id },
          leo.cookie,
        )
      ).status,
    ).toBe(409);

    const profileDefinition = await createDefinition(owner.cookie, {
      slug,
      name: "Complete speaker profile",
      scope: "event_speaker",
      completionMechanism: "profile",
      profileRequirement: "headshot",
    });
    expect(
      (
        await callTrpc(
          "onboarding.createDefinition",
          {
            slug,
            name: "Invalid shared profile",
            scope: "program_item",
            completionMechanism: "profile",
            profileRequirement: "complete",
            formFields: null,
          },
          owner.cookie,
        )
      ).status,
    ).toBe(400);
    const slidesDefinition = await createDefinition(owner.cookie, {
      slug,
      name: "Upload shared slides",
      scope: "program_item",
      completionMechanism: "file",
    });
    const formDefinition = await createDefinition(owner.cookie, {
      slug,
      name: "Travel details",
      scope: "event_speaker",
      completionMechanism: "form",
      formFields: [
        {
          key: "arrival",
          label: "Arrival details",
          type: "short_text",
          required: true,
        },
      ],
    });
    const waiverDefinition = await createDefinition(owner.cookie, {
      slug,
      name: "Optional rehearsal",
      scope: "program_item_speaker",
      completionMechanism: "manual",
    });
    const overrideDefinition = await createDefinition(owner.cookie, {
      slug,
      name: "External consent",
      scope: "program_item",
      completionMechanism: "manual",
    });
    const boardAfterClaim = await getBoard(owner.cookie, slug);
    const mayaTarget = boardAfterClaim.targets.speakers.find(
      (speaker) => speaker.userId === maya.userId,
    );
    const leoTarget = boardAfterClaim.targets.speakers.find(
      (speaker) => speaker.userId === leo.userId,
    );
    if (!mayaTarget || !leoTarget) throw new Error("Expected claimed speakers");

    const profileAssignment = await createAssignment(owner.cookie, {
      slug,
      taskDefinitionId: profileDefinition.id,
      target: { scope: "event_speaker", userId: maya.userId },
      required: true,
      dueAt: "2027-07-01T10:00:00Z",
    });
    const slidesAssignment = await createAssignment(owner.cookie, {
      slug,
      taskDefinitionId: slidesDefinition.id,
      target: { scope: "program_item", programItemId: practical.id },
      required: true,
      dueAt: "2027-06-20T10:00:00Z",
    });
    const formAssignment = await createAssignment(owner.cookie, {
      slug,
      taskDefinitionId: formDefinition.id,
      target: { scope: "event_speaker", userId: leo.userId },
      required: true,
      dueAt: "2027-06-25T10:00:00Z",
    });
    const waiverAssignment = await createAssignment(owner.cookie, {
      slug,
      taskDefinitionId: waiverDefinition.id,
      target: {
        scope: "program_item_speaker",
        submissionSpeakerId:
          mayaTarget.relationshipIds.find((id) =>
            evaluating.speakers.some((speaker) => speaker.id === id),
          ) ?? "",
      },
      required: true,
      dueAt: "2027-06-20T10:00:00+02:00",
    });
    const overrideAssignment = await createAssignment(owner.cookie, {
      slug,
      taskDefinitionId: overrideDefinition.id,
      target: { scope: "program_item", programItemId: evaluating.id },
      required: true,
      dueAt: "2027-06-20T08:30:00Z",
    });
    expect(
      (
        await callTrpc(
          "onboarding.createAssignment",
          {
            slug,
            taskDefinitionId: slidesDefinition.id,
            target: { scope: "program_item", programItemId: practical.id },
            required: true,
            dueAt: null,
          },
          unrelated.cookie,
        )
      ).status,
    ).toBe(404);

    const beforeExceptions = await getBoard(owner.cookie, slug);
    expect(readiness(beforeExceptions, evaluating.id).nextDueAt).toBe(
      "2027-06-20T08:00:00.000Z",
    );
    await callTrpc(
      "onboarding.waive",
      { assignmentId: waiverAssignment.id, reason: "No rehearsal is needed." },
      owner.cookie,
    );
    await callTrpc(
      "onboarding.override",
      {
        assignmentId: overrideAssignment.id,
        reason: "Consent was recorded by the venue.",
      },
      owner.cookie,
    );
    await callTrpc(
      "speakerProfile.saveOwn",
      {
        displayName: "Maya Speaker",
        bio: "A reusable profile shared across accepted program work.",
        expectedRevision: null,
        headshot: {
          fileName: "maya.png",
          contentType: "image/png",
          contentBase64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
      },
      maya.cookie,
    );
    let board = await getBoard(owner.cookie, slug);
    expect(findAssignment(board, profileAssignment.id).completed).toBe(true);
    const profileEvidence = findAssignment(
      board,
      profileAssignment.id,
    ).evidence.find((evidence) => evidence.kind === "profile");
    if (!profileEvidence) throw new Error("Expected profile evidence");
    expect(
      (
        await callTrpc(
          "onboarding.rejectEvidence",
          {
            evidenceId: profileEvidence.id,
            reason: "The biography needs a correction.",
          },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    board = await getBoard(owner.cookie, slug);
    expect(findAssignment(board, profileAssignment.id).completed).toBe(false);
    await callTrpc(
      "speakerProfile.saveOwn",
      {
        displayName: "Maya Speaker",
        bio: "A corrected reusable profile shared across accepted program work.",
        expectedRevision: 1,
      },
      maya.cookie,
    );
    board = await getBoard(owner.cookie, slug);
    expect(findAssignment(board, profileAssignment.id).completed).toBe(true);
    expect(readiness(board, evaluating.id)).toMatchObject({ ready: true });
    expect(readiness(board, practical.id)).toMatchObject({
      ready: false,
      nextDueAt: "2027-06-20T10:00:00.000Z",
    });
    expect(
      readiness(board, practical.id).blockers.map(
        (blocker) => blocker.requirement,
      ),
    ).toEqual(["Upload shared slides", "Travel details"]);

    const firstFile = getResult(
      (
        await callTrpc(
          "onboarding.uploadFile",
          {
            assignmentId: slidesAssignment.id,
            fileName: "slides-v1.pdf",
            contentType: "application/pdf",
            contentBase64: btoa("first slides"),
          },
          maya.cookie,
        )
      ).body,
      evidenceSchema,
    );
    board = await getBoard(owner.cookie, slug);
    expect(
      readiness(board, practical.id).blockers.map(
        (blocker) => blocker.requirement,
      ),
    ).toEqual(["Travel details"]);

    await callTrpc(
      "onboarding.saveFormDraft",
      {
        assignmentId: formAssignment.id,
        answers: { arrival: "Train at 14:00" },
      },
      leo.cookie,
    );
    const submittedForm = getResult(
      (
        await callTrpc(
          "onboarding.submitForm",
          { assignmentId: formAssignment.id },
          leo.cookie,
        )
      ).body,
      evidenceSchema,
    );
    board = await getBoard(owner.cookie, slug);
    expect(readiness(board, practical.id).ready).toBe(true);

    await callTrpc(
      "onboarding.saveFormDraft",
      {
        assignmentId: formAssignment.id,
        answers: { arrival: "Duplicate accepted answer" },
      },
      leo.cookie,
    );
    expect(
      (
        await callTrpc(
          "onboarding.submitForm",
          { assignmentId: formAssignment.id },
          leo.cookie,
        )
      ).status,
    ).toBe(409);

    await callTrpc(
      "onboarding.rejectEvidence",
      {
        evidenceId: submittedForm.evidenceId,
        reason: "Arrival time needs a timezone.",
      },
      owner.cookie,
    );
    board = await getBoard(owner.cookie, slug);
    expect(readiness(board, practical.id).ready).toBe(false);
    await callTrpc(
      "onboarding.saveFormDraft",
      {
        assignmentId: formAssignment.id,
        answers: { arrival: "Train at 14:00 Europe/Berlin" },
      },
      leo.cookie,
    );
    await callTrpc(
      "onboarding.submitForm",
      { assignmentId: formAssignment.id },
      leo.cookie,
    );
    board = await getBoard(owner.cookie, slug);
    expect(readiness(board, practical.id).ready).toBe(true);
    expect(
      await testEnvironment.DB.prepare(
        "SELECT COUNT(*) AS count FROM onboarding_form_responses WHERE assignment_id = ? AND submitted_at IS NOT NULL",
      )
        .bind(formAssignment.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 2 });

    await callTrpc(
      "onboarding.reopen",
      {
        assignmentId: slidesAssignment.id,
        reason: "The agenda changed and needs updated slides.",
      },
      owner.cookie,
    );
    await callTrpc(
      "onboarding.recordReminder",
      { assignmentId: slidesAssignment.id },
      owner.cookie,
    );
    board = await getBoard(owner.cookie, slug);
    const reopenedSlides = findAssignment(board, slidesAssignment.id);
    expect(reopenedSlides).toMatchObject({
      completed: false,
      completionRevision: 2,
    });
    expect(reopenedSlides.lastReminderAt).toBeTypeOf("string");
    expect(
      await testEnvironment.DB.prepare(
        "SELECT COUNT(*) AS count FROM communications WHERE purpose = 'task_reminder' AND context_json LIKE ?",
      )
        .bind(`%${slidesAssignment.id}%`)
        .first(),
    ).toEqual({ count: 2 });
    expect(readiness(board, practical.id).ready).toBe(false);

    await uploadFile(
      maya.cookie,
      slidesAssignment.id,
      "slides-v2.pdf",
      "second slides",
    );
    const concurrentReplacements = await Promise.all([
      callTrpc(
        "onboarding.uploadFile",
        {
          assignmentId: slidesAssignment.id,
          fileName: "slides-v3.pdf",
          contentType: "application/pdf",
          contentBase64: btoa("final slides three"),
        },
        leo.cookie,
      ),
      callTrpc(
        "onboarding.uploadFile",
        {
          assignmentId: slidesAssignment.id,
          fileName: "slides-v4.pdf",
          contentType: "application/pdf",
          contentBase64: btoa("final slides four"),
        },
        maya.cookie,
      ),
    ]);
    const successfulReplacements = concurrentReplacements.filter(
      ({ status }) => status === 200,
    ).length;
    expect(successfulReplacements).toBeGreaterThanOrEqual(1);
    expect(
      concurrentReplacements.every(({ status }) => [200, 409].includes(status)),
    ).toBe(true);
    board = await getBoard(owner.cookie, slug);
    expect(readiness(board, practical.id).ready).toBe(true);
    const mayaTasks = getResult(
      (await callTrpc("onboarding.mine", undefined, maya.cookie, "query")).body,
      mineSchema,
    );
    const slides = mayaTasks.find(
      (assignment) => assignment.id === slidesAssignment.id,
    );
    expect(slides).toMatchObject({ completed: true, completionRevision: 2 });
    const fileNames =
      slides?.evidence.map((evidence) => evidence.fileName) ?? [];
    expect(fileNames).toContain("slides-v1.pdf");
    expect(fileNames).toContain("slides-v2.pdf");
    expect(
      fileNames.filter(
        (name) => name === "slides-v3.pdf" || name === "slides-v4.pdf",
      ).length,
    ).toBe(successfulReplacements);
    expect(
      slides?.evidence.find((evidence) => evidence.fileName === "slides-v2.pdf")
        ?.supersededBy,
    ).toEqual(expect.any(String));
    expect(
      slides?.evidence
        .filter((evidence) => evidence.fileId)
        .every((evidence) => !Number.isNaN(Date.parse(evidence.createdAt))),
    ).toBe(true);
    expect(
      await testEnvironment.DB.prepare(
        "SELECT COUNT(*) AS count FROM stored_files WHERE id IN (SELECT stored_file_id FROM task_assignment_attachments WHERE assignment_id = ?)",
      )
        .bind(slidesAssignment.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 2 + successfulReplacements });
    expect(
      await testEnvironment.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM task_evidence
         LEFT JOIN task_evidence_supersessions
           ON task_evidence_supersessions.previous_evidence_id = task_evidence.id
         WHERE task_evidence.assignment_id = ?
           AND task_evidence.completion_revision = 2
           AND task_evidence.kind = 'file'
           AND task_evidence_supersessions.previous_evidence_id IS NULL`,
      )
        .bind(slidesAssignment.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    const currentFile = slides?.evidence.find(
      (evidence) =>
        evidence.fileId && !evidence.supersededBy && !evidence.rejectedReason,
    );
    if (!currentFile?.fileId || !currentFile.fileName) {
      throw new Error("Expected current task file");
    }
    const expectedContent =
      currentFile.fileName === "slides-v3.pdf"
        ? "final slides three"
        : "final slides four";
    const speakerDownload = await workerFetch(
      `/api/task-files/${currentFile.fileId}`,
      { headers: { Cookie: maya.cookie } },
    );
    expect(speakerDownload.status).toBe(200);
    expect(new TextDecoder().decode(await speakerDownload.arrayBuffer())).toBe(
      expectedContent,
    );
    expect(
      (
        await workerFetch(`/api/task-files/${currentFile.fileId}`, {
          headers: { Cookie: unrelated.cookie },
        })
      ).status,
    ).toBe(404);
    const fileRows = await testEnvironment.DB.prepare(
      "SELECT object_key AS objectKey FROM stored_files WHERE id IN (SELECT stored_file_id FROM task_assignment_attachments WHERE assignment_id = ?)",
    )
      .bind(slidesAssignment.id)
      .all<{ objectKey: string }>();
    for (const file of fileRows.results) {
      expect(await testEnvironment.FILES.get(file.objectKey)).not.toBeNull();
    }
    expect(
      (await testEnvironment.FILES.list({ prefix: `task-files/` })).objects,
    ).toHaveLength(2 + successfulReplacements);
    expect(firstFile.evidenceId).toEqual(expect.any(String));
  });
});

async function createAcceptedProgram(input: {
  ownerCookie: string;
  mayaCookie: string;
  slug: string;
}) {
  await callTrpc(
    "events.create",
    {
      name: "Onboarding Conference",
      slug: input.slug,
      startsOn: "2027-08-10",
      endsOn: "2027-08-12",
      timezone: "Europe/Berlin",
    },
    input.ownerCookie,
  );
  const track = getResult(
    (
      await callTrpc(
        "tracks.create",
        { slug: input.slug, name: "Engineering" },
        input.ownerCookie,
      )
    ).body,
    idSchema,
  );
  const cfp = getResult(
    (
      await callTrpc(
        "cfps.createDraft",
        {
          slug: input.slug,
          name: "Onboarding CFP",
          deadline: "2027-06-01T00:00:00Z",
          formats: ["Talk"],
          customFields: [],
        },
        input.ownerCookie,
      )
    ).body,
    cfpSchema,
  );
  await callTrpc(
    "cfps.open",
    {
      slug: input.slug,
      cfpId: cfp.id,
      expectedDeadline: cfp.deadline,
      name: cfp.name,
      deadline: cfp.deadline,
      formats: cfp.formats,
      customFields: cfp.customFields,
    },
    input.ownerCookie,
  );
  const practical = await submitProgramProposal({
    cookie: input.mayaCookie,
    slug: input.slug,
    cfpId: cfp.id,
    trackId: track.id,
    title: "Practical Agents",
    speakers: [
      { name: "Maya Speaker", email: "onboarding-maya@example.com" },
      { name: "Leo Speaker", email: "onboarding-leo@example.com" },
    ],
  });
  const evaluating = await submitProgramProposal({
    cookie: input.mayaCookie,
    slug: input.slug,
    cfpId: cfp.id,
    trackId: track.id,
    title: "Evaluating Agents",
    speakers: [{ name: "Maya Speaker", email: "onboarding-maya@example.com" }],
  });
  const event = await testEnvironment.DB.prepare(
    "SELECT id FROM events WHERE slug = ?",
  )
    .bind(input.slug)
    .first<{ id: string }>();
  const practicalItemId = crypto.randomUUID();
  const evaluatingItemId = crypto.randomUUID();
  await testEnvironment.DB.batch([
    testEnvironment.DB.prepare(
      "UPDATE decisions SET status = 'accepted' WHERE submission_id IN (?, ?)",
    ).bind(practical.id, evaluating.id),
    testEnvironment.DB.prepare(
      "INSERT INTO program_items (id, event_id, submission_id, created_at) VALUES (?, ?, ?, ?)",
    ).bind(practicalItemId, event?.id, practical.id, Date.now()),
    testEnvironment.DB.prepare(
      "INSERT INTO program_items (id, event_id, submission_id, created_at) VALUES (?, ?, ?, ?)",
    ).bind(evaluatingItemId, event?.id, evaluating.id, Date.now()),
  ]);
  return { practicalItemId, evaluatingItemId };
}

async function submitProgramProposal(input: {
  cookie: string;
  slug: string;
  cfpId: string;
  trackId: string;
  title: string;
  speakers: Array<{ name: string; email: string }>;
}) {
  return getResult(
    (
      await callTrpc(
        "submissions.submit",
        {
          slug: input.slug,
          cfpId: input.cfpId,
          clientDraftId: crypto.randomUUID(),
          title: input.title,
          abstract: `${input.title} abstract.`,
          format: "Talk",
          trackId: input.trackId,
          proposedSpeakers: input.speakers,
          customAnswers: {},
        },
        input.cookie,
      )
    ).body,
    idSchema,
  );
}

async function createDefinition(
  cookie: string,
  input: Record<string, unknown>,
) {
  return getResult(
    (await callTrpc("onboarding.createDefinition", input, cookie)).body,
    idSchema,
  );
}

async function createAssignment(
  cookie: string,
  input: Record<string, unknown>,
) {
  return getResult(
    (await callTrpc("onboarding.createAssignment", input, cookie)).body,
    idSchema,
  );
}

async function getBoard(cookie: string, slug: string) {
  return getResult(
    (await callTrpc("onboarding.organizerBoard", { slug }, cookie, "query"))
      .body,
    boardSchema,
  );
}

function findAssignment(
  board: z.infer<typeof boardSchema>,
  assignmentId: string,
) {
  const assignment = board.assignments.find((item) => item.id === assignmentId);
  if (!assignment) throw new Error("Expected assignment");
  return assignment;
}

function readiness(board: z.infer<typeof boardSchema>, programItemId: string) {
  const item = board.readiness.programItems.find(
    (programItem) => programItem.id === programItemId,
  );
  if (!item) throw new Error("Expected program readiness");
  return item;
}

async function uploadFile(
  cookie: string,
  assignmentId: string,
  fileName: string,
  content: string,
) {
  expect(
    (
      await callTrpc(
        "onboarding.uploadFile",
        {
          assignmentId,
          fileName,
          contentType: "application/pdf",
          contentBase64: btoa(content),
        },
        cookie,
      )
    ).status,
  ).toBe(200);
}

async function assignmentCount() {
  return (
    await testEnvironment.DB.prepare(
      "SELECT COUNT(*) AS count FROM task_assignments",
    ).first<{ count: number }>()
  )?.count;
}

async function getInvitationSecret(email: string) {
  const response = await workerFetch(
    `/api/dev/invitation-secret?email=${encodeURIComponent(email)}`,
  );
  return z.object({ secret: z.string() }).parse(await response.json()).secret;
}
