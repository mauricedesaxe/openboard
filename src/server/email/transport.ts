import { z } from "zod";

import type { AppConfig } from "../config";
import { traceOperation } from "../observability";

type EmailConfig = Pick<AppConfig, "email">;

export type EmailContent = {
  idempotencyKey: string;
  to: string;
  subject: string;
  text: string;
  attachments?: Array<{
    filename: string;
    contentType: string;
    content: Uint8Array;
  }>;
};

export type EmailDeliveryResult = {
  providerId: string | null;
};

export function emailFailureIsRetryable(error: unknown): boolean {
  return !(error instanceof EmailDeliveryError) || error.retryable;
}

export function createEmailDeliveryError(
  message: string,
  retryable: boolean,
): Error {
  return new EmailDeliveryError(message, retryable);
}

const capturedEmails = new Map<string, EmailContent>();
const emailTimeoutMs = 15_000;

export async function sendConfiguredEmail(
  config: EmailConfig,
  message: EmailContent,
): Promise<EmailDeliveryResult> {
  return traceOperation(
    "external",
    "email.send",
    { "delivery.provider": config.email.type },
    () => sendEmail(config, message),
  );
}

async function sendEmail(
  config: EmailConfig,
  message: EmailContent,
): Promise<EmailDeliveryResult> {
  if (config.email.type === "capture") {
    capturedEmails.set(message.idempotencyKey, structuredClone(message));
    return { providerId: `capture:${message.idempotencyKey}` };
  }
  if (config.email.type === "cloudflare") {
    const attachments = message.attachments?.map((attachment) => ({
      disposition: "attachment" as const,
      filename: attachment.filename,
      type: attachment.contentType,
      content: attachment.content,
    }));
    const result = await withEmailTimeout(
      config.email.sender.send({
        from: { email: config.email.from, name: "OpenBoard" },
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(attachments ? { attachments } : {}),
      }),
    );
    return {
      providerId:
        "messageId" in result && typeof result.messageId === "string"
          ? result.messageId
          : null,
    };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.email.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": message.idempotencyKey,
    },
    signal: AbortSignal.timeout(emailTimeoutMs),
    body: JSON.stringify({
      from: `OpenBoard <${config.email.from}>`,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      attachments: message.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: bytesToBase64(attachment.content),
        content_type: attachment.contentType,
      })),
    }),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new EmailDeliveryError(
      `Resend returned ${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }
  const parsed = z.object({ id: z.string().min(1) }).safeParse(body);
  if (!parsed.success)
    throw new EmailDeliveryError("Resend returned an invalid response", false);
  return { providerId: parsed.data.id };
}

async function withEmailTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new EmailDeliveryError("Email delivery timed out", false)),
      emailTimeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(
          error instanceof Error ? error : new Error("Email delivery failed"),
        );
      },
    );
  });
}

class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function getCapturedEmails(
  config: EmailConfig,
): readonly EmailContent[] {
  return config.email.type === "capture" ? [...capturedEmails.values()] : [];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
