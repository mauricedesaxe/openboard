import { expect, test, type Page } from "@playwright/test";

import { requestSignInCode } from "./support";

test("resumes a local draft and submits after sign-in", async ({ page }) => {
  const suffix = `${Date.now()}`;
  const slug = `browser-proposal-${suffix}`;
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
    .fill("Browser Submitter");
  await page
    .getByRole("textbox", { name: "Proposed speaker email" })
    .fill(`browser-speaker-${suffix}@example.com`);
  expect(
    await measureLocalTransition(page, "#audience", () =>
      page.getByRole("button", { name: "Continue" }).click(),
    ),
  ).toBeLessThan(400);
  await page.getByLabel("Audience").selectOption("Experienced");
  await page
    .getByRole("textbox", { name: "Workshop requirements" })
    .fill("Keep this answer while hidden.");
  await page.getByLabel("Audience").selectOption("Beginner");
  expect(trpcRequests).toEqual([]);

  await page.reload();
  await expect(page.getByLabel("Audience")).toHaveValue("Beginner");
  await page.getByLabel("Audience").selectOption("Experienced");
  await expect(
    page.getByRole("textbox", { name: "Workshop requirements" }),
  ).toHaveValue("Keep this answer while hidden.");
  await page.getByLabel("Audience").selectOption("Beginner");
  trpcRequests.length = 0;

  await page.getByRole("button", { name: "Sign in and submit" }).click();
  expect(
    trpcRequests.filter((url) => url.includes("submissions.submit")),
  ).toEqual([]);
  await signIn(
    page,
    `browser-submitter-${suffix}@example.com`,
    "Return to proposal",
  );

  await expect(page).toHaveURL(/\/submissions\/[0-9a-f-]+$/, {
    timeout: 15_000,
  });
  await expect(
    page.getByRole("heading", { name: "A resumed proposal" }),
  ).toBeVisible();
  expect(trpcRequests.some((url) => url.includes("submissions.submit"))).toBe(
    true,
  );
  await expect(page.getByText("Decision: pending")).toBeVisible();
  await expect(page.getByText("Confirmation: recorded")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(
    "A resumed proposal",
  );
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

async function signIn(page: Page, email: string, buttonName: string) {
  const code = await requestSignInCode(page, email);
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(code);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/sign-in")),
    page.getByRole("button", { name: buttonName }).click(),
  ]);
  await page.waitForLoadState("networkidle");
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
    ],
  });
  await mutate("cfps.open", {
    slug,
    cfpId: draft.id,
    name: draft.name,
    deadline: draft.deadline,
    formats: draft.formats,
    customFields: draft.customFields,
  });
}
