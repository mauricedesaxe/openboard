import { expect, test, type Page } from "@playwright/test";

import { completeSignIn, signIn } from "./support";

test.setTimeout(60_000);

test("resumes a local draft and submits after sign-in", async ({ page }) => {
  const suffix = `${Date.now()}`;
  const slug = `browser-proposal-${suffix}`;
  const proposedSpeakerEmail = `browser-speaker-${suffix}@example.com`;
  await page.goto("/");
  await signIn(page, `browser-owner-${suffix}@example.com`, "Open my board");
  await createOpenCfp(page, slug);
  await page.getByRole("button", { name: "Sign out" }).click();

  const trpcRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/trpc/")) {
      trpcRequests.push(request.url());
    }
  });
  await page.goto(`/events/${slug}/cfp`);
  await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
  await expect(
    page.getByText(
      "Summarize what you will cover and what attendees will learn.",
      { exact: true },
    ),
  ).toBeVisible();
  trpcRequests.length = 0;

  await page.getByRole("textbox", { name: "Title" }).fill("A resumed proposal");
  await page
    .getByRole("textbox", { name: "Abstract" })
    .fill("This browser workflow keeps every local answer through sign-in.");
  await page.getByLabel("Format").selectOption("Talk");
  await page.getByLabel("Track").selectOption({ label: "Web systems" });
  expect(
    await measureLocalTransition(page, "#speaker-name", () =>
      page.getByRole("button", { name: "Continue" }).click(),
    ),
  ).toBeLessThan(400);
  expect(trpcRequests).toEqual([]);

  await page
    .getByRole("textbox", { name: "Proposed speaker name" })
    .fill("Browser Submission Owner");
  await page
    .getByRole("textbox", { name: "Proposed speaker email" })
    .fill(proposedSpeakerEmail);
  expect(
    await measureLocalTransition(page, "#audience", () =>
      page.getByRole("button", { name: "Continue" }).click(),
    ),
  ).toBeLessThan(400);
  await page.getByLabel("Audience").selectOption("Experienced");
  await expect(page.getByText("application/pdf · Up to 1 MB")).toBeVisible();
  await page
    .getByRole("textbox", { name: "Workshop requirements" })
    .fill("Keep this answer while hidden.");
  await page.getByRole("button", { name: "Sign in and submit" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Choose a file for Session outline." }),
  ).toBeVisible();
  await page
    .getByLabel("Session outline")
    .setInputFiles("test/fixtures/outline.pdf");
  await page.getByLabel("Audience").selectOption("Beginner");
  expect(trpcRequests).toEqual([]);

  await page.reload();
  await expect(page.getByLabel("Audience")).toHaveValue("Beginner");
  await page.getByLabel("Audience").selectOption("Experienced");
  await expect(
    page.getByRole("textbox", { name: "Workshop requirements" }),
  ).toHaveValue("Keep this answer while hidden.");
  await expect(page.getByText("outline.pdf")).toBeVisible();
  await page.getByLabel("Audience").selectOption("Beginner");
  trpcRequests.length = 0;

  await page.getByRole("button", { name: "Sign in and submit" }).click();
  expect(
    trpcRequests.filter((url) => url.includes("submissions.submit")),
  ).toEqual([]);
  await expect(
    page.getByText(`Enter the six-digit code sent to ${proposedSpeakerEmail}.`),
  ).toBeVisible();
  await completeSignIn(page, "Return to proposal");

  await expect(page).toHaveURL(/\/submissions\/[0-9a-f-]+$/, {
    timeout: 15_000,
  });
  await expect(
    page.getByRole("heading", { name: "A resumed proposal" }),
  ).toBeVisible();
  expect(trpcRequests.some((url) => url.includes("submissions.submit"))).toBe(
    true,
  );
  expect(
    trpcRequests.flatMap((url) => url.match(/submissions\.submit/g) ?? []),
  ).toHaveLength(1);
  await expect(page.getByText("Decision: pending")).toBeVisible();
  await expect(page.getByText("Confirmation: recorded")).toBeVisible();
  const proposalUrl = page.url();
  const eventNavigation = page.getByRole("navigation", {
    name: "Browser Proposal Conference navigation",
  });
  await expect(eventNavigation).toBeVisible();
  await expect(
    eventNavigation.getByRole("link", { name: "Proposal" }),
  ).toBeVisible();
  await expect(eventNavigation.getByRole("link")).toHaveText(["Proposal"]);

  await page.goto("/");
  const emptyEvents = page.locator(".empty-board");
  const proposals = page.locator(".owned-submissions");
  await expect(emptyEvents).toContainText("No events yet");
  await expect(proposals).toContainText("Your proposals");
  await expect(proposals).toContainText("A resumed proposal");
  await expectSecondSectionBelowFirst(emptyEvents, proposals);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(emptyEvents).toBeVisible();
  await expect(proposals).toBeVisible();
  await expectSecondSectionBelowFirst(emptyEvents, proposals);

  await page.goto(proposalUrl);
  await expect(eventNavigation).toBeVisible();
  await page.getByRole("link", { name: "My events" }).click();
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("heading", { name: "The program starts here." }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(proposalUrl);
  await expect(eventNavigation).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(
    "A resumed proposal",
  );
  await expect(
    page.getByText(
      "Summarize what you will cover and what attendees will learn.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Title" }).fill("An edited proposal");
  await page.getByRole("button", { name: "Save proposal" }).click();
  await expect(page.getByText("Proposal saved")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(
    "An edited proposal",
  );
  const onlyRemoveButton = page.getByRole("button", { name: "Remove" });
  await expect(onlyRemoveButton).toBeDisabled();
  await expect(onlyRemoveButton).toHaveAccessibleDescription(
    "At least one proposed speaker must remain.",
  );
  await expect(
    page.getByText("At least one proposed speaker must remain."),
  ).toBeVisible();

  await page
    .getByRole("textbox", { name: "Proposed speaker name" })
    .fill("Second Browser Speaker");
  await page
    .getByRole("textbox", { name: "Proposed speaker email" })
    .fill(`second-browser-speaker-${suffix}@example.com`);
  await page.getByRole("button", { name: "Invite proposed speaker" }).click();
  await expect(page.getByText("Second Browser Speaker")).toBeVisible();

  await page
    .getByRole("textbox", { name: "Proposed speaker name" })
    .fill("Third Browser Speaker");
  await page
    .getByRole("textbox", { name: "Proposed speaker email" })
    .fill(`third-browser-speaker-${suffix}@example.com`);
  await page.getByRole("button", { name: "Invite proposed speaker" }).click();
  await expect(page.getByText("Third Browser Speaker")).toBeVisible();

  const signedInProposedSpeakerRow = page
    .locator(".speaker-row")
    .filter({ hasText: "Browser Submission Owner" });
  const secondSpeakerRow = page
    .locator(".speaker-row")
    .filter({ hasText: "Second Browser Speaker" });
  const removeSpeakerRequestPattern =
    /\/api\/trpc\/submissions\.removeSpeaker(?:\?|$)/;
  let removalRequestsStarted = 0;
  let releaseSuccessfulRemoval = () => {};
  let releaseFailedRemoval = () => {};
  const holdSuccessfulRemoval = new Promise<void>((resolve) => {
    releaseSuccessfulRemoval = resolve;
  });
  const holdFailedRemoval = new Promise<void>((resolve) => {
    releaseFailedRemoval = resolve;
  });
  await page.route(removeSpeakerRequestPattern, async (route) => {
    removalRequestsStarted += 1;
    if (removalRequestsStarted === 1) {
      await holdFailedRemoval;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Removal failed" } }),
      });
      return;
    }
    await holdSuccessfulRemoval;
    await route.continue();
  });
  await signedInProposedSpeakerRow
    .getByRole("button", { name: "Remove" })
    .click();
  await secondSpeakerRow.getByRole("button", { name: "Remove" }).click();
  await expect(
    signedInProposedSpeakerRow.getByRole("button", { name: "Removing…" }),
  ).toBeDisabled();
  await expect(
    secondSpeakerRow.getByRole("button", { name: "Removing…" }),
  ).toBeDisabled();
  await expect.poll(() => removalRequestsStarted).toBe(2);

  const successfulRemovalResponse = page.waitForResponse(
    removeSpeakerRequestPattern,
  );
  releaseSuccessfulRemoval();
  expect((await successfulRemovalResponse).ok()).toBe(true);
  await expect(secondSpeakerRow).toBeHidden();
  await expect(
    signedInProposedSpeakerRow.getByRole("button", { name: "Removing…" }),
  ).toBeDisabled();
  await expect(page.getByText("Third Browser Speaker")).toBeVisible();

  releaseFailedRemoval();
  await expect(
    signedInProposedSpeakerRow.getByRole("button", { name: "Remove" }),
  ).toBeVisible();
  await expect(secondSpeakerRow).toBeHidden();
  await expect(page.getByText("Third Browser Speaker")).toBeVisible();

  await page.getByRole("button", { name: "Withdraw proposal" }).click();
  await expect(page.getByText("Proposal withdrawn")).toBeVisible();
  await expect(page.getByText("withdrawn", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Title" })).toBeDisabled();
});

test("submits a proposal whose file was picked without a reload", async ({
  page,
}) => {
  const suffix = `${Date.now()}`;
  const slug = `browser-fresh-file-${suffix}`;
  const proposedSpeakerEmail = `browser-speaker-${suffix}@example.com`;
  await page.goto("/");
  await signIn(page, `browser-owner-${suffix}@example.com`, "Open my board");
  await createOpenCfp(page, slug);
  await page.getByRole("button", { name: "Sign out" }).click();

  await page.goto(`/events/${slug}/cfp`);
  await page.getByRole("textbox", { name: "Title" }).fill("A fresh file");
  await page
    .getByRole("textbox", { name: "Abstract" })
    .fill("This proposal submits a file picked moments before signing in.");
  await page.getByLabel("Format").selectOption("Talk");
  await page.getByLabel("Track").selectOption({ label: "Web systems" });
  await page.getByRole("button", { name: "Continue" }).click();
  await page
    .getByRole("textbox", { name: "Proposed speaker name" })
    .fill("Fresh File Submitter");
  await page
    .getByRole("textbox", { name: "Proposed speaker email" })
    .fill(proposedSpeakerEmail);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Audience").selectOption("Experienced");
  await page
    .getByRole("textbox", { name: "Workshop requirements" })
    .fill("A whiteboard and sticky notes.");
  await page
    .getByLabel("Session outline")
    .setInputFiles("test/fixtures/outline.pdf");
  await expect(page.getByText("outline.pdf")).toBeVisible();

  await page.getByRole("button", { name: "Sign in and submit" }).click();
  await expect(
    page.getByText(`Enter the six-digit code sent to ${proposedSpeakerEmail}.`),
  ).toBeVisible();
  await completeSignIn(page, "Return to proposal");

  await expect(page).toHaveURL(/\/submissions\/[0-9a-f-]+$/, {
    timeout: 15_000,
  });
  await expect(
    page.getByRole("heading", { name: "A fresh file" }),
  ).toBeVisible();
  await expect(page.getByText("outline.pdf")).toBeVisible();
});

async function measureLocalTransition(
  page: Page,
  selector: string,
  transition: () => Promise<void>,
): Promise<number> {
  await page.evaluate((nextSelector) => {
    delete document.body.dataset.transitionDuration;
    let startedAt: number | undefined;
    document.addEventListener(
      "click",
      () => {
        startedAt = performance.now();
      },
      { capture: true, once: true },
    );
    const observer = new MutationObserver(() => {
      if (startedAt === undefined || !document.querySelector(nextSelector)) {
        return;
      }
      document.body.dataset.transitionDuration = String(
        performance.now() - startedAt,
      );
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, selector);
  await transition();
  await page.waitForSelector(selector);
  return page.evaluate(() => Number(document.body.dataset.transitionDuration));
}

async function expectSecondSectionBelowFirst(
  upperSection: ReturnType<Page["locator"]>,
  lowerSection: ReturnType<Page["locator"]>,
) {
  const upperBox = await upperSection.boundingBox();
  const lowerBox = await lowerSection.boundingBox();
  expect(upperBox).not.toBeNull();
  expect(lowerBox).not.toBeNull();
  expect(lowerBox!.y).toBeGreaterThan(upperBox!.y + upperBox!.height);
}

async function createOpenCfp(page: Page, slug: string) {
  async function mutate(path: string, input: unknown) {
    const response = await page.request.post(`/api/trpc/${path}`, {
      data: input,
    });
    const body = (await response.json()) as {
      result?: { data: Record<string, unknown> };
    };
    if (!response.ok() || !body.result) {
      throw new Error(`${path} failed with ${response.status()}`);
    }
    return body.result.data;
  }

  await mutate("events.create", {
    name: "Browser Proposal Conference",
    slug,
    startsOn: "2027-08-10",
    endsOn: "2027-08-12",
    timezone: "Europe/Berlin",
  });
  await mutate("tracks.create", { slug, name: "Web systems" });
  const draft = await mutate("cfps.createDraft", {
    slug,
    name: "Share your browser story",
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
        key: "outline",
        label: "Session outline",
        type: "file",
        required: true,
        acceptedTypes: ["application/pdf"],
        maxSizeMb: 1,
        condition: { fieldKey: "audience", equals: "Experienced" },
      },
    ],
  });
  await mutate("cfps.open", {
    slug,
    cfpId: draft.id,
    expectedDeadline: draft.deadline,
    name: draft.name,
    deadline: draft.deadline,
    formats: draft.formats,
    customFields: draft.customFields,
  });
}
