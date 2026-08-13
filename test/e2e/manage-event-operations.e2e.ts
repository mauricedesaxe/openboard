import { expect, test } from "@playwright/test";

import { signIn } from "./support";

test("moves event operations through focused routes", async ({
  browser,
  page,
}) => {
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
  const secondSlug = `browser-operations-second-${suffix}`;
  const createSecond = await page.request.post("/api/trpc/events.create", {
    data: {
      name: "Second Browser Conference",
      slug: secondSlug,
      startsOn: "2028-09-10",
      endsOn: "2028-09-12",
      timezone: "UTC",
    },
  });
  expect(createSecond.ok()).toBe(true);

  await page.goto(`/events/${slug}/communications`);
  await expect(page.getByRole("link", { name: "Templates" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByRole("heading", { name: "Message templates" }),
  ).toBeVisible();
  const firstSubject = page.getByLabel("Subject").first();
  await firstSubject.fill("Unsaved first-event template");
  await page.getByLabel("Switch active event").selectOption(secondSlug);
  await expect(page).toHaveURL(
    new RegExp(`/events/${secondSlug}/communications$`),
  );
  await expect(page.getByLabel("Subject").first()).not.toHaveValue(
    "Unsaved first-event template",
  );
  await page.getByLabel("Switch active event").selectOption(slug);
  await page.getByRole("link", { name: "Deliveries" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/events/${slug}/communications/deliveries$`),
  );
  await expect(page.getByText("Delivery is clear")).toBeVisible();
  await page.route("**/api/trpc/communications.failures**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        result: {
          data: [
            {
              communicationId: "browser-failed-delivery",
              purpose: "task_reminder",
              subject: "Speaker reminder",
              error: "Mailbox unavailable",
              status: "failed",
            },
          ],
        },
      }),
    });
  });
  await page.reload();
  await expect(page.getByText("Mailbox unavailable")).toBeVisible();
  await page.route("**/api/trpc/communications.retry**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ result: { data: true } }),
    });
  });
  await page.getByRole("button", { name: "Retry delivery" }).click();
  await expect(page.getByText("Delivery retry queued")).toBeVisible();
  await page.unroute("**/api/trpc/communications.failures**");
  await page.unroute("**/api/trpc/communications.retry**");
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/events/${slug}/communications$`));

  await page.goto(`/events/${slug}/team`);
  await expect(
    page.getByRole("heading", {
      name: "Invite the people who move the program.",
    }),
  ).toBeVisible();
  const ownerRow = page.locator(".team-row", { hasText: "Event owner" });
  await expect(ownerRow).toBeVisible();
  await expect(ownerRow.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  const ownerAccessRows = page.locator(".team-row", {
    hasText: `browser-operations-owner-${suffix}@example.com`,
  });
  await expect(ownerAccessRows).toHaveCount(3);
  await expect(
    ownerAccessRows.getByRole("button", { name: "Revoke" }),
  ).toHaveCount(0);
  await page
    .getByLabel("Email address")
    .fill(`team-member-${suffix}@example.com`);
  await page.getByLabel("Event role").selectOption("reviewer");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("The invitation was sent.")).toBeVisible();
  const pendingRow = page.locator(".team-row", {
    hasText: `team-member-${suffix}@example.com`,
  });
  await pendingRow.getByRole("button", { name: "Resend link" }).click();
  await page
    .getByRole("button", { name: "Revoke old link and resend" })
    .click();
  await expect(
    page.getByText("The old link was revoked and the replacement was sent."),
  ).toBeVisible();
  const resentRow = page.locator(".team-row", {
    hasText: `team-member-${suffix}@example.com`,
  });
  await resentRow.getByRole("button", { name: "Correct address" }).click();
  const correctedEmail = `corrected-team-member-${suffix}@example.com`;
  await page.getByLabel("Email address").fill(correctedEmail);
  await page
    .getByRole("button", { name: "Revoke old link and send correction" })
    .click();
  await expect(page.getByText(correctedEmail)).toBeVisible();

  const secretResponse = await page.request.get(
    `/api/dev/invitation-secret?email=${encodeURIComponent(correctedEmail)}`,
  );
  expect(secretResponse.ok()).toBe(true);
  const { secret } = (await secretResponse.json()) as { secret: string };
  const recipientContext = await browser.newContext();
  const recipientPage = await recipientContext.newPage();
  await recipientPage.goto("/");
  await signIn(recipientPage, correctedEmail, "Open my board");
  await recipientPage.goto(`/invitations/${secret}`);
  await recipientPage
    .getByRole("button", { name: "Accept invitation" })
    .click();
  await recipientContext.close();
  await page.reload();
  const activeMember = page.locator(".team-row", { hasText: correctedEmail });
  await activeMember.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Role revoked")).toBeVisible();

  const revokeEmail = `revoke-invitation-${suffix}@example.com`;
  await page.getByLabel("Email address").fill(revokeEmail);
  await page.getByRole("button", { name: "Send invitation" }).click();
  const revokeRow = page.locator(".team-row", { hasText: revokeEmail });
  await revokeRow.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Invitation revoked")).toBeVisible();

  await page.route("**/api/trpc/eventTeam.invite**", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    expect(replaceOutcome(body, "delivery_failed"), JSON.stringify(body)).toBe(
      true,
    );
    await route.fulfill({
      response,
      body: JSON.stringify(body),
    });
  });
  await page
    .getByLabel("Email address")
    .fill(`failed-delivery-${suffix}@example.com`);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(
    page.getByText(
      "The invitation was saved, but the email could not be sent. Send a replacement to retry.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Revoke old link and resend" }),
  ).toBeVisible();
  await page.unroute("**/api/trpc/eventTeam.invite**");

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
  await page
    .getByRole("textbox", { name: "Event name" })
    .fill("Unsaved first-event settings");
  await page.getByLabel("Switch active event").selectOption(secondSlug);
  await expect(page).toHaveURL(new RegExp(`/events/${secondSlug}/settings$`));
  await expect(page.getByRole("textbox", { name: "Event name" })).toHaveValue(
    "Second Browser Conference",
  );
  await page
    .getByRole("textbox", { name: "Event name" })
    .fill("Second Browser Summit");
  await page.getByRole("button", { name: "Save event settings" }).click();
  await expect(page.getByText("Event settings saved")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/events/${slug}/communications/deliveries`);
  await expect(page.getByRole("link", { name: "Templates" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Deliveries" })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("link", { name: "Team" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
});

function replaceOutcome(value: unknown, outcome: string): boolean {
  if (!value || typeof value !== "object") return false;
  if ("outcome" in value && value.outcome === "sent") {
    value.outcome = outcome;
    return true;
  }
  return Object.values(value).some((child) => replaceOutcome(child, outcome));
}
