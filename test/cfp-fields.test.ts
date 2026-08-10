import { describe, expect, test } from "vitest";

import {
  nextCustomFieldKey,
  removeCustomField,
  replaceCustomField,
  type CustomField,
  visibleCustomFields,
} from "../src/shared/cfps";

describe("conditional CFP fields", () => {
  test("keeps chained fields hidden when their source becomes hidden", () => {
    const fields: CustomField[] = [
      {
        key: "audience",
        label: "Audience",
        type: "single_select",
        required: true,
        options: ["Beginner", "Experienced"],
      },
      {
        key: "format_detail",
        label: "Format detail",
        type: "single_select",
        required: true,
        options: ["Hands-on", "Lecture"],
        condition: { fieldKey: "audience", equals: "Experienced" },
      },
      {
        key: "equipment",
        label: "Equipment",
        type: "short_text",
        required: true,
        condition: { fieldKey: "format_detail", equals: "Hands-on" },
      },
    ];

    expect(
      visibleCustomFields(fields, {
        audience: "Experienced",
        format_detail: "Hands-on",
      }).map((field) => field.key),
    ).toEqual(["audience", "format_detail", "equipment"]);
    expect(
      visibleCustomFields(fields, {
        audience: "Beginner",
        format_detail: "Hands-on",
      }).map((field) => field.key),
    ).toEqual(["audience"]);
  });

  test("keeps generated keys and dependent conditions valid after edits", () => {
    const fields: CustomField[] = [
      {
        key: "question_1",
        label: "First",
        type: "single_select",
        required: false,
        options: ["Yes", "No"],
      },
      {
        key: "question_3",
        label: "Dependent",
        type: "short_text",
        required: false,
        condition: { fieldKey: "question_1", equals: "Yes" },
      },
    ];

    expect(nextCustomFieldKey(fields)).toBe("question_2");
    const renamed = replaceCustomField(fields, 0, {
      ...fields[0]!,
      key: "audience",
    });
    expect(renamed[1]?.condition?.fieldKey).toBe("audience");
    expect(removeCustomField(renamed, 0)[0]?.condition).toBeUndefined();
  });
});
