import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { signIn } from "./support";

test("manages readiness across overview, definitions, and assignments", async ({
  page,
}) => {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const slug = `browser-readiness-${suffix}`;
  const ownerEmail = `browser-readiness-owner-${suffix}@example.com`;
  await page.goto("/");
  await signIn(page, ownerEmail, "Open my board");
  await createAcceptedProgramItem(page, slug, ownerEmail, suffix);

  await page.goto(`/events/${slug}/readiness`);
  await expect(
    page.getByRole("heading", { name: "Act on what is blocking the program." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Program items" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Define the readiness task" }),
  ).toHaveCount(0);

  await page.getByRole("link", { name: "Task definitions" }).click();
  await expect(page).toHaveURL(`/events/${slug}/readiness/task-definitions`);
  await page.getByRole("textbox", { name: "Name" }).fill("Speaker agreement");
  await page.getByRole("button", { name: "Create task definition" }).click();
  await expect(page.getByText("Task definition created")).toBeVisible();
  await expect(page.getByText("Speaker agreement")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Program items" }),
  ).toHaveCount(0);

  await page.getByRole("link", { name: "Task assignments" }).click();
  await expect(page).toHaveURL(`/events/${slug}/readiness/task-assignments`);
  await expect(page.getByLabel("Task definition")).toContainText(
    "Speaker agreement",
  );
  await page.getByLabel("Task definition").selectOption({
    label: "Speaker agreement",
  });
  await page.getByLabel("Target").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Create assignment" }).click();
  await expect(page.getByText("Assignment created")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Speaker agreement" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Send reminder" }).click();
  await expect(
    page.getByText("Reminder queued", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Reusable requirements" }),
  ).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(`/events/${slug}/readiness/task-definitions`);
  await page.goBack();
  await expect(page).toHaveURL(`/events/${slug}/readiness`);

  await page.goto(`/events/${slug}/onboarding`);
  await expect(page).toHaveURL(`/events/${slug}/onboarding`);
  await expect(page.locator("main")).toBeEmpty();
});

async function createAcceptedProgramItem(
  page: Page,
  slug: string,
  ownerEmail: string,
  suffix: string,
) {
  await mutate(page.request, "events.create", {
    name: "Browser Readiness Conference",
    slug,
    startsOn: "2028-08-10",
    endsOn: "2028-08-12",
    timezone: "Europe/Berlin",
  });
  const track = await mutate(page.request, "tracks.create", {
    slug,
    name: "Delivery",
  });
  const cfp = await mutate(page.request, "cfps.createDraft", {
    slug,
    name: "Readiness CFP",
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

  const speakerEmail = `browser-readiness-speaker-${suffix}@example.com`;
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/sign-in");
  await signIn(page, speakerEmail, "Open my board");
  const submission = await mutate(page.request, "submissions.submit", {
    slug,
    cfpId: cfp.id,
    clientDraftId: crypto.randomUUID(),
    title: "Ready for delivery",
    abstract: "This accepted proposal supplies a real readiness target.",
    format: "Talk",
    trackId: track.id,
    proposedSpeakers: [{ name: "Browser Speaker", email: speakerEmail }],
    customAnswers: {},
  });

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/sign-in");
  await signIn(page, ownerEmail, "Open my board");
  await mutate(page.request, "reviews.openRound", { slug });
  await mutate(page.request, "reviews.closeRound", {
    slug,
    allowMissingReviews: true,
  });
  await mutate(page.request, "decisions.queue", {
    slug,
    submissionId: submission.id,
    status: "accept_queued",
  });
  const board = await query(page.request, "reviews.organizerBoard", { slug });
  const selected = (board.submissions as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === submission.id,
  );
  const decision = selected?.decision as Record<string, unknown>;
  await mutate(page.request, "decisions.publish", {
    slug,
    selections: [
      {
        submissionId: submission.id,
        expectedStatus: "accept_queued",
        expectedRevision: decision.revision as number,
      },
    ],
  });
}

async function mutate(
  request: APIRequestContext,
  path: string,
  data: unknown,
): Promise<Record<string, unknown>> {
  const response = await request.post(`/api/trpc/${path}`, { data });
  const body = (await response.json()) as {
    result?: { data: Record<string, unknown> };
    error?: { message?: string };
  };
  if (!response.ok() || !body.result) {
    throw new Error(
      `${path} failed with ${response.status()}: ${body.error?.message ?? "unknown error"}`,
    );
  }
  return body.result.data;
}

async function query(
  request: APIRequestContext,
  path: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await request.get(
    `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
  );
  const body = (await response.json()) as {
    result?: { data: Record<string, unknown> };
  };
  if (!response.ok() || !body.result) {
    throw new Error(`${path} failed with ${response.status()}`);
  }
  return body.result.data;
}
