import { expect, test } from "@playwright/test";

import { signIn } from "./support";

test("reports a problem from public and authenticated views", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ "CF-Connecting-IP": "192.0.2.250" });
  await page.goto("/sign-in");

  const reportAction = page.getByRole("button", { name: "Report a problem" });
  await expect(reportAction).toBeVisible();
  await reportAction.click();
  await page
    .getByRole("textbox", { name: "Problem description" })
    .fill("The sign-in page did not explain what happened.");
  await page.locator('input[name="website"]').evaluate((input) => {
    (input as HTMLInputElement).value = "automation";
  });
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Problem description" }),
  ).toHaveValue("The sign-in page did not explain what happened.");
  await page.locator('input[name="website"]').evaluate((input) => {
    (input as HTMLInputElement).value = "";
  });
  await page.waitForTimeout(1_000);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Thanks for the heads-up.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await signIn(
    page,
    `problem-reporter-${Date.now()}@example.com`,
    "Open my board",
  );
  await expect(reportAction).toBeVisible();
  await reportAction.click();
  await expect(
    page.getByRole("checkbox", {
      name: "The owner may contact me through my OpenBoard account.",
    }),
  ).toBeVisible();
});
