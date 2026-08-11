import { expect, test, type Page } from "@playwright/test";

import { requestSignInCode, signIn } from "./support";

test("accepts an event invitation after sign-in without a second click", async ({
  page,
}) => {
  const suffix = `${Date.now()}`;
  const slug = `browser-invitation-${suffix}`;
  const recipientEmail = `browser-reviewer-${suffix}@example.com`;
  const acceptanceRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/trpc/invitations.accept")) {
      acceptanceRequests.push(request.url());
    }
  });
  await page.goto("/");
  await signIn(page, `browser-owner-${suffix}@example.com`, "Open my board");
  await mutate(page, "events.create", {
    name: "Browser Invitation Conference",
    slug,
    startsOn: "2027-08-10",
    endsOn: "2027-08-12",
    timezone: "Europe/Berlin",
  });
  await mutate(page, "eventTeam.invite", {
    slug,
    email: recipientEmail,
    role: "reviewer",
  });
  const secretResponse = await page.request.get(
    `/api/dev/invitation-secret?email=${encodeURIComponent(recipientEmail)}`,
  );
  expect(secretResponse.ok()).toBe(true);
  const { secret } = (await secretResponse.json()) as { secret: string };
  await page.getByRole("button", { name: "Sign out" }).click();

  await page.goto(`/invitations/${secret}`);
  await page.getByRole("link", { name: "Verify email and accept" }).click();
  const code = await requestSignInCode(page, recipientEmail);
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(code);
  await page.getByRole("button", { name: "Continue to invitation" }).click();

  await expect.poll(() => acceptanceRequests).toHaveLength(1);
  await expect(page).toHaveURL(new RegExp(`/events/${slug}$`));
  await expect(
    page.getByRole("heading", { name: "Browser Invitation Conference" }),
  ).toBeVisible();
});

async function mutate(page: Page, path: string, input: unknown) {
  const response = await page.request.post(`/api/trpc/${path}`, {
    data: input,
  });
  expect(response.ok()).toBe(true);
}
