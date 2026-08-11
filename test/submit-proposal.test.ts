import { describe, expect, test } from "vitest";
import { z } from "zod";

import { cfpSchema } from "../src/shared/cfps";

import { callTrpc, getResult, signIn, testEnvironment } from "./support";

const idSchema = z.object({ id: z.string() });
const submissionSchema = z.object({
  id: z.string(),
  status: z.enum(["active", "withdrawn"]),
  event: z.object({ name: z.string(), slug: z.string() }),
  cfp: z.object({ id: z.string(), name: z.string() }),
  title: z.string(),
  abstract: z.string(),
  format: z.string(),
  track: z.object({ id: z.string(), name: z.string() }),
  form: z.object({
    deadline: z.string(),
    formats: z.array(z.string()),
    tracks: z.array(
      z.object({ id: z.string(), name: z.string(), archived: z.boolean() }),
    ),
    customFields: z.array(z.object({ key: z.string() }).passthrough()),
  }),
  proposedSpeakers: z.array(
    z.object({ id: z.string(), name: z.string(), email: z.string() }),
  ),
  customAnswers: z.record(z.string(), z.string()),
  decision: z.object({
    status: z.enum(["pending", "accepted", "declined"]),
  }),
  confirmation: z.object({ status: z.literal("recorded") }),
  permissions: z.object({ canEdit: z.boolean(), canWithdraw: z.boolean() }),
});

