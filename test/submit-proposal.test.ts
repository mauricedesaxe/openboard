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
  proposedSpeakers: z.array(
    z.object({ id: z.string(), name: z.string(), email: z.string() }),
  ),
  customAnswers: z.record(z.string(), z.string()),
  decision: z.object({ status: z.literal("pending") }),
  confirmation: z.object({ status: z.literal("recorded") }),
});

describe("submit a proposal through the local-first flow", () => {
  test("validates and persists a final proposal for its owner", async () => {
    const slug = "proposal-flow-2027";
    const owner = await signIn("proposal-event-owner@example.com");
    const submitter = await signIn("proposal-submit-owner@example.com");
    const unrelated = await signIn("proposal-unrelated@example.com");
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
        audience: "Beginner",
        requirements: "This hidden answer must not be persisted.",
        notes: "Bring questions.",
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
    expect(
      (
        await callTrpc(
          "submissions.submit",
          {
            ...proposal,
            customAnswers: { audience: "Beginner", unknown: "answer" },
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
    });
    expect(submitted.customAnswers).not.toHaveProperty("requirements");

    const retried = getResult(
      (await callTrpc("submissions.submit", proposal, submitter.cookie)).body,
      submissionSchema,
    );
    expect(retried.id).toBe(submitted.id);
    expect(
      (
        await callTrpc(
          "submissions.getOwn",
          { submissionId: submitted.id },
          unrelated.cookie,
          "query",
        )
      ).status,
    ).toBe(404);
    const reloaded = getResult(
      (
        await callTrpc(
          "submissions.getOwn",
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
            "submissions.listOwn",
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
            "submissions.listOwn",
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
  });
});
