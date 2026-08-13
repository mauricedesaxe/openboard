import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { requestSignInCode } from "./support";

test("refreshes the public CFP after its definition changes", async ({
  page,
}) => {
  const suffix = `${Date.now()}`;
  const slug = `browser-cfp-inputs-${suffix}`;
  await page.goto("/");
  await signIn(page, `browser-cfp-owner-${suffix}@example.com`);
  await createEvent(page, slug);
  await page.goto(`/events/${slug}/tracks`);
  await page
    .getByRole("textbox", { name: "New track name" })
    .fill("Web systems");
  await page.getByRole("button", { name: "Add" }).first().click();
  await expect(page.getByText("Track created", { exact: true })).toBeVisible();
  await page.goto(`/events/${slug}/rooms`);
  await page.getByRole("textbox", { name: "New room name" }).fill("Studio");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Room created", { exact: true })).toBeVisible();
  await page.goto(`/events/${slug}/cfp/manage`);
  const cfpNavigation = page
    .getByRole("navigation", {
      name: "Browser CFP Input Conference navigation",
    })
    .getByRole("link", { name: "CFP" });
  await expect(
    cfpNavigation.getByLabel("1 item needs attention"),
  ).toBeVisible();

  const formats = page.getByRole("textbox", { name: "Formats" });
  await formats.fill("");
  await formats.pressSequentially("Talk, Lightning talk");
  await expect(formats).toHaveValue("Talk, Lightning talk");

  await page.getByRole("button", { name: "+ Single select" }).click();
  const options = page.getByRole("textbox", { name: "Options" });
  await options.fill("");
  await options.pressSequentially("First, Second choice");
  await expect(options).toHaveValue("First, Second choice");

  await page.getByRole("textbox", { name: "CFP name" }).fill("Browser CFP");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByText("Draft created", { exact: true })).toBeVisible();
  await expect(
    cfpNavigation.getByLabel("1 item needs attention"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save form" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Formats" })).toHaveValue(
    "Talk, Lightning talk",
  );
  await expect(page.getByRole("textbox", { name: "Options" })).toHaveValue(
    "First, Second choice",
  );

  await page.getByRole("button", { name: "Open CFP" }).click();
  await expect(cfpNavigation.getByLabel(/needs attention/)).toHaveCount(0);
  await page.getByRole("link", { name: "View public form →" }).click();
  await expect(
    page.getByRole("heading", { name: "Browser CFP", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.locator("#cfp-name-new")).toHaveValue("");
  const openCfp = page.locator(".cfp-builder").filter({
    has: page.locator(".status-open"),
  });
  await openCfp
    .getByRole("textbox", { name: "CFP name" })
    .fill("Updated Browser CFP");
  await openCfp.getByRole("button", { name: "Save form" }).click();
  await expect(page.getByText("CFP saved", { exact: true })).toBeVisible();
  await openCfp.getByRole("link", { name: "View public form →" }).click();
  await expect(
    page.getByRole("heading", { name: "Updated Browser CFP" }),
  ).toBeVisible();
});

test("bounds and explains the CFP deadline in event time", async ({ page }) => {
  const suffix = `${Date.now()}`;
  const slug = `browser-cfp-deadline-${suffix}`;
  await page.goto("/");
  await signIn(page, `browser-cfp-deadline-owner-${suffix}@example.com`);
  await createEvent(page, slug);
  await page.goto(`/events/${slug}/cfp/manage`);

  const deadline = page.getByLabel("Deadline");
  await expect(deadline).toHaveValue("2028-08-10T17:00");
  await expect(deadline).toHaveAttribute("min", /^20\d\d-\d\d-\d\dT\d\d:\d\d$/);
  await expect(deadline).toHaveAttribute("max", "2028-08-12T23:59");
  await expect(page.getByText(/Aug 10, 2028.*Aug 12, 2028/)).toBeVisible();

  await deadline.fill("2020-01-01T09:00");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(
    page.getByText("Choose a deadline in the future."),
  ).toBeVisible();

  await deadline.fill("2028-08-13T00:00");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(
    page.getByText("Choose a deadline on or before the event end date."),
  ).toBeVisible();

  await deadline.fill("");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByText("Choose a deadline.")).toBeVisible();

  await deadline.fill("2028-07-01T09:00");
  await expect(
    page.getByText("The deadline is before the event starts."),
  ).toBeVisible();
});

test("saves unrelated changes after a stored CFP deadline passes", async ({
  page,
}) => {
  const suffix = `${Date.now()}`;
  const slug = `browser-passed-cfp-deadline-${suffix}`;
  await page.goto("/");
  await signIn(page, `browser-passed-deadline-owner-${suffix}@example.com`);
  await createEvent(page, slug);
  await mutate(page.request, "cfps.createDraft", {
    slug,
    name: "Past deadline CFP",
    deadline: "2028-08-01T09:00:00Z",
    formats: ["Talk"],
    customFields: [],
  });

  await page.clock.install({ time: new Date("2028-08-02T09:00:00Z") });
  await page.goto(`/events/${slug}/cfp/manage`);
  const draft = page.locator(".cfp-builder").filter({
    has: page.locator(".status-draft"),
  });
  await draft
    .getByRole("textbox", { name: "CFP name" })
    .fill("Renamed past deadline CFP");
  await draft.getByRole("button", { name: "Save form" }).click();
  await expect(page.getByText("CFP saved", { exact: true })).toBeVisible();
});

