import { expect, test } from "@playwright/test";

test("serves one published revision through every public output", async ({
  page,
}) => {
  const slug = "preview-schedule";

  const scheduleResponse = await page.request.get(
    `/api/v1/events/${slug}/schedule`,
    { headers: { "Accept-Encoding": "identity" } },
  );
  const calendarResponse = await page.request.get(
    `/api/v1/events/${slug}/schedule.ics`,
    { headers: { "Accept-Encoding": "identity" } },
  );
  expect(scheduleResponse.ok()).toBe(true);
  expect(calendarResponse.ok()).toBe(true);

  const schedule = (await scheduleResponse.json()) as {
    revision: number;
    items: Array<{ title: string }>;
  };
  const calendar = await calendarResponse.text();
  expect(schedule.revision).toBe(1);
  expect(schedule.items).toEqual([
    expect.objectContaining({ title: "Preview schedule check" }),
  ]);
  expect(calendar).toContain("X-OPENBOARD-REVISION:1\r\n");
  expect(calendar).toContain("SUMMARY:Preview schedule check\r\n");

  await page.goto(`/events/${slug}/schedule`);
  await expect(page.getByText("Published agenda · revision 1")).toBeVisible();
  await expect(
    page.getByText("Preview schedule check", { exact: true }),
  ).toBeVisible();
});
