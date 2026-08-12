import { expect, test, type Page } from "@playwright/test";

import { requestSignInCode } from "./support";

test("saves an optional bio and uploaded headshot", async ({ page }) => {
  const suffix = `${Date.now()}`;
  const email = `browser-speaker-profile-${suffix}@example.com`;
  const slug = `browser-speaker-profile-${suffix}`;
  await page.goto("/");
  await signIn(page, email);
  await createClaimedSpeaker(page, slug, email);

  await page.goto("/speaker-profile");
  await expect(
    page.getByRole("heading", { name: "Create your profile" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Display name" })
    .fill("Browser Speaker");
  await expect(page.getByRole("textbox", { name: "Bio" })).not.toHaveAttribute(
    "required",
  );
  const saveButton = page.locator('button[type="submit"]');
  await page.getByLabel("Headshot").evaluate((input) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["not an image"], "headshot.txt", { type: "text/plain" }),
    );
    (input as HTMLInputElement).files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.getByRole("alert")).toHaveText(
    "Choose a JPEG, PNG, or WebP image under 10 MB.",
  );
  await expect(saveButton).toBeDisabled();
  await page.getByLabel("Headshot").evaluate(
    (input, contentBase64) => {
      const bytes = Uint8Array.from(atob(contentBase64), (character) =>
        character.charCodeAt(0),
      );
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([bytes], "headshot.png", { type: "image/png" }),
      );
      (input as HTMLInputElement).files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },

    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );
  await expect(
    page.getByRole("img", { name: "Headshot preview" }),
  ).toHaveAttribute("src", /^blob:/);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.evaluate(() => {
    const originalArrayBuffer = Object.getOwnPropertyDescriptor(
      File.prototype,
      "arrayBuffer",
    );
    Object.defineProperty(window, "restoreFileArrayBuffer", {
      configurable: true,
      value: () => {
        if (originalArrayBuffer) {
          Object.defineProperty(
            File.prototype,
            "arrayBuffer",
            originalArrayBuffer,
          );
        } else {
          Reflect.deleteProperty(File.prototype, "arrayBuffer");
        }
      },
    });
    Object.defineProperty(File.prototype, "arrayBuffer", {
      configurable: true,
      value: () => Promise.reject(new Error("Browser file read failed")),
    });
  });
  await saveButton.click();
  await expect(page.getByRole("alert")).toHaveText(
    "The headshot could not be read. Choose it again.",
  );
  await page.evaluate(() => {
    (
      window as unknown as Window & { restoreFileArrayBuffer: () => void }
    ).restoreFileArrayBuffer();
  });
  await page.getByLabel("Headshot").evaluate((input, contentBase64) => {
    const bytes = Uint8Array.from(atob(contentBase64), (character) =>
      character.charCodeAt(0),
    );
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([bytes], "headshot.png", { type: "image/png" }),
    );
    (input as HTMLInputElement).files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await saveButton.click();
  await expect(saveButton).toBeDisabled();
  await expect(page.getByText("Profile saved")).toBeVisible({
    timeout: 15_000,
  });
  await expect(saveButton).toBeEnabled();
  await expect(page.locator(".form-error")).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "Headshot preview" }),
  ).toHaveAttribute("src", /^\/api\/speaker-headshots\/[0-9a-f-]+$/);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Display name" })).toHaveValue(
    "Browser Speaker",
  );
  await expect(page.getByRole("textbox", { name: "Bio" })).toHaveValue("");
  await expect(
    page.getByRole("img", { name: "Headshot preview" }),
  ).toBeVisible();
});

async function signIn(page: Page, email: string) {
  const code = await requestSignInCode(page, email);
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(code);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/sign-in")),
    page.getByRole("button", { name: "Open my board" }).click(),
  ]);
}

async function createClaimedSpeaker(page: Page, slug: string, email: string) {
  await mutate(page, "events.create", {
    name: "Browser Speaker Profile Conference",
    slug,
    startsOn: "2027-08-10",
    endsOn: "2027-08-12",
    timezone: "Europe/Berlin",
  });
  const track = await mutate(page, "tracks.create", { slug, name: "Systems" });
  const cfp = await mutate(page, "cfps.createDraft", {
    slug,
    name: "Share your work",
    deadline: "2027-04-30T21:59:00Z",
    formats: ["Talk"],
    customFields: [],
  });
  await mutate(page, "cfps.open", {
    slug,
    cfpId: cfp.id,
    name: cfp.name,
    deadline: cfp.deadline,
    formats: cfp.formats,
    customFields: cfp.customFields,
  });
  await mutate(page, "submissions.submit", {
    slug,
    cfpId: cfp.id,
    clientDraftId: crypto.randomUUID(),
    title: "A browser profile proposal",
    abstract: "A proposal that grants access to the reusable speaker profile.",
    format: "Talk",
    trackId: track.id,
    proposedSpeakers: [{ name: "Browser Speaker", email }],
    customAnswers: {},
  });
}

async function mutate(
  page: Page,
  path: string,
  input: unknown,
): Promise<Record<string, unknown>> {
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
