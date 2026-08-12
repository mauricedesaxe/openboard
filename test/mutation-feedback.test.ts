import { describe, expect, it } from "vitest";

import {
  latestMutationFeedback,
  pendingAttemptMatches,
  type MutationAttempt,
  type MutationFeedbackEntry,
} from "../src/client/mutation-feedback";

const firstKey = ["first"];
const secondKey = ["second"];
const entries: MutationFeedbackEntry[] = [
  {
    mutation: mutation("idle", 0),
    mutationKey: firstKey,
    success: "First saved",
  },
  {
    mutation: mutation("idle", 0),
    mutationKey: secondKey,
    success: "Second saved",
  },
];

describe("mutation feedback", () => {
  it("reports only the latest settled action", () => {
    entries[0]!.mutation = mutation("error", 1, "First failed");
    entries[1]!.mutation = mutation("success", 2);

    expect(latestMutationFeedback(entries)).toEqual({
      id: 2,
      status: "success",
      message: "Second saved",
    });
  });

  it("clears settled feedback when a newer attempt starts", () => {
    entries[0]!.mutation = mutation("error", 1, "First failed");
    entries[1]!.mutation = mutation("pending", 2);

    expect(latestMutationFeedback(entries)).toEqual({
      id: 2,
      status: "pending",
    });
  });

  it("keeps every concurrent row pending until its call settles", () => {
    const attempts = [
      attempt(1, firstKey, "pending", { rowId: "a" }),
      attempt(2, firstKey, "pending", { rowId: "b" }),
    ];

    expect(pendingAttemptMatches(attempts, firstKey, "rowId", "a")).toBe(true);
    expect(pendingAttemptMatches(attempts, firstKey, "rowId", "b")).toBe(true);
    expect(pendingAttemptMatches(attempts, firstKey, "rowId", "c")).toBe(false);

    attempts[1] = attempt(2, firstKey, "success", { rowId: "b" });
    expect(pendingAttemptMatches(attempts, firstKey, "rowId", "a")).toBe(true);
    expect(pendingAttemptMatches(attempts, firstKey, "rowId", "b")).toBe(false);
  });
});

function attempt(
  submittedAt: number,
  mutationKey: string[],
  status: MutationAttempt["status"],
  variables?: unknown,
): MutationAttempt {
  return { mutationKey, status, submittedAt, variables };
}

function mutation(
  status: "idle" | "pending" | "success" | "error",
  submittedAt: number,
  message?: string,
) {
  return {
    status,
    submittedAt,
    error: message ? { message } : null,
  };
}
