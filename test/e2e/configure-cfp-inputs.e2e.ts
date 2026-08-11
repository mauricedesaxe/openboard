import { expect, test, type Page } from "@playwright/test";

import { requestSignInCode } from "./support";

test("accepts comma-separated multi-word CFP formats and options", async ({
  page,
}) => {
  const suffix = `${Date.now()}`;
  const slug = `browser-cfp-inputs-${suffix}`;
  await page.goto("/");
  await signIn(page, `browser-cfp-owner-${suffix}@example.com`);
  await createEvent(page, slug);
  await page.goto(`/events/${slug}/cfp/setup`);

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
  await expect(page.getByRole("button", { name: "Save form" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Formats" })).toHaveValue(
    "Talk, Lightning talk",
  );
  await expect(page.getByRole("textbox", { name: "Options" })).toHaveValue(
    "First, Second choice",
  );
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
