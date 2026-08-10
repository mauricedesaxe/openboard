import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";

import type { AppConfig } from "../config";
import type { Database } from "../database/client";
import { schema } from "../database/schema";

const capturedCodes = new Map<string, string>();

type AuthDependencies = {
  config: AppConfig;
  database: Database;
  executionContext: ExecutionContext;
};

export function createAuth({
  config,
  database,
  executionContext,
}: AuthDependencies) {
  return betterAuth({
    baseURL: config.appUrl,
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema,
    }),
    secret: config.authSecret,
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
      useSecureCookies: config.appUrl.startsWith("https://"),
    },
    trustedOrigins: [new URL(config.appUrl).origin],
    rateLimit: {
      enabled: true,
      max: 10,
      storage: "database",
      window: 60,
    },
    plugins: [
      emailOTP({
        allowedAttempts: 5,
        expiresIn: 300,
        storeOTP: "hashed",
        sendVerificationOTP({ email, otp, type }) {
          const delivery = sendAuthenticationCode(config, { email, otp, type });
          executionContext.waitUntil(
            delivery.catch((error: unknown) => {
              console.error(
                JSON.stringify({
                  event: "authentication_code_delivery_failed",
                  error: String(error),
                }),
              );
            }),
          );
          return Promise.resolve();
        },
      }),
    ],
  });
}

export function getCapturedAuthenticationCode(
  config: AppConfig,
  email: string,
): string | undefined {
  if (config.email.type !== "capture") {
    return undefined;
  }

  return capturedCodes.get(normalizeEmail(email));
}

async function sendAuthenticationCode(
  config: AppConfig,
  message: { email: string; otp: string; type: string },
): Promise<void> {
  if (config.email.type === "capture") {
    capturedCodes.set(normalizeEmail(message.email), message.otp);
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.email.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.email.from,
      to: [message.email],
      subject: "Your OpenBoard sign-in code",
      text: `Your OpenBoard sign-in code is ${message.otp}. It expires in five minutes.`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend returned ${response.status}.`);
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type Auth = ReturnType<typeof createAuth>;