describe("submit a proposal through the local-first flow", () => {
  test("validates and persists a final proposal for its owner", async () => {
    const slug = "proposal-flow-2027";
    const owner = await signIn("proposal-event-owner@example.com");
    const submitter = await signIn("proposal-submit-owner@example.com");
    const unrelated = await signIn("proposal-unrelated@example.com");
    const event = getResult(
      (
        await callTrpc(
          "events.create",
          {
            name: "Proposal Flow Conference",
            slug,
            startsOn: "2027-08-10",
            endsOn: "2027-08-12",
            timezone: "Europe/Berlin",
          },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    const track = getResult(
      (
        await callTrpc(
          "tracks.create",
          { slug, name: "Data systems" },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    const archivedTrack = getResult(
      (
        await callTrpc(
          "tracks.create",
          { slug, name: "Archive before submission" },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    const draft = getResult(
      (
        await callTrpc(
          "cfps.createDraft",
          {
            slug,
            name: "Share your systems story",
            deadline: "2027-04-30T21:59:00Z",
            formats: ["Talk", "Workshop"],
            customFields: [
              {
                key: "audience",
                label: "Audience",
                type: "single_select",
                required: true,
                options: ["Beginner", "Experienced"],
              },
              {
                key: "requirements",
                label: "Workshop requirements",
                type: "long_text",
                required: true,
                condition: { fieldKey: "audience", equals: "Experienced" },
              },
              {
                key: "notes",
                label: "Anything else?",
                type: "short_text",
                required: false,
              },
            ],
          },
          owner.cookie,
        )
      ).body,
      cfpSchema,
    );
    await callTrpc(
      "cfps.open",
      {
        slug,
        cfpId: draft.id,
        name: draft.name,
        deadline: draft.deadline,
        formats: draft.formats,
        customFields: draft.customFields,
      },
      owner.cookie,
    );

    await expect(
      testEnvironment.DB.prepare(
        `INSERT INTO submissions
          (id, event_id, cfp_id, cfp_revision, owner_user_id, client_draft_id,
           track_id, title, abstract, format, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          event.id,
          draft.id,
          0,
          submitter.userId,
          crypto.randomUUID(),
          track.id,
          "Stale form",
          "This insert used a stale CFP revision.",
          "Talk",
          Date.now(),
          Date.now(),
        )
        .run(),
    ).rejects.toThrow(/stale_cfp/);

    const proposal = {
      slug,
      cfpId: draft.id,
      clientDraftId: crypto.randomUUID(),
      title: "Operating a calm data platform",
      abstract: "How a small team keeps a useful platform understandable.",
      format: "Talk",
      trackId: track.id,
      proposedSpeakers: [
        { name: "Sam Submitter", email: "speaker@example.com" },
      ],
      customAnswers: {
        audience: " Beginner ",
        requirements: "This hidden answer must not be persisted.",
        notes: "Bring questions.",
        removed_question: "This stale answer must not be persisted.",
      },
    };
    expect((await callTrpc("submissions.submit", proposal)).status).toBe(401);
    await testEnvironment.DB.prepare(
      "UPDATE user SET email_verified = 0 WHERE id = ?",
    )
      .bind(submitter.userId)
      .run();
    expect(
      (await callTrpc("submissions.submit", proposal, submitter.cookie)).status,
    ).toBe(403);
    await testEnvironment.DB.prepare(
      "UPDATE user SET email_verified = 1 WHERE id = ?",
    )
      .bind(submitter.userId)
      .run();

    const invalidOption = await callTrpc(
      "submissions.submit",
      { ...proposal, customAnswers: { audience: "Everyone" } },
      submitter.cookie,
    );
    expect(invalidOption.status).toBe(400);
    expect(
      (
        await callTrpc(
          "submissions.submit",
          {
            ...proposal,
            customAnswers: {
              audience: "Experienced",
              requirements: "",
            },
          },
          submitter.cookie,
        )
      ).status,
    ).toBe(400);
    await callTrpc(
      "tracks.archive",
      { slug, trackId: archivedTrack.id },
      owner.cookie,
    );
    expect(
      (
        await callTrpc(
          "submissions.submit",
          { ...proposal, trackId: archivedTrack.id },
          submitter.cookie,
        )
      ).status,
    ).toBe(400);

    const submittedResponse = await callTrpc(
      "submissions.submit",
      proposal,
      submitter.cookie,
    );
    expect(submittedResponse.status).toBe(200);
    const submitted = getResult(submittedResponse.body, submissionSchema);
    expect(submitted).toMatchObject({
      status: "active",
      event: { name: "Proposal Flow Conference", slug },
      cfp: { id: draft.id, name: "Share your systems story" },
      title: proposal.title,
      track: { id: track.id, name: "Data systems" },
      proposedSpeakers: proposal.proposedSpeakers,
      customAnswers: { audience: "Beginner", notes: "Bring questions." },
      decision: { status: "pending" },
      confirmation: { status: "recorded" },
      permissions: { canEdit: true, canWithdraw: true },
    });
    expect(submitted.customAnswers).not.toHaveProperty("requirements");
    expect(submitted.customAnswers).not.toHaveProperty("removed_question");
    expect(submitted.form).toMatchObject({
      deadline: draft.deadline,
      formats: draft.formats,
      tracks: [{ id: track.id, archived: false }],
    });

    const retried = getResult(
      (await callTrpc("submissions.submit", proposal, submitter.cookie)).body,
      submissionSchema,
    );
    expect(retried.id).toBe(submitted.id);
    expect(
      (
        await callTrpc(
          "submissions.get",
          { submissionId: submitted.id },
          unrelated.cookie,
          "query",
        )
      ).status,
    ).toBe(404);
    const reloaded = getResult(
      (
        await callTrpc(
          "submissions.get",
          { submissionId: submitted.id },
          submitter.cookie,
          "query",
        )
      ).body,
      submissionSchema,
    );
    expect(reloaded).toEqual(submitted);
    expect(
      getResult(
        (
          await callTrpc(
            "submissions.list",
            undefined,
            submitter.cookie,
            "query",
          )
        ).body,
        z.array(submissionSchema),
      ).map((submission) => submission.id),
    ).toEqual([submitted.id]);
    expect(
      getResult(
        (
          await callTrpc(
            "submissions.list",
            undefined,
            unrelated.cookie,
            "query",
          )
        ).body,
        z.array(submissionSchema),
      ),
    ).toEqual([]);

    expect(
      (
        await callTrpc(
          "cfps.updateDraft",
          {
            slug,
            cfpId: draft.id,
            name: "Extended CFP",
            deadline: "2027-05-15T21:59:00Z",
            formats: draft.formats,
            customFields: draft.customFields,
          },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "cfps.updateDraft",
          {
            slug,
            cfpId: draft.id,
            name: draft.name,
            deadline: draft.deadline,
            formats: ["Panel"],
            customFields: [],
          },
          owner.cookie,
        )
      ).status,
    ).toBe(409);

    const updated = getResult(
      (
        await callTrpc(
          "submissions.updateOwn",
          {
            submissionId: submitted.id,
            title: "Operating a calm platform",
            abstract: proposal.abstract,
            format: proposal.format,
            trackId: proposal.trackId,
            proposedSpeakers: proposal.proposedSpeakers,
            customAnswers: {
              audience: "Experienced",
              requirements: "A projector and a room with tables.",
            },
          },
          submitter.cookie,
        )
      ).body,
      submissionSchema,
    );
    expect(updated).toMatchObject({
      title: "Operating a calm platform",
      customAnswers: {
        audience: "Experienced",
        requirements: "A projector and a room with tables.",
      },
    });

    await testEnvironment.DB.prepare(
      "UPDATE decisions SET status = 'accept_queued' WHERE submission_id = ?",
    )
      .bind(submitted.id)
      .run();
    const queued = getResult(
      (
        await callTrpc(
          "submissions.get",
          { submissionId: submitted.id },
          submitter.cookie,
          "query",
        )
      ).body,
      submissionSchema,
    );
    expect(queued).toMatchObject({
      decision: { status: "pending" },
      permissions: { canEdit: true, canWithdraw: true },
    });

    expect(
      (
        await callTrpc(
          "submissions.withdrawOwn",
          { submissionId: submitted.id },
          unrelated.cookie,
        )
      ).status,
    ).toBe(404);
    const withdrawn = getResult(
      (
        await callTrpc(
          "submissions.withdrawOwn",
          { submissionId: submitted.id },
          submitter.cookie,
        )
      ).body,
      submissionSchema,
    );
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn).toMatchObject({
      decision: { status: "pending" },
      permissions: { canEdit: false, canWithdraw: false },
    });
    await expect(
      testEnvironment.DB.prepare(
        "UPDATE form_responses SET answers_json = ? WHERE submission_id = ?",
      )
        .bind('{"audience":"Experienced"}', submitted.id)
        .run(),
    ).rejects.toThrow(/submission_closed/);
    expect(
      (
        await callTrpc(
          "submissions.updateOwn",
          {
            submissionId: submitted.id,
            title: "Too late",
            abstract: proposal.abstract,
            format: proposal.format,
            trackId: proposal.trackId,
            proposedSpeakers: proposal.proposedSpeakers,
            customAnswers: { audience: "Beginner" },
          },
          submitter.cookie,
        )
      ).status,
    ).toBe(409);
    await callTrpc(
      "cfps.updateDraft",
      {
        slug,
        cfpId: draft.id,
        name: "Closed CFP",
        deadline: "2020-01-01T00:00:00Z",
        formats: draft.formats,
        customFields: draft.customFields,
      },
      owner.cookie,
    );
    expect(
      (await callTrpc("cfps.publicByEventSlug", { slug }, undefined, "query"))
        .status,
    ).toBe(404);
  });
});
