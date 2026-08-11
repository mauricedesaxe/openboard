import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

test.setTimeout(60_000);

test("publishes a working placement to every public agenda view", async ({
  page,
}) => {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const slug = `browser-agenda-${suffix}`;
  const ownerEmail = `browser-agenda-owner-${suffix}@example.com`;
  const submitterEmail = `browser-agenda-speaker-${suffix}@example.com`;
  await page.goto("/");
  await signIn(page, ownerEmail, "Open my board");
  const event = await mutate(page.request, "events.create", {
    name: "Browser Agenda Conference",
    slug,
    startsOn: "2028-08-13",
    endsOn: "2028-08-18",
    timezone: "Europe/Berlin",
  });
  expect(event.id).toBeTruthy();
  const track = await mutate(page.request, "tracks.create", {
    slug,
    name: "Web systems",
  });
  const secondTrack = await mutate(page.request, "tracks.create", {
    slug,
    name: "Data systems",
  });
  const room = await mutate(page.request, "rooms.create", {
    slug,
    name: "Main hall",
  });
  const secondRoom = await mutate(page.request, "rooms.create", {
    slug,
    name: "Studio",
  });
  const cfp = await mutate(page.request, "cfps.createDraft", {
    slug,
    name: "Browser agenda CFP",
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

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/sign-in");
  await signIn(page, submitterEmail, "Open my board");
  const submission = await mutate(page.request, "submissions.submit", {
    slug,
    cfpId: cfp.id,
    clientDraftId: crypto.randomUUID(),
    title: "A browser-built agenda",
    abstract: "This accepted program item proves the public browser workflow.",
    format: "Talk",
    trackId: track.id,
    proposedSpeakers: [{ name: "Browser Speaker", email: submitterEmail }],
    customAnswers: {},
  });
  const secondSubmission = await mutate(page.request, "submissions.submit", {
    slug,
    cfpId: cfp.id,
    clientDraftId: crypto.randomUUID(),
    title: "A second browser session",
    abstract:
      "This second accepted item creates and then resolves a room conflict.",
    format: "Talk",
    trackId: secondTrack.id,
    proposedSpeakers: [
      { name: "Second Browser Speaker", email: submitterEmail },
    ],
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
  await mutate(page.request, "decisions.queue", {
    slug,
    submissionId: secondSubmission.id,
    status: "accept_queued",
  });
  const board = await query(page.request, "reviews.organizerBoard", { slug });
  const boardSubmissions = board.submissions as Array<Record<string, unknown>>;
  await mutate(page.request, "decisions.publish", {
    slug,
    selections: [submission, secondSubmission].map((candidate) => {
      const selected = boardSubmissions.find(
        (boardSubmission) => boardSubmission.id === candidate.id,
      );
      const decision = selected?.decision as Record<string, unknown>;
      return {
        submissionId: candidate.id,
        expectedStatus: "accept_queued",
        expectedRevision: decision.revision,
      };
    }),
  });

  await page.goto(`/events/${slug}`);
  await page.getByRole("link", { name: "Open working agenda" }).click();
  await expect(
    page.getByRole("heading", { name: "Build the agenda." }),
  ).toBeVisible();
  const placementForm = page
    .getByRole("heading", { name: "Schedule an accepted item" })
    .locator("..");
  await placementForm
    .getByLabel("Program item")
    .selectOption({ label: "A browser-built agenda · Web systems" });
  await placementForm.getByLabel("Room").selectOption(room.id as string);
  await placementForm.getByLabel("Starts").fill("2028-08-13T09:00");
  await placementForm.getByLabel("Ends").fill("2028-08-13T10:00");
  await placementForm
    .getByRole("button", { name: "Place program item" })
    .click();
  await expect(page.getByText("1 durable item")).toBeVisible();
  await placementForm
    .getByLabel("Program item")
    .selectOption({ label: "A second browser session · Data systems" });
  await placementForm.getByLabel("Room").selectOption(room.id as string);
  await placementForm.getByLabel("Starts").fill("2028-08-13T09:30");
  await placementForm.getByLabel("Ends").fill("2028-08-13T10:30");
  await placementForm
    .getByRole("button", { name: "Place program item" })
    .click();
  await expect(page.getByText("2 durable items")).toBeVisible();
  await page.getByRole("button", { name: "Publish agenda" }).click();
  await expect(
    page.getByText("Resolve every room conflict before publishing."),
  ).toBeVisible();

  const secondWorkingItem = page
    .locator(".working-agenda-item")
    .filter({ hasText: "A second browser session" });
  await secondWorkingItem
    .getByLabel("Room")
    .selectOption(secondRoom.id as string);
  await secondWorkingItem.getByLabel("Starts").fill("2028-08-14T10:00");
  await secondWorkingItem.getByLabel("Ends").fill("2028-08-14T11:00");
  await secondWorkingItem.getByRole("button", { name: "Save move" }).click();
  const serviceForm = page
    .getByRole("heading", { name: "Block event time" })
    .locator("..");
  await serviceForm.getByLabel("Title").fill("Lunch");
  await serviceForm.getByLabel("Starts").fill("2028-08-13T12:00");
  await serviceForm.getByLabel("Ends").fill("2028-08-13T13:00");
  await serviceForm.getByRole("button", { name: "Add service block" }).click();
  await expect(page.getByText("3 durable items")).toBeVisible();
  await page.getByRole("button", { name: "Publish agenda" }).click();
  await expect(page.getByText(/Public revision 1 is live/)).toBeVisible();

  await page.getByRole("link", { name: "View public agenda" }).click();
  await expect(
    page.getByRole("heading", { name: "A browser-built agenda" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "week", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A browser-built agenda" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "A second browser session" }),
  ).toHaveCount(0);
  await page.getByLabel("Week").selectOption("2028-08-14");
  await expect(
    page.getByRole("heading", { name: "A browser-built agenda" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "A second browser session" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Week")).toHaveValue("2028-08-14");
  await expect(
    page.getByRole("heading", { name: "A second browser session" }),
  ).toBeVisible();

  await page.goto(`/events/${slug}/schedule?view=room`);
  await expect(page.getByLabel("Room")).toHaveValue("Main hall");
  await expect(
    page.getByRole("heading", { name: "A browser-built agenda" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "A second browser session" }),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Lunch" })).toBeVisible();
  await page.getByLabel("Room").selectOption("Studio");
  await expect(
    page.getByRole("heading", { name: "A second browser session" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "track", exact: true }).click();
  await expect(page.getByLabel("Track")).toHaveValue("Web systems");
  await expect(
    page.getByRole("heading", { name: "A second browser session" }),
  ).toHaveCount(0);
  await page.getByLabel("Track").selectOption("Data systems");
  await expect(
    page.getByRole("heading", { name: "A second browser session" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lunch" })).toBeVisible();

  await page.getByRole("button", { name: "day", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A browser-built agenda" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "A second browser session" }),
  ).toHaveCount(0);
  await page.getByLabel("Day").selectOption("2028-08-14");
  await expect(
    page.getByRole("heading", { name: "A second browser session" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "list", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A browser-built agenda" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "A second browser session" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "A browser-built agenda" }),
  ).toBeVisible();

  await page.goto(`/events/${slug}/agenda`);
  const firstWorkingItem = page
    .locator(".working-agenda-item")
    .filter({ hasText: "A browser-built agenda" });
  await firstWorkingItem.getByRole("button", { name: "Cancel" }).click();
  await expect(
    firstWorkingItem.getByRole("button", { name: "Restore" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Publish agenda" }).click();
  await expect(page.getByText(/Public revision 2 is live/)).toBeVisible();
  await page.goto(`/events/${slug}/schedule`);
  await expect(
    page.getByRole("heading", { name: "A browser-built agenda" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "A second browser session" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "A browser-built agenda" }),
  ).toHaveCount(0);

  await page.goto(`/events/${slug}/agenda`);
  await page
    .locator(".working-agenda-item")
    .filter({ hasText: "A browser-built agenda" })
    .getByRole("button", { name: "Restore" })
    .click();
  await expect(
    page
      .locator(".working-agenda-item")
      .filter({ hasText: "A browser-built agenda" })
      .getByRole("button", { name: "Cancel" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Publish agenda" }).click();
  await expect(page.getByText(/Public revision 3 is live/)).toBeVisible();
  await page.goto(`/events/${slug}/schedule`);
  await expect(
    page.getByRole("heading", { name: "A browser-built agenda" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "A browser-built agenda" }),
  ).toBeVisible();
});

async function signIn(page: Page, email: string, buttonName: string) {
  const addressSuffix = [...email]
    .reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0)
    .toString(16)
    .padStart(8, "0");
  await page.setExtraHTTPHeaders({
    "CF-Connecting-IP": `2001:db8:${addressSuffix.slice(0, 4)}:${addressSuffix.slice(4)}::1`,
  });
  await page.getByRole("textbox", { name: "Work email" }).fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  const code = await page.locator(".dev-code strong").textContent();
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(code ?? "");
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/sign-in")),
    page.getByRole("button", { name: buttonName }).click(),
  ]);
  await page.waitForLoadState("networkidle");
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

async function query(
  request: APIRequestContext,
  path: string,
  input: unknown,
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
