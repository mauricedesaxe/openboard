import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { eq } from "drizzle-orm";

import type { AppConfig } from "../config";
import type { Database } from "../database/client";
import { schema, verification } from "../database/schema";
import { sendConfiguredEmail } from "../email/transport";

const capturedCodes = new Map<string, string>();

type AuthDependencies = {
  config: AppConfig;
  database: Database;
};

export function createAuth({ config, database }: AuthDependencies) {
  let deliveryFailure: unknown;
  const auth = betterAuth({
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
      customRules: {
        "/get-session": false,
      },
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
        async sendVerificationOTP({ email, otp, type }) {
          try {
            await sendAuthenticationCode(config, { email, otp, type });
          } catch (error: unknown) {
            deliveryFailure = error;
            await database
              .delete(verification)
              .where(
                eq(
                  verification.identifier,
                  `${type}-otp-${normalizeEmail(email)}`,
                ),
              );
          }
        },
      }),
    ],
  });

  return {
    ...auth,
    async handler(request: Request): Promise<Response> {
      deliveryFailure = undefined;
      const response = await auth.handler(request);
      if (!deliveryFailure) return response;

      console.error(
        JSON.stringify({
          event: "authentication_code_delivery_failed",
          error:
            deliveryFailure instanceof Error
              ? deliveryFailure.message
              : "Unknown email delivery failure",
        }),
      );
      return Response.json(
        {
          code: "EMAIL_DELIVERY_FAILED",
          message: "The code could not be sent.",
        },
        { status: 502 },
      );
    },
  };
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

  await sendConfiguredEmail(config, {
    idempotencyKey: `authentication:${message.email}:${message.otp}`,
    to: message.email,
    subject: "Your OpenBoard sign-in code",
    text: `Your OpenBoard sign-in code is ${message.otp}. It expires in five minutes.`,
  });
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type Auth = ReturnType<typeof createAuth>;
