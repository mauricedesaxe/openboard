import {
  hashKey,
  useMutationState,
  type MutationKey,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

const SUCCESS_DISMISS_MS = 4_000;

export type PendingMutation = {
  status: "idle" | "pending" | "success" | "error";
  submittedAt: number;
  error: { message: string } | null;
};

export type MutationFeedbackEntry = {
  mutation: PendingMutation;
  mutationKey: MutationKey;
  success: string;
};

export type MutationAttempt = {
  mutationKey: MutationKey;
  status: "idle" | "pending" | "success" | "error";
  submittedAt: number;
  variables: unknown;
};

export function latestMutationFeedback(
  entries: MutationFeedbackEntry[],
  submittedAfter = 0,
):
  | { id: number; status: "pending" | "success" | "error"; message?: string }
  | undefined {
  const latest = entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.mutation.submittedAt >= submittedAfter &&
        entry.mutation.status !== "idle",
    )
    .sort(
      (left, right) =>
        right.entry.mutation.submittedAt - left.entry.mutation.submittedAt ||
        right.index - left.index,
    )[0];
  if (!latest) return undefined;
  const { mutation } = latest.entry;
  if (mutation.status === "pending") {
    return { id: mutation.submittedAt, status: "pending" };
  }
  if (mutation.status === "error") {
    return {
      id: mutation.submittedAt,
      status: "error",
      message: mutation.error?.message ?? "The action could not be completed.",
    };
  }
  return {
    id: mutation.submittedAt,
    status: "success",
    message: latest.entry.success,
  };
}

export function pendingAttemptMatches(
  attempts: MutationAttempt[],
  mutationKey: MutationKey,
  key: string,
  value: unknown,
): boolean {
  const targetKey = hashKey(mutationKey);
  return attempts.some((attempt) => {
    if (
      attempt.status !== "pending" ||
      hashKey(attempt.mutationKey) !== targetKey
    ) {
      return false;
    }
    const variables = attempt.variables;
    return (
      typeof variables === "object" &&
      variables !== null &&
      key in variables &&
      (variables as Record<string, unknown>)[key] === value
    );
  });
}

export function useMutationStatuses(entries: MutationFeedbackEntry[]): {
  error?: string | undefined;
  success?: string | undefined;
  isPendingFor: (
    mutation: PendingMutation,
    key: string,
    value: unknown,
  ) => boolean;
} {
  const entryKeys = entries.map((entry) => hashKey(entry.mutationKey));
  const attempts = useMutationState<MutationAttempt>({
    filters: {
      predicate: (mutation) =>
        entryKeys.includes(hashKey(mutation.options.mutationKey ?? [])),
    },
    select: (mutation) => ({
      mutationKey: mutation.options.mutationKey ?? [],
      status: mutation.state.status,
      submittedAt: mutation.state.submittedAt,
      variables: mutation.state.variables,
    }),
  });
  const [mountedAt] = useState(Date.now);
  const latest = latestMutationFeedback(entries, mountedAt);
  const [expiredAttemptId, setExpiredAttemptId] = useState<number>();
  const dismissalTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (dismissalTimer.current !== undefined) {
      window.clearTimeout(dismissalTimer.current);
      dismissalTimer.current = undefined;
    }
    if (latest?.status === "success") {
      dismissalTimer.current = window.setTimeout(
        () => setExpiredAttemptId(latest.id),
        SUCCESS_DISMISS_MS,
      );
    }
  }, [latest]);

  useEffect(
    () => () => {
      if (dismissalTimer.current !== undefined) {
        window.clearTimeout(dismissalTimer.current);
      }
    },
    [],
  );

  return {
    error: latest?.status === "error" ? latest.message : undefined,
    success:
      latest?.status === "success" && latest.id !== expiredAttemptId
        ? latest.message
        : undefined,
    isPendingFor: (mutation, key, value) => {
      const entry = entries.find(
        (candidate) => candidate.mutation === mutation,
      );
      return entry
        ? pendingAttemptMatches(attempts, entry.mutationKey, key, value)
        : false;
    },
  };
}
