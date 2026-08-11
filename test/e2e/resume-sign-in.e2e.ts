import { devices, expect, test } from "@playwright/test";

import { requestSignInCode } from "./support";

test.use({ ...devices["Pixel 7"] });

test("keeps the issued sign-in code available after the browser resumes", async ({
  page,
}) => {
  const email = `mobile-resume-${Date.now()}@example.com`;
  await page.goto("/sign-in?returnTo=%2Fevents%2Fnew");
  const code = await requestSignInCode(page, email);

  const resumedSession = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/get-session") &&
      response.request().method() === "GET",
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await resumedSession;

  const codeInput = page.getByRole("textbox", { name: "Sign-in code" });
  await expect(codeInput).toBeVisible();
  await expect(
    page.getByText(`Enter the six-digit code sent to ${email}.`),
  ).toBeVisible();
  await page.reload();
  await expect(codeInput).toBeVisible();
  await expect(
    page.getByText(`Enter the six-digit code sent to ${email}.`),
  ).toBeVisible();

  await codeInput.fill(code);
  await Promise.all([
    page.waitForURL("**/events/new"),
    page.getByRole("button", { name: "Open my board" }).click(),
  ]);
});

test("keeps recovery available when a sign-in code becomes stale", async ({
  page,
}) => {
  const email = `mobile-stale-${Date.now()}@example.com`;
  await page.goto("/sign-in?returnTo=%2Fevents%2Fnew");
  const code = await requestSignInCode(page, email);
  const codeOutput = page.locator(".dev-code strong");

  await page.getByRole("button", { name: "Resend code" }).click();
  await expect(codeOutput).not.toHaveText(code);
  const replacementCode = await codeOutput.textContent();
  expect(replacementCode).toMatch(/^\d{6}$/);

  const codeInput = page.getByRole("textbox", { name: "Sign-in code" });
  await codeInput.fill(code ?? "");
  await page.getByRole("button", { name: "Open my board" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "That code is invalid or expired.",
  );
  await expect(page.getByRole("button", { name: "Resend code" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use another email" }),
  ).toBeVisible();

  await codeInput.fill(replacementCode ?? "");
  await Promise.all([
    page.waitForURL("**/events/new"),
    page.getByRole("button", { name: "Open my board" }).click(),
  ]);
});
