import { expect, type Page } from "@playwright/test";

export async function requestSignInCode(
  page: Page,
  email: string,
): Promise<string> {
  const addressSuffix = [...email]
    .reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0)
    .toString(16)
    .padStart(8, "0");
  await page.setExtraHTTPHeaders({
    "CF-Connecting-IP": `2001:db8:${addressSuffix.slice(0, 4)}:${addressSuffix.slice(4)}::1`,
  });
  await page.getByRole("textbox", { name: "Work email" }).fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  const code = await page.locator(".dev-code strong").textContent();
  expect(code).toMatch(/^\d{6}$/);
  return code ?? "";
}
export async function signIn(
  page: Page,
  email: string,
  buttonName: string,
): Promise<void> {
  const code = await requestSignInCode(page, email);
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(code);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/sign-in")),
    page.getByRole("button", { name: buttonName }).click(),
  ]);
  await page.waitForLoadState("networkidle");
}
