import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

const migrationEnvironment = env as unknown as {
  TEST_MIGRATIONS: { name: string }[];
};

test("keeps the known migration number collision isolated", () => {
  const migrationsByPrefix = new Map<string, string[]>();
  for (const { name } of migrationEnvironment.TEST_MIGRATIONS) {
    const prefix = /^(\d{4})_/.exec(name)?.[1];
    if (!prefix) {
      throw new Error(`migration filename must start with NNNN_: ${name}`);
    }

    migrationsByPrefix.set(prefix, [
      ...(migrationsByPrefix.get(prefix) ?? []),
      name,
    ]);
  }

  const collisions = [...migrationsByPrefix].filter(
    ([, names]) => names.length > 1,
  );

  expect(collisions, "only the applied 0025 collision may remain").toEqual([
    [
      "0025",
      ["0025_invitation_replacement_guard.sql", "0025_speaker_onboarding.sql"],
    ],
  ]);
});
