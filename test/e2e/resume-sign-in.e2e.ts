import { devices, expect, test } from "@playwright/test";

test.use({ ...devices["Pixel 7"] });

test("keeps the issued sign-in code available after the browser resumes", async ({
  page,
}) => {
  const email = `mobile-resume-${Date.now()}@example.com`;
  await page.setExtraHTTPHeaders({
    "CF-Connecting-IP": "2001:db8:42::1",
  });
  await page.goto("/sign-in?returnTo=%2Fevents%2Fnew");
  await page.getByRole("textbox", { name: "Work email" }).fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  const code = await page.locator(".dev-code strong").textContent();
  expect(code).toMatch(/^\d{6}$/);

  const resumedSession = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/get-session") &&
      response.request().method() === "GET",
  );
  await page.evaluate(() => {
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

  const invalidCode = `${code?.startsWith("0") ? "1" : "0"}${code?.slice(1)}`;
  await codeInput.fill(invalidCode);
  await page.getByRole("button", { name: "Open my board" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "That code is invalid or expired.",
  );
  await expect(page.getByRole("button", { name: "Resend code" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use another email" }),
  ).toBeVisible();

  await codeInput.fill(code ?? "");
  await Promise.all([
    page.waitForURL("**/events/new"),
    page.getByRole("button", { name: "Open my board" }).click(),
  ]);
});
