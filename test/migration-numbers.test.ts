import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

const migrationEnvironment = env as unknown as {
  TEST_MIGRATIONS: { name: string }[];
};

test("keeps migration numeric prefixes unique", () => {
  const prefixes = migrationEnvironment.TEST_MIGRATIONS.map(({ name }) =>
    name.slice(0, name.indexOf("_")),
  );
  const duplicates = prefixes.filter(
    (prefix, index) => prefixes.indexOf(prefix) !== index,
  );

  expect(duplicates, "migration numeric prefixes must be unique").toEqual([]);
});
