import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./support";

test("manages readiness across overview, definitions, and assignments", async ({
  page,
}) => {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const slug = `browser-readiness-${suffix}`;
  await page.goto("/");
  await signIn(
    page,
    `browser-readiness-owner-${suffix}@example.com`,
    "Open my board",
  );
  await createEvent(page, slug);

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
  await expect(
    page.getByRole("heading", { name: "Reusable requirements" }),
  ).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(`/events/${slug}/readiness/task-definitions`);
  await page.goBack();
  await expect(page).toHaveURL(`/events/${slug}/readiness`);

  await page.goto(`/events/${slug}/onboarding`);
  await expect(page.getByRole("navigation", { name: "Readiness" })).toHaveCount(
    0,
  );
  await expect(page).toHaveURL(`/events/${slug}/onboarding`);
});

async function createEvent(page: Page, slug: string) {
  const response = await page.request.post("/api/trpc/events.create", {
    data: {
      name: "Browser Readiness Conference",
      slug,
      startsOn: "2028-08-10",
      endsOn: "2028-08-12",
      timezone: "Europe/Berlin",
    },
  });
  expect(response.ok()).toBe(true);
}
