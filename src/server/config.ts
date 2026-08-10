import { z } from "zod";

const rawConfigSchema = z.object({
  APP_ENV: z.enum(["local", "test", "preview", "production"]),
  APP_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  EMAIL_TRANSPORT: z.enum(["capture", "resend"]),
  EMAIL_FROM: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
});

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

  if (
    config.EMAIL_TRANSPORT === "resend" &&
    (!config.EMAIL_FROM || !config.RESEND_API_KEY)
  ) {
    context.addIssue({
      code: "custom",
      message: "Resend requires EMAIL_FROM and RESEND_API_KEY.",
    });
  }
});

type RawConfig = z.infer<typeof rawConfigSchema>;

export type AppConfig = {
  appEnv: RawConfig["APP_ENV"];
  appUrl: string;
  authSecret: string;
  email: { type: "capture" } | { type: "resend"; apiKey: string; from: string };
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
          : {
              type: "resend",
              apiKey: config.RESEND_API_KEY as string,
              from: config.EMAIL_FROM as string,
            },
    },
  };
}
