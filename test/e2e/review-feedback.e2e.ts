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
    name: cfp.name,
    deadline: cfp.deadline,
    formats: cfp.formats,
    customFields: cfp.customFields,
  });
  await mutate(page.request, "eventTeam.invite", {
    slug,
    email: ownerEmail,
    role: "reviewer",
  });
  const secretResponse = await page.request.get(
    `/api/dev/invitation-secret?email=${encodeURIComponent(ownerEmail)}`,
  );
  const { secret } = (await secretResponse.json()) as { secret: string };
  await mutate(page.request, "invitations.accept", { secret });

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
  await mutate(page.request, "reviews.openRound", { slug });

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
  await expect(page.getByText("0/1 reviewed")).toBeVisible();
  await expect(page.getByText("Average —")).toBeVisible();
  await reviewNavigation.getByRole("link", { name: "Assignments" }).click();
  await expect(page).toHaveURL(`/events/${slug}/review/assignments`);
  await expect(
    page.getByLabel("Reviewer for A proposal to review"),
  ).toBeVisible();
  await reviewNavigation.getByRole("link", { name: "Decisions" }).click();
  await expect(page).toHaveURL(`/events/${slug}/review/decisions`);
  await expect(page.getByLabel("Internal outcome")).toBeVisible();
  await reviewNavigation.getByRole("link", { name: "My reviews" }).click();
  await expect(page).toHaveURL(`/events/${slug}/review/my-reviews`);
  const reviewCard = page
    .locator(".reviewer-card")
    .filter({ hasText: "A proposal to review" });
  await reviewCard.getByLabel("Score").selectOption("5");
  await reviewCard.getByRole("button", { name: "Save review" }).click();
  await expect(page.getByRole("status")).toHaveText("Review saved");
  await reviewNavigation.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByText("1/1 reviewed")).toBeVisible();
  await expect(page.getByText("Average 5.0")).toBeVisible();

  await reviewNavigation.getByRole("link", { name: "My reviews" }).click();
  await page.route(/\/api\/trpc\/reviews\.save(?:\?|$)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.continue();
  });
  await reviewCard.getByLabel("Score").selectOption("4");
  await reviewCard.getByRole("button", { name: "Update review" }).click();
  await reviewNavigation.getByRole("link", { name: "Overview" }).click();
  await expect(page).toHaveURL(`/events/${slug}/review`);
  await expect(page.getByRole("status")).toHaveText("Review saved");
  await expect(page.getByText("Average 4.0")).toBeVisible();

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
