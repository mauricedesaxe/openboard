import { expect, test, type APIRequestContext } from "@playwright/test";

import { signIn } from "./support";

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
    page.getByRole("heading", { name: "Shape the event." }),
  ).toBeVisible();
  await expect(page.getByText("2 unplaced")).toBeVisible();
  await expect(
    page.getByText("New service block", { exact: true }),
  ).toBeVisible();

  const working = await query(page.request, "agendas.working", { slug });
  const unplaced = working.unplacedProgramItems as Array<
    Record<string, unknown>
  >;
  const firstProgram = unplaced.find(
    (item) => item.title === "A browser-built agenda",
  );
  const secondProgram = unplaced.find(
    (item) => item.title === "A second browser session",
  );
  const firstPlacement = await mutate(page.request, "agendas.placeProgram", {
    slug,
    programItemId: firstProgram?.id,
    roomId: room.id,
    startsAtLocal: "2028-08-13T09:00",
    endsAtLocal: "2028-08-13T10:00",
  });
  const secondPlacement = await mutate(page.request, "agendas.placeProgram", {
    slug,
    programItemId: secondProgram?.id,
    roomId: room.id,
    startsAtLocal: "2028-08-13T09:30",
    endsAtLocal: "2028-08-13T10:30",
  });
  await mutate(page.request, "agendas.placeService", {
    slug,
    title: "Lunch",
    scope: { type: "event" },
    startsAtLocal: "2028-08-13T12:00",
    endsAtLocal: "2028-08-13T13:00",
  });
  await page.reload();
  await expect(page.getByText("2 conflicts")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publish agenda" }),
  ).toBeDisabled();

  await page.getByText("A second browser session", { exact: true }).click();
  const inspector = page.locator(".agenda-inspector");
  await expect(
    inspector.getByRole("heading", { name: "A second browser session" }),
  ).toBeVisible();
  await inspector.getByLabel("Room").selectOption(secondRoom.id as string);
  await inspector.getByLabel("Starts").fill("2028-08-14T10:00");
  await inspector.getByLabel("Ends").fill("2028-08-14T11:00");
  await inspector.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("0 conflicts")).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`item=${String(secondPlacement.id)}`),
  );
  await publishAgenda(page);
  await expect(
    page.getByText("Working agenda · revision", { exact: false }),
  ).toBeVisible();

  await page.getByRole("link", { name: "View public agenda" }).click();
  await expect(
    page.getByText("A browser-built agenda", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Room").selectOption(secondRoom.id as string);
  await expect(
    page.getByText("A second browser session", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("A browser-built agenda", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Lunch", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "list", exact: true }).click();
  await expect(
    page.getByText("A second browser session", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "list", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.goto(`/events/${slug}/agenda?item=${String(firstPlacement.id)}`);
  await inspector.getByRole("button", { name: "Cancel placement" }).click();
  await expect(
    inspector.getByRole("button", { name: "Restore placement" }),
  ).toBeVisible();
  await publishAgenda(page);
  await page.goto(`/events/${slug}/schedule`);
  await expect(
    page.getByText("A browser-built agenda", { exact: true }),
  ).toHaveCount(0);

  await page.goto(`/events/${slug}/agenda?item=${String(firstPlacement.id)}`);
  await inspector.getByRole("button", { name: "Restore placement" }).click();
  await expect(
    inspector.getByRole("button", { name: "Cancel placement" }),
  ).toBeVisible();
  await publishAgenda(page);
  await page.goto(`/events/${slug}/schedule`);
  await expect(
    page.getByText("A browser-built agenda", { exact: true }),
  ).toBeVisible();
  expect(firstPlacement.id).toBeTruthy();
});

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

async function publishAgenda(page: Parameters<typeof signIn>[0]) {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().includes("/api/trpc/agendas.publish") &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Publish agenda" }).click();
  expect((await response).ok()).toBe(true);
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
