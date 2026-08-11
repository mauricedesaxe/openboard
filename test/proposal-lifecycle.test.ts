import { describe, expect, test } from "vitest";
import { z } from "zod";

import { cfpSchema } from "../src/shared/cfps";
import { submissionSchema } from "../src/shared/submissions";

import { callTrpc, getResult, signIn } from "./support";

const idSchema = z.object({ id: z.string() });

describe("proposal lifecycle boundaries", () => {
  test.each(["accepted", "declined"] as const)(
    "closes proposals after organizers publish %s decisions",
    async (decisionStatus) => {
      const setup = await createSubmittedProposal(decisionStatus);
      await publishDecision(setup, decisionStatus);

      const published = await getOwnSubmission(setup);
      expect(published).toMatchObject({
        status: "active",
        decision: { status: decisionStatus },
        permissions: { canEdit: false, canWithdraw: false },
      });

      expect((await updateOwnSubmission(setup)).status).toBe(409);
      expect(
        (
          await callTrpc(
            "submissions.withdrawOwn",
            { submissionId: setup.submission.id },
            setup.submissionOwnerCookie,
          )
        ).status,
      ).toBe(409);

      expect(await getOwnSubmission(setup)).toEqual(published);
    },
  );

  test("keeps withdrawal available after the deadline closes editing", async () => {
    const setup = await createSubmittedProposal("expired");
    const closeResponse = await callTrpc(
      "cfps.updateDraft",
      {
        slug: setup.slug,
        cfpId: setup.cfp.id,
        name: setup.cfp.name,
        deadline: "2020-01-01T00:00:00Z",
        formats: setup.cfp.formats,
        customFields: setup.cfp.customFields,
      },
      setup.ownerCookie,
    );
    expect(closeResponse.status).toBe(200);

    const expired = await getOwnSubmission(setup);
    expect(expired).toMatchObject({
      status: "active",
      permissions: { canEdit: false, canWithdraw: true },
    });
    expect((await updateOwnSubmission(setup)).status).toBe(409);
    expect(await getOwnSubmission(setup)).toEqual(expired);

    const withdrawn = getResult(
      (
        await callTrpc(
          "submissions.withdrawOwn",
          { submissionId: setup.submission.id },
          setup.submissionOwnerCookie,
        )
      ).body,
      submissionSchema,
    );
    expect(withdrawn).toMatchObject({
      status: "withdrawn",
      decision: { status: "pending" },
      permissions: { canEdit: false, canWithdraw: false },
    });
  });
});

async function createSubmittedProposal(
  scenario: "accepted" | "declined" | "expired",
) {
  const futureYear = new Date().getUTCFullYear() + 1;
  const slug = `proposal-lifecycle-${scenario}-${futureYear}`;
  const owner = await signIn(`lifecycle-owner-${scenario}@example.com`);
  const submissionOwner = await signIn(
    `lifecycle-submission-owner-${scenario}@example.com`,
  );
  await callTrpc(
    "events.create",
    {
      name: `Lifecycle Conference ${scenario}`,
      slug,
      startsOn: `${futureYear}-08-10`,
      endsOn: `${futureYear}-08-12`,
      timezone: "Europe/Berlin",
    },
    owner.cookie,
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
          name: "Share your design lessons",
          deadline: `${futureYear}-04-30T21:59:00Z`,
          formats: ["Talk"],
          customFields: [],
        },
        owner.cookie,
      )
    ).body,
    cfpSchema,
  );
  expect(
    (
      await callTrpc(
        "cfps.open",
        {
          slug,
          cfpId: cfp.id,
          name: cfp.name,
          deadline: cfp.deadline,
          formats: cfp.formats,
          customFields: cfp.customFields,
        },
        owner.cookie,
      )
    ).status,
  ).toBe(200);

  const proposal = {
    slug,
    cfpId: cfp.id,
    clientDraftId: crypto.randomUUID(),
    title: "Designing modules that hide complexity",
    abstract: "How small interfaces keep policy and sequencing out of callers.",
    format: "Talk",
    trackId: track.id,
    proposedSpeakers: [
      { name: "Lifecycle Speaker", email: `speaker-${scenario}@example.com` },
    ],
    customAnswers: {},
  };
  const submission = getResult(
    (await callTrpc("submissions.submit", proposal, submissionOwner.cookie))
      .body,
    submissionSchema,
  );

  return {
    cfp,
    ownerCookie: owner.cookie,
    proposal,
    slug,
    submission,
    submissionOwnerCookie: submissionOwner.cookie,
  };
}

type ProposalSetup = Awaited<ReturnType<typeof createSubmittedProposal>>;

async function publishDecision(
  setup: ProposalSetup,
  status: "accepted" | "declined",
) {
  expect(
    (
      await callTrpc(
        "reviews.openRound",
        { slug: setup.slug },
        setup.ownerCookie,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await callTrpc(
        "reviews.closeRound",
        { slug: setup.slug, allowMissingReviews: true },
        setup.ownerCookie,
      )
    ).status,
  ).toBe(200);

  const expectedStatus =
    status === "accepted" ? "accept_queued" : "decline_queued";
  expect(
    (
      await callTrpc(
        "decisions.queue",
        {
          slug: setup.slug,
          submissionId: setup.submission.id,
          status: expectedStatus,
        },
        setup.ownerCookie,
      )
    ).status,
  ).toBe(200);
  const board = getResult(
    (
      await callTrpc(
        "reviews.organizerBoard",
        { slug: setup.slug },
        setup.ownerCookie,
        "query",
      )
    ).body,
    z.object({
      submissions: z.array(
        z.object({
          id: z.string(),
          decision: z.object({ revision: z.number() }),
        }),
      ),
    }),
  );
  const decision = board.submissions.find(
    (submission) => submission.id === setup.submission.id,
  )?.decision;
  if (!decision) throw new Error("Expected queued decision");
  expect(
    (
      await callTrpc(
        "decisions.publish",
        {
          slug: setup.slug,
          selections: [
            {
              submissionId: setup.submission.id,
              expectedStatus,
              expectedRevision: decision.revision,
            },
          ],
        },
        setup.ownerCookie,
      )
    ).status,
  ).toBe(200);
}

async function getOwnSubmission(setup: ProposalSetup) {
  return getResult(
    (
      await callTrpc(
        "submissions.get",
        { submissionId: setup.submission.id },
        setup.submissionOwnerCookie,
        "query",
      )
    ).body,
    submissionSchema,
  );
}

function updateOwnSubmission(setup: ProposalSetup) {
  return callTrpc(
    "submissions.updateOwn",
    {
      submissionId: setup.submission.id,
      expectedRevision: setup.submission.revision,
      title: "A changed title that must not persist",
      abstract: setup.proposal.abstract,
      format: setup.proposal.format,
      trackId: setup.proposal.trackId,
      customAnswers: setup.proposal.customAnswers,
    },
    setup.submissionOwnerCookie,
  );
}
