import { describe, expect, test } from "vitest";

import { slugifyEventName } from "../src/shared/events";

describe("event slug derivation", () => {
  test("lowercases and joins words with single hyphens", () => {
    expect(slugifyEventName("Northstar Conference 2027")).toBe(
      "northstar-conference-2027",
    );
  });

  test("collapses runs of punctuation and trims edge hyphens", () => {
    expect(slugifyEventName("  Hello --- World!!  ")).toBe("hello-world");
  });

  test("folds accents to their ASCII base letters", () => {
    expect(slugifyEventName("Café Zürich São Paulo")).toBe(
      "cafe-zurich-sao-paulo",
    );
  });

  test("caps the slug at 48 characters without a trailing hyphen", () => {
    const slug = slugifyEventName("a".repeat(40) + " " + "b".repeat(20));
    expect(slug.length).toBe(48);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("returns an empty slug when no ASCII stem survives", () => {
    expect(slugifyEventName("🎉🎉🎉")).toBe("");
  });
});
