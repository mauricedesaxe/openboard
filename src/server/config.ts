import { z } from "zod";

const commonConfigShape = {
  APP_ENV: z.enum(["local", "test", "preview", "production"]),
  APP_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTERSTACK_HEARTBEAT_URL: z.url().optional(),
  BETTERSTACK_INCIDENT_API_TOKEN: z.string().min(1).optional(),
  BETTERSTACK_INCIDENT_POLICY_ID: z.string().min(1).optional(),
  BETTERSTACK_INCIDENT_REQUESTER_EMAIL: z.email().optional(),
  VERSION: z.object({ id: z.string().min(1) }).optional(),
};

const rawConfigSchema = z.discriminatedUnion("EMAIL_TRANSPORT", [
  z.object({
    ...commonConfigShape,
    EMAIL_TRANSPORT: z.literal("capture"),
  }),
  z.object({
    ...commonConfigShape,
    EMAIL: z.custom<SendEmail>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "send" in value &&
        typeof value.send === "function",
      "Cloudflare email requires the EMAIL binding.",
    ),
    EMAIL_FROM: z.literal("auth@alexlazar.dev"),
    EMAIL_TRANSPORT: z.literal("cloudflare"),
  }),
  z.object({
    ...commonConfigShape,
    EMAIL_FROM: z.literal("auth@alexlazar.dev"),
    EMAIL_TRANSPORT: z.literal("resend"),
    RESEND_API_KEY: z.string().min(1),
  }),
]);

const configSchema = rawConfigSchema.superRefine((config, context) => {
  if (
    config.EMAIL_TRANSPORT === "capture" &&
    !["local", "test"].includes(config.APP_ENV)
  ) {
    context.addIssue({
      code: "custom",
      message: "Capture email is restricted to local and test environments.",
    });
  }

  if (
    ["preview", "production"].includes(config.APP_ENV) &&
    !config.APP_URL.startsWith("https://")
  ) {
    context.addIssue({
      code: "custom",
      message: "Preview and production require an HTTPS application URL.",
    });
  }
});

type RawConfig = z.infer<typeof rawConfigSchema>;

export type AppConfig = {
  appEnv: RawConfig["APP_ENV"];
  appUrl: string;
  authSecret: string;
  email:
    | { type: "capture" }
    | { type: "cloudflare"; from: string; sender: SendEmail }
    | { type: "resend"; from: string; apiKey: string };
  problemReports:
    | { type: "capture" }
    | { type: "unavailable" }
    | {
        type: "betterstack";
        apiToken: string;
        policyId?: string;
        requesterEmail: string;
      };
  release: string;
  scheduledWorkHeartbeat:
    { type: "disabled" } | { type: "betterstack"; url: string };
};

export type ConfigResult =
  { ok: true; value: AppConfig } | { ok: false; issues: string[] };

export function parseConfig(
  environment: Record<string, unknown>,
): ConfigResult {
  const parsed = configSchema.safeParse(environment);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => issue.message),
    };
  }

  const config = parsed.data;
  return {
    ok: true,
    value: {
      appEnv: config.APP_ENV,
      appUrl: config.APP_URL,
      authSecret: config.BETTER_AUTH_SECRET,
      email:
        config.EMAIL_TRANSPORT === "capture"
          ? { type: "capture" }
          : config.EMAIL_TRANSPORT === "cloudflare"
            ? {
                type: "cloudflare",
                from: config.EMAIL_FROM,
                sender: config.EMAIL,
              }
            : {
                type: "resend",
                from: config.EMAIL_FROM,
                apiKey: config.RESEND_API_KEY,
              },
      problemReports:
        config.APP_ENV !== "production"
          ? { type: "capture" }
          : config.BETTERSTACK_INCIDENT_API_TOKEN &&
              config.BETTERSTACK_INCIDENT_REQUESTER_EMAIL
            ? {
                type: "betterstack",
                apiToken: config.BETTERSTACK_INCIDENT_API_TOKEN,
                ...(config.BETTERSTACK_INCIDENT_POLICY_ID
                  ? { policyId: config.BETTERSTACK_INCIDENT_POLICY_ID }
                  : {}),
                requesterEmail: config.BETTERSTACK_INCIDENT_REQUESTER_EMAIL,
              }
            : { type: "unavailable" },
      release: config.VERSION?.id ?? config.APP_ENV,
      scheduledWorkHeartbeat:
        config.APP_ENV === "production" && config.BETTERSTACK_HEARTBEAT_URL
          ? {
              type: "betterstack",
              url: config.BETTERSTACK_HEARTBEAT_URL,
            }
          : { type: "disabled" },
    },
  };
}
