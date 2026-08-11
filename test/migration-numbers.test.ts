import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

const migrationEnvironment = env as unknown as {
  TEST_MIGRATIONS: { name: string }[];
};

test("keeps migration numeric prefixes unique", () => {
  const prefixes = migrationEnvironment.TEST_MIGRATIONS.map(({ name }) => {
    const match = /^(\d{4})_/.exec(name);
    if (!match) {
      throw new Error(`migration filename must start with NNNN_: ${name}`);
    }

    return match[1];
  });
  const duplicates = prefixes.filter(
    (prefix, index) => prefixes.indexOf(prefix) !== index,
  );

  expect(duplicates, "migration numeric prefixes must be unique").toEqual([]);
});