test("refreshes the public CFP after its tracks change", async ({ page }) => {
  const suffix = `${Date.now()}`;
  const slug = `browser-cfp-tracks-${suffix}`;
  await page.goto("/");
  await signIn(page, `browser-cfp-track-owner-${suffix}@example.com`);
  await createEvent(page, slug);
  await page.goto(`/events/${slug}/tracks`);
  await page
    .getByRole("textbox", { name: "New track name" })
    .fill("Web systems");
  await page.getByRole("button", { name: "Add" }).first().click();
  await page.goto(`/events/${slug}/cfp/manage`);
  await page.getByRole("textbox", { name: "CFP name" }).fill("Browser CFP");
  await page.getByRole("button", { name: "Create draft" }).click();
  await page.getByRole("button", { name: "Open CFP" }).click();
  await page.getByRole("link", { name: "View public form →" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Track")).toContainText("Web systems");

  await page.goBack();
  await page.goto(`/events/${slug}/tracks`);
  await page
    .getByRole("textbox", { name: "New track name" })
    .fill("AI systems");
  await page.getByRole("button", { name: "Add" }).first().click();
  await expect(page.getByText("Track created", { exact: true })).toBeVisible();
  await page.goto(`/events/${slug}/cfp/manage`);
  await page.getByRole("link", { name: "View public form →" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Track")).toContainText("AI systems");
});

test("keeps focused routes direct and removes the combined setup route", async ({
  page,
}) => {
  const suffix = `${Date.now()}`;
  const slug = `browser-focused-routes-${suffix}`;
  const ownerEmail = `browser-focused-owner-${suffix}@example.com`;
  await page.goto("/");
  await signIn(page, ownerEmail);
  await createEvent(page, slug);

  await page.goto(`/events/${slug}/tracks`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Tracks" }),
  ).toBeVisible();
  await page.goto(`/events/${slug}/rooms`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Rooms" }),
  ).toBeVisible();
  await page.goto(`/events/${slug}/cfp/manage`);
  await expect(
    page.getByRole("heading", { name: "Browser CFP Input Conference CFP" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/events/${slug}/tracks`);
  await page.getByRole("button", { name: "Open navigation" }).click();
  const mobileNavigation = page.locator(".app-sidebar.navigation-open");
  await mobileNavigation
    .getByRole("navigation", {
      name: "Browser CFP Input Conference navigation",
    })
    .getByRole("link", { name: "CFP" })
    .click();
  await expect(page).toHaveURL(`/events/${slug}/cfp/manage`);

  await page.goto(`/events/${slug}/cfp/setup`);
  await expect(page).toHaveURL(`/events/${slug}/cfp/setup`);
  await expect(page.locator(".workspace-main")).toBeEmpty();
});

test("locks track structure after the first submission", async ({ page }) => {
  const suffix = `${Date.now()}`;
  const slug = `browser-locked-tracks-${suffix}`;
  const ownerEmail = `browser-locked-owner-${suffix}@example.com`;
  await page.goto("/");
  await signIn(page, ownerEmail);
  await createEvent(page, slug);
  const track = await mutate(page.request, "tracks.create", {
    slug,
    name: "Web systems",
  });
  const cfp = await mutate(page.request, "cfps.createDraft", {
    slug,
    name: "Locked CFP",
    deadline: "2028-08-01T00:00:00Z",
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
  await mutate(page.request, "submissions.submit", {
    slug,
    cfpId: cfp.id,
    clientDraftId: crypto.randomUUID(),
    title: "A locked structure",
    abstract: "This proposal locks the event track structure for organizers.",
    format: "Talk",
    trackId: track.id,
    proposedSpeakers: [{ name: "Owner Speaker", email: ownerEmail }],
    customAnswers: {},
  });

  await page.goto(`/events/${slug}/tracks`);
  await expect(
    page.getByRole("textbox", { name: "New track name" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("textbox", { name: "track name: Web systems" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Archive" })).toBeDisabled();
});

async function signIn(page: Page, email: string) {
  const code = await requestSignInCode(page, email);
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(code);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/sign-in")),
    page.getByRole("button", { name: "Open my board" }).click(),
  ]);
}

async function createEvent(page: Page, slug: string) {
  const response = await page.request.post("/api/trpc/events.create", {
    data: {
      name: "Browser CFP Input Conference",
      slug,
      startsOn: "2028-08-10",
      endsOn: "2028-08-12",
      timezone: "Europe/Berlin",
    },
  });
  expect(response.ok()).toBe(true);
}

async function mutate(
  request: APIRequestContext,
  path: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  const response = await request.post(`/api/trpc/${path}`, { data: input });
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
