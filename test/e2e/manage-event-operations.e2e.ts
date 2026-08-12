import { expect, test } from "@playwright/test";

import { signIn } from "./support";

test("moves event operations through focused routes", async ({ page }) => {
  const suffix = `${Date.now()}`;
  const slug = `browser-operations-${suffix}`;
  await page.goto("/");
  await signIn(
    page,
    `browser-operations-owner-${suffix}@example.com`,
    "Open my board",
  );
  const create = await page.request.post("/api/trpc/events.create", {
    data: {
      name: "Browser Operations Conference",
      slug,
      startsOn: "2028-08-10",
      endsOn: "2028-08-12",
      timezone: "Europe/Berlin",
    },
  });
  expect(create.ok()).toBe(true);

  await page.goto(`/events/${slug}/communications`);
  await expect(page.getByRole("link", { name: "Templates" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByRole("heading", { name: "Message templates" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Deliveries" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/events/${slug}/communications/deliveries$`),
  );
  await expect(page.getByText("Delivery is clear")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/events/${slug}/communications$`));

  await page.goto(`/events/${slug}/team`);
  await expect(
    page.getByRole("heading", {
      name: "Invite the people who move the program.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Event owner")).toBeVisible();

  await page.goto(`/events/${slug}/settings`);
  await page
    .getByRole("textbox", { name: "Event name" })
    .fill("Browser Operations Summit");
  await page.getByLabel("Timezone").selectOption("America/Toronto");
  await page.getByRole("button", { name: "Save event settings" }).click();
  await expect(page.getByText("Event settings saved")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Event name" })).toHaveValue(
    "Browser Operations Summit",
  );
  await expect(page.getByLabel("Timezone")).toHaveValue("America/Toronto");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/events/${slug}/communications/deliveries`);
  await expect(page.getByRole("link", { name: "Templates" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Deliveries" })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("link", { name: "Team" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
});
