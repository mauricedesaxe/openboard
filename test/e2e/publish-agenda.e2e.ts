import { expect, test, type APIRequestContext } from "@playwright/test";

import { signIn } from "./support";

test.setTimeout(60_000);

test("publishes a working placement to every public agenda view", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
  const overlapRooms = await Promise.all(
    ["Workshop", "Library", "Terrace"].map((name) =>
      mutate(page.request, "rooms.create", { slug, name }),
    ),
  );
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
  await page
    .getByRole("navigation", { name: "Browser Agenda Conference navigation" })
    .getByRole("link", { name: "Agenda" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Shape the event." }),
  ).toBeVisible();
  await expect(page.getByText("2 unplaced")).toBeVisible();
  await expect(
    page.getByText("New service block", { exact: true }),
  ).toBeVisible();
  const calendarScroller = page.locator(".fc-scroller-liquid-absolute").last();
  await expect(calendarScroller).toBeVisible();
  await expect
    .poll(() =>
      calendarScroller.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      })),
    )
    .toMatchObject({ clientHeight: expect.any(Number) });
  expect(
    await calendarScroller.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  expect(
    await calendarScroller.evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);

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
  for (const [index, overlapRoom] of overlapRooms.entries()) {
    await mutate(page.request, "agendas.placeService", {
      slug,
      title: `Overlap ${index + 1}`,
      scope: { type: "room", roomId: overlapRoom.id },
      startsAtLocal: "2028-08-13T14:00",
      endsAtLocal: "2028-08-13T15:00",
    });
  }
  await page.reload();
  await expect(page.getByText("2 conflicts")).toBeVisible();
  await expect(page.getByText("speaker conflict")).toHaveCount(2);
  const overlapMore = page.locator(".fc-timegrid-more-link");
  await expect(overlapMore).toHaveText("+1");
  await expect(overlapMore).toHaveAttribute("title", "Show 1 more event");
  await overlapMore.click();
  await expect(page.locator(".fc-more-popover")).toBeVisible();
  await expect(page.getByText("Overlap 1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publish agenda" }),
  ).toBeDisabled();

  const inspector = page.locator(".agenda-inspector");
  await page.getByText("A browser-built agenda", { exact: true }).click();
  await expect(inspector.getByLabel("Starts")).toHaveValue("2028-08-13T09:00");
  await page.getByText("A second browser session", { exact: true }).click();
  await expect(
    inspector.getByRole("heading", { name: "A second browser session" }),
  ).toBeVisible();
  await expect(inspector.getByLabel("Starts")).toHaveValue("2028-08-13T09:30");
  let releaseMove: (() => void) | undefined;
  let moveRequestStarted = false;
  const moveGate = new Promise<void>((resolve) => {
    releaseMove = resolve;
  });
  await page.route("**/api/trpc/agendas.move**", async (route) => {
    moveRequestStarted = true;
    await moveGate;
    await route.continue();
  });
  await inspector.getByLabel("Room").selectOption(secondRoom.id as string);
  await expect.poll(() => moveRequestStarted).toBe(true);
  await expect(
    page.locator(".agenda-calendar-card", {
      hasText: "A second browser session",
    }),
  ).toBeVisible();
  await page
    .locator(".agenda-header-controls")
    .getByLabel("Room")
    .selectOption(secondRoom.id as string);
  await expect(
    page.locator(".agenda-calendar-card", {
      hasText: "A second browser session",
    }),
  ).toBeVisible();
  const moveResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/trpc/agendas.move") && response.ok(),
  );
  releaseMove?.();
  await moveResponse;
  await page.unroute("**/api/trpc/agendas.move**");
  await page
    .locator(".agenda-header-controls")
    .getByLabel("Room")
    .selectOption("");
  await inspector.getByLabel("Starts").fill("2028-08-14T10:00");
  await inspector.getByLabel("Ends").fill("2028-08-14T11:00");
  await expect
    .poll(async () => {
      const current = await query(page.request, "agendas.working", { slug });
      const items = current.items as Array<Record<string, unknown>>;
      return items.find((item) => item.id === secondPlacement.id)
        ?.startsAtLocal;
    })
    .toBe("2028-08-14T10:00");
  await expect(page.getByText("0 conflicts")).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`item=${String(secondPlacement.id)}`),
  );

  const lunchCard = page.locator(".agenda-calendar-card", {
    hasText: "Lunch",
  });
  await lunchCard.click();
  await expect(inspector.getByLabel("Starts")).toHaveValue("2028-08-13T12:00");
  const serviceSaveStatuses: number[] = [];
  const recordServiceSave = (response: {
    url: () => string;
    status: () => number;
  }) => {
    if (response.url().includes("agendas.updateService")) {
      serviceSaveStatuses.push(response.status());
    }
  };
  page.on("response", recordServiceSave);
  const lunchBox = await lunchCard.boundingBox();
  if (!lunchBox) throw new Error("Lunch card not rendered");
  await page.mouse.move(lunchBox.x + lunchBox.width / 2, lunchBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(lunchBox.x + lunchBox.width / 2, lunchBox.y + 100, {
    steps: 10,
  });
  await page.mouse.up();
  await calendarScroller.evaluate((element) => {
    element.scrollTop = 1400;
  });
  await expect(inspector.getByLabel("Starts")).not.toHaveValue(
    "2028-08-13T12:00",
  );
  const draggedStart = await inspector.getByLabel("Starts").inputValue();
  await expect
    .poll(async () => {
      const current = await query(page.request, "agendas.working", { slug });
      const items = current.items as Array<Record<string, unknown>>;
      return items.find((item) => item.serviceTitle === "Lunch")?.startsAtLocal;
    })
    .toBe(draggedStart);
  await expect(page.locator(".agenda-save-error")).toHaveCount(0);
  expect(serviceSaveStatuses).toEqual([]);
  await expect
    .poll(() => calendarScroller.evaluate((element) => element.scrollTop))
    .toBe(1400);
  page.off("response", recordServiceSave);

  await publishAgenda(page);
  await expect(
    page.getByText("Working agenda · revision", { exact: false }),
  ).toBeVisible();
  const origin = new URL(page.url()).origin;
  const share = page.getByRole("region", { name: "Share" });
  await expect(share).toBeVisible();
  await expect(share.getByText("Published revision 1")).toBeVisible();
  const publicAgendaUrl = `${origin}/events/${slug}/schedule`;
  const scheduleJsonUrl = `${origin}/api/v1/events/${slug}/schedule`;
  const calendarUrl = `${origin}/api/v1/events/${slug}/schedule.ics`;
  const publishedOutputs = [publicAgendaUrl, scheduleJsonUrl, calendarUrl];
  for (const output of publishedOutputs) {
    await expect(
      share.getByRole("link", { name: output, exact: true }),
    ).toHaveAttribute("href", output);
  }
  const [scheduleResponse, calendarResponse] = await Promise.all([
    page.request.get(scheduleJsonUrl),
    page.request.get(calendarUrl),
  ]);
  expect(scheduleResponse.ok()).toBe(true);
  expect(calendarResponse.ok()).toBe(true);

  await page.evaluate(() => {
    Object.assign(window, { copiedUrls: [] });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (url: string) => {
          (
            window as unknown as Window & { copiedUrls: string[] }
          ).copiedUrls.push(url);
          return Promise.resolve();
        },
      },
    });
  });
  for (const { label, url } of [
    { label: "Public agenda", url: publicAgendaUrl },
    { label: "Schedule JSON", url: scheduleJsonUrl },
    { label: "iCalendar feed", url: calendarUrl },
  ]) {
    await share.getByRole("button", { name: `Copy ${label} URL` }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as Window & { copiedUrls: string[] }).copiedUrls,
        ),
      )
      .toContain(url);
  }
  expect(
    await page.evaluate(
      () => (window as unknown as Window & { copiedUrls: string[] }).copiedUrls,
    ),
  ).toEqual([publicAgendaUrl, scheduleJsonUrl, calendarUrl]);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });
  await share.getByRole("button", { name: "Copy Schedule JSON URL" }).click();
  await expect(
    share.getByText("Copy failed. Use the link directly."),
  ).toBeVisible();
  await expect(
    share.getByRole("link", { name: scheduleJsonUrl, exact: true }),
  ).toHaveAttribute("href", scheduleJsonUrl);

  const publicationStatusRequest =
    /\/api\/trpc\/[^?]*agendas\.publicationStatus/;
  await page.route(publicationStatusRequest, async (route) => {
    await route.abort("failed");
  });
  await page.reload();
  const unavailableShare = page.getByRole("region", { name: "Share" });
  await expect(
    unavailableShare.getByText("Share is unavailable. Try again."),
  ).toBeVisible();
  await expect(
    unavailableShare.getByRole("button", { name: "Retry Share" }),
  ).toBeVisible();
  await page.unroute(publicationStatusRequest);
  await unavailableShare.getByRole("button", { name: "Retry Share" }).click();
  await expect(
    page
      .getByRole("region", { name: "Share" })
      .getByText("Published revision 1"),
  ).toBeVisible();

  await page.getByRole("link", { name: "View public agenda" }).click();
  await expect(
    page.getByText("A browser-built agenda", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".public-agenda-controls")
    .getByLabel("Room")
    .selectOption(secondRoom.id as string);
  await expect(
    page.getByText("A second browser session", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("A browser-built agenda", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Lunch", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "list", exact: true }).click();
  await expect(page.locator(".fc-list")).toBeVisible();
  await expect(
    page.getByText("A second browser session", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "calendar", exact: true }).click();
  await expect(page.locator(".fc-timegrid")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".fc-list")).toBeVisible();
  await page.goForward();
  await expect(page.locator(".fc-timegrid")).toBeVisible();
  await page.getByRole("button", { name: "list", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "list", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.goto(`/events/${slug}/schedule?view=calendar&start=2028-08-14`);
  await expect(page.locator(".fc-timegrid")).toBeVisible();
  await expect(
    page.locator('.fc-col-header-cell[data-date="2028-08-14"]'),
  ).toBeVisible();

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
  await page.goto(`/events/${slug}/agenda`);
  const serviceTemplate = page.getByRole("button", {
    name: /New service block/,
  });
  await serviceTemplate.focus();
  await serviceTemplate.press("Enter");
  await expect(
    inspector.getByRole("heading", { name: "New service block" }),
  ).toBeVisible();
  let invalidDraftRequests = 0;
  await page.route("**/api/trpc/agendas.updateService**", async (route) => {
    invalidDraftRequests += 1;
    await route.continue();
  });
  await inspector.getByLabel("Starts").fill("2028-08-13T11:00");
  await inspector.getByLabel("Ends").fill("2028-08-13T10:00");
  await expect(inspector.getByText("End must be after start.")).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await page.waitForTimeout(500);
  expect(invalidDraftRequests).toBe(0);
  await inspector.getByLabel("Ends").fill("2028-08-13T12:00");
  await expect(inspector.getByText("End must be after start.")).toHaveCount(0);
  await expect.poll(() => invalidDraftRequests).toBeGreaterThan(0);
  await page.unroute("**/api/trpc/agendas.updateService**");

  let failServiceSave = true;
  await page.route("**/api/trpc/agendas.updateService**", async (route) => {
    if (failServiceSave) {
      failServiceSave = false;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await inspector.getByLabel("Starts").fill("2028-08-13T10:00");
  await inspector.getByLabel("Ends").fill("2028-08-13T11:00");
  await inspector.getByRole("button", { name: "Save changes" }).click();
  await expect(inspector.getByRole("button", { name: "Retry" })).toBeVisible();
  await inspector.getByRole("button", { name: "Retry" }).click();
  await expect(inspector.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.unroute("**/api/trpc/agendas.updateService**");

  await page.goto(`/events/${slug}/agenda?item=${String(firstPlacement.id)}`);
  await inspector.getByRole("button", { name: "Return to unplaced" }).click();
  await expect(
    page.getByText("Program item returned to unplaced"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`item=${String(firstPlacement.id)}`));

  await inspector.getByRole("button", { name: "Return to unplaced" }).click();
  const unplacedPaletteItem = page.locator(".agenda-palette-item", {
    hasText: "A browser-built agenda",
  });
  await expect(unplacedPaletteItem).toBeVisible();
  const paletteBox = await unplacedPaletteItem.boundingBox();
  const dropColumn = page.locator('.fc-timegrid-col[data-date="2028-08-15"]');
  const scrollerBox = await calendarScroller.boundingBox();
  const columnBox = await dropColumn.boundingBox();
  if (!paletteBox || !scrollerBox || !columnBox) {
    throw new Error("palette drag geometry unavailable");
  }
  await page.mouse.move(
    paletteBox.x + paletteBox.width / 2,
    paletteBox.y + paletteBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    paletteBox.x + paletteBox.width / 2 + 12,
    paletteBox.y,
    { steps: 3 },
  );
  await page.mouse.move(
    columnBox.x + columnBox.width / 2,
    scrollerBox.y + scrollerBox.height / 2,
    { steps: 20 },
  );
  await page.mouse.up();
  await expect(
    page.locator(".agenda-calendar-card", {
      hasText: "A browser-built agenda",
    }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const current = await query(page.request, "agendas.working", { slug });
      const items = current.items as Array<Record<string, unknown>>;
      return items.find((item) => item.title === "A browser-built agenda")?.id;
    })
    .toBe(firstPlacement.id);
  await page.getByRole("button", { name: "Dismiss" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/events/${slug}/agenda`);
  const palette = page.locator(".agenda-palette");
  await expect
    .poll(() =>
      palette.evaluate((element) => element.getBoundingClientRect().top),
    )
    .toBeGreaterThanOrEqual(844);
  await page.getByRole("button", { name: "Add to agenda" }).click();
  await expect
    .poll(() =>
      palette.evaluate((element) => element.getBoundingClientRect().top),
    )
    .toBeLessThan(844);
  await palette.getByRole("button", { name: "Close" }).click();
  await expect
    .poll(() =>
      palette.evaluate((element) => element.getBoundingClientRect().top),
    )
    .toBeGreaterThanOrEqual(844);
  await page.getByText("A browser-built agenda", { exact: true }).click();
  await expect(inspector).toBeVisible();
  await expect
    .poll(() =>
      inspector.evaluate(
        (element) => element.getBoundingClientRect().bottom <= innerHeight,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Add to agenda" }).click();
  await expect(inspector).toHaveCount(0);
  await expect(palette).toHaveClass(/is-open/);
  await palette.getByRole("button", { name: "Close" }).click();

  await mutate(page.request, "rooms.archive", {
    slug,
    roomId: secondRoom.id,
  });
  await page.goto(`/events/${slug}/agenda?room=${String(secondRoom.id)}`);
  await expect(
    page.locator(".agenda-header-controls").getByLabel("Room"),
  ).toHaveValue(String(secondRoom.id));
  await expect(
    page
      .locator(".agenda-header-controls")
      .getByRole("option", { name: "Studio (archived)" }),
  ).toBeAttached();

  expect(
    consoleErrors.filter((message) => message.includes("flushSync")),
  ).toEqual([]);
  expect(pageErrors).toEqual([]);
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
  await expect(
    page.getByRole("button", { name: "Publish agenda" }),
  ).toBeEnabled();
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
