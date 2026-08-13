import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { signIn } from "./support";

test("refreshes the organizer average after saving a review", async ({
  page,
}) => {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const slug = `browser-review-feedback-${suffix}`;
  const ownerEmail = `browser-review-owner-${suffix}@example.com`;
  const submitterEmail = `browser-review-submitter-${suffix}@example.com`;
  await page.goto("/");
  await signIn(page, ownerEmail, "Open my board");
  await mutate(page.request, "events.create", {
    name: "Browser Review Conference",
    slug,
    startsOn: "2028-08-10",
    endsOn: "2028-08-12",
    timezone: "Europe/Berlin",
  });
  const track = await mutate<{ id: string }>(page.request, "tracks.create", {
    slug,
    name: "Web systems",
  });
  const cfp = await mutate<{
    id: string;
    name: string;
    deadline: string;
    formats: string[];
    customFields: unknown[];
  }>(page.request, "cfps.createDraft", {
    slug,
    name: "Browser review CFP",
    deadline: "2028-05-01T00:00:00Z",
    formats: ["Talk"],
    customFields: [],
  });
  await mutate(page.request, "cfps.open", {
    slug,
    cfpId: cfp.id,
    expectedDeadline: cfp.deadline,
    name: cfp.name,
    deadline: cfp.deadline,
    formats: cfp.formats,
    customFields: cfp.customFields,
  });
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/sign-in");
  await signIn(page, submitterEmail, "Open my board");
  const submission = await mutate<{ id: string }>(
    page.request,
    "submissions.submit",
    {
      slug,
      cfpId: cfp.id,
      clientDraftId: crypto.randomUUID(),
      title: "A proposal to review",
      abstract: "This proposal proves that review averages refresh in place.",
      format: "Talk",
      trackId: track.id,
      proposedSpeakers: [{ name: "Browser Submitter", email: submitterEmail }],
      customAnswers: {},
    },
  );
  const lowerScoredSubmission = await mutate<{ id: string }>(
    page.request,
    "submissions.submit",
    {
      slug,
      cfpId: cfp.id,
      clientDraftId: crypto.randomUUID(),
      title: "A lower scored proposal",
      abstract: "This proposal gives the organizer a second average to sort.",
      format: "Talk",
      trackId: track.id,
      proposedSpeakers: [{ name: "Second Submitter", email: submitterEmail }],
      customAnswers: {},
    },
  );
  const unscoredSubmission = await mutate<{ id: string }>(
    page.request,
    "submissions.submit",
    {
      slug,
      cfpId: cfp.id,
      clientDraftId: crypto.randomUUID(),
      title: "An unscored proposal",
      abstract: "This proposal stays last whichever score direction is used.",
      format: "Talk",
      trackId: track.id,
      proposedSpeakers: [{ name: "Third Submitter", email: submitterEmail }],
      customAnswers: {},
    },
  );

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/sign-in");
  await signIn(page, ownerEmail, "Open my board");
  const board = await query<{
    reviewers: Array<{ id: string; email: string }>;
  }>(page.request, "reviews.organizerBoard", { slug });
  const reviewer = board.reviewers.find(
    (candidate) => candidate.email === ownerEmail,
  );
  expect(reviewer?.id).toBeTruthy();
  await mutate(page.request, "reviews.assign", {
    slug,
    submissionId: submission.id,
    reviewerUserId: reviewer?.id,
  });
  await mutate(page.request, "reviews.assign", {
    slug,
    submissionId: lowerScoredSubmission.id,
    reviewerUserId: reviewer?.id,
  });
  await mutate(page.request, "reviews.assign", {
    slug,
    submissionId: unscoredSubmission.id,
    reviewerUserId: reviewer?.id,
  });

  await page.goto(`/events/${slug}/review`);
  const reviewNavigation = page.getByRole("navigation", {
    name: "Review navigation",
  });
  await expect(
    reviewNavigation.getByRole("link", { name: "Overview" }),
  ).toBeVisible();
  await expect(
    reviewNavigation.getByRole("link", { name: "Assignments" }),
  ).toBeVisible();
  await expect(
    reviewNavigation.getByRole("link", { name: "Decisions" }),
  ).toBeVisible();
  await expect(
    reviewNavigation.getByRole("link", { name: "My reviews" }),
  ).toBeVisible();
  await expect(page.getByText("Reviewing has not opened.")).toBeVisible();
  await reviewNavigation.getByRole("link", { name: "My reviews" }).click();
  const draftReviewCard = page
    .locator(".reviewer-card")
    .filter({ hasText: "A proposal to review" });
  await expect(
    draftReviewCard.getByText(
      "Score and comment controls are unavailable until an organizer opens this review round.",
    ),
  ).toBeVisible();
  await expect(draftReviewCard.getByLabel("Score")).toBeDisabled();
  await expect(
    draftReviewCard.getByLabel("Private reviewer comment"),
  ).toBeDisabled();
  await reviewNavigation.getByRole("link", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Open reviewing" }).click();
  await expect(page.getByRole("status")).toHaveText("Reviewing opened");
  const overviewProposal = page
    .locator(".review-proposal")
    .filter({ hasText: "A proposal to review" });
  await expect(overviewProposal.getByText("0/1 reviewed")).toBeVisible();
  await expect(overviewProposal.getByText("Average —")).toBeVisible();
  await reviewNavigation.getByRole("link", { name: "Assignments" }).click();
  await expect(page).toHaveURL(`/events/${slug}/review/assignments`);
  await expect(
    page.getByLabel("Reviewer for A proposal to review"),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Reviewer progress" }),
  ).toContainText("0/3 reviewed");
  await reviewNavigation.getByRole("link", { name: "Decisions" }).click();
  await expect(page).toHaveURL(`/events/${slug}/review/decisions`);
  await expect(page.getByLabel("Internal outcome").first()).toBeVisible();
  await reviewNavigation.getByRole("link", { name: "My reviews" }).click();
  await expect(page).toHaveURL(`/events/${slug}/review/my-reviews`);
  const reviewCard = page
    .locator(".reviewer-card")
    .filter({ hasText: "A proposal to review" });
  await reviewCard.getByLabel("Score").selectOption("5");
  await reviewCard
    .getByLabel("Private reviewer comment")
    .fill("Exact browser review comment.");
  await page.route(/\/api\/trpc\/reviews\.save(?:\?|$)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await reviewCard.getByRole("button", { name: "Save review" }).click();
  await expect(reviewCard.getByRole("status")).toHaveText("Saving review…");
  await expect(reviewCard.getByRole("status")).toHaveText("Review saved");
  await reviewCard.getByLabel("Score").selectOption("4");
  await expect(reviewCard.getByRole("status")).toHaveCount(0);
  await reviewCard.getByLabel("Score").selectOption("5");
  await page.unroute(/\/api\/trpc\/reviews\.save(?:\?|$)/);
  const lowerScoredCard = page
    .locator(".reviewer-card")
    .filter({ hasText: "A lower scored proposal" });
  await lowerScoredCard.getByLabel("Score").selectOption("3");
  await lowerScoredCard
    .getByLabel("Private reviewer comment")
    .fill("Useful, with a narrower scope.");
  await lowerScoredCard.getByRole("button", { name: "Save review" }).click();
  await expect(lowerScoredCard.getByRole("status")).toHaveText("Review saved");
  await reviewNavigation.getByRole("link", { name: "Assignments" }).click();
  await expect(
    page.getByRole("region", { name: "Reviewer progress" }),
  ).toContainText("2/3 reviewed");
  await reviewNavigation.getByRole("link", { name: "Overview" }).click();
  await expect(overviewProposal.getByText("1/1 reviewed")).toBeVisible();
  await expect(overviewProposal.getByText("Average 5.0")).toBeVisible();
  await expect(page.getByText("Exact browser review comment.")).toBeVisible();
  await expect(page.getByText(`Score 5`)).toBeVisible();
  const sort = page.getByLabel("Sort proposals");
  await sort.selectOption("average-asc");
  await expect(page.locator(".review-proposal h2")).toHaveText([
    "A lower scored proposal",
    "A proposal to review",
    "An unscored proposal",
  ]);
  await sort.selectOption("average-desc");
  await expect(page.locator(".review-proposal h2")).toHaveText([
    "A proposal to review",
    "A lower scored proposal",
    "An unscored proposal",
  ]);

  await reviewNavigation.getByRole("link", { name: "My reviews" }).click();
  await page.route(/\/api\/trpc\/reviews\.save(?:\?|$)/, (route) =>
    route.abort("failed"),
  );
  await reviewCard.getByLabel("Score").selectOption("4");
  await reviewCard
    .getByLabel("Private reviewer comment")
    .fill("Keep this comment after failure.");
  await reviewCard.getByRole("button", { name: "Update review" }).click();
  await expect(reviewCard.getByRole("alert")).toHaveText(
    "Review could not be saved. Your score and comment are still here. Try again.",
  );
  await expect(reviewCard.getByLabel("Score")).toHaveValue("4");
  await expect(reviewCard.getByLabel("Private reviewer comment")).toHaveValue(
    "Keep this comment after failure.",
  );
  await page.unroute(/\/api\/trpc\/reviews\.save(?:\?|$)/);
  await reviewCard.getByRole("button", { name: "Update review" }).click();
  await expect(reviewCard.getByRole("status")).toHaveText("Review saved");
  await reviewNavigation.getByRole("link", { name: "Overview" }).click();
  await expect(page).toHaveURL(`/events/${slug}/review`);
  await expect(overviewProposal.getByText("Average 4.0")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Close reviewing" }).click();
  await expect(page.getByText("Reviewing is closed.")).toBeVisible();
  await reviewNavigation.getByRole("link", { name: "My reviews" }).click();
  await expect(
    reviewCard.getByText(
      "Score and comment controls are unavailable because this review round is closed.",
    ),
  ).toBeVisible();
  await expect(reviewCard.getByLabel("Score")).toBeDisabled();
  await expect(
    reviewCard.getByLabel("Private reviewer comment"),
  ).toBeDisabled();

  const pureReviewerEmail = `browser-pure-reviewer-${suffix}@example.com`;
  const pureOrganizerEmail = `browser-pure-organizer-${suffix}@example.com`;
  await invite(page.request, slug, pureReviewerEmail, "reviewer");
  await invite(page.request, slug, pureOrganizerEmail, "organizer");

  await acceptRole(page, pureReviewerEmail);
  await page.goto(`/events/${slug}/review/decisions`);
  await expect(page).toHaveURL(`/events/${slug}/review/my-reviews`);
  await expect(
    page
      .getByRole("navigation", { name: "Review navigation" })
      .getByRole("link"),
  ).toHaveText(["My reviews"]);

  await acceptRole(page, pureOrganizerEmail);
  await page.goto(`/events/${slug}/review/my-reviews`);
  await expect(page).toHaveURL(`/events/${slug}/review`);
  await expect(
    page
      .getByRole("navigation", { name: "Review navigation" })
      .getByRole("link"),
  ).toHaveText(["Overview", "Assignments", "Decisions"]);
});

async function invite(
  request: APIRequestContext,
  slug: string,
  email: string,
  role: "organizer" | "reviewer",
) {
  await mutate(request, "eventTeam.invite", { slug, email, role });
}

async function acceptRole(page: Page, email: string) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/sign-in");
  await signIn(page, email, "Open my board");
  const secretResponse = await page.request.get(
    `/api/dev/invitation-secret?email=${encodeURIComponent(email)}`,
  );
  const { secret } = (await secretResponse.json()) as { secret: string };
  await mutate(page.request, "invitations.accept", { secret });
}

async function mutate<T = Record<string, unknown>>(
  request: APIRequestContext,
  path: string,
  input: unknown,
): Promise<T> {
  const response = await request.post(`/api/trpc/${path}`, { data: input });
  const body = (await response.json()) as {
    result?: { data: T };
    error?: { message?: string };
  };
  if (!response.ok() || !body.result) {
    throw new Error(
      `${path} failed: ${body.error?.message ?? response.status()}`,
    );
  }
  return body.result.data;
}

async function query<T>(
  request: APIRequestContext,
  path: string,
  input: unknown,
): Promise<T> {
  const response = await request.get(
    `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
  );
  const body = (await response.json()) as { result?: { data: T } };
  if (!response.ok() || !body.result) throw new Error(`${path} failed`);
  return body.result.data;
}
