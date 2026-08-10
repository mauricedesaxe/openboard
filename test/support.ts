import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";

export const testEnvironment = env as unknown as { DB: D1Database };

const worker = exports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

export type TrpcResponse<T> =
  | { result: { data: T } }
  | {
      error: {
        json: { message: string; data: { code: string; httpStatus: number } };
      };
    };

export async function signIn(
  email: string,
  ipAddress = testIpAddress(email),
): Promise<{ cookie: string; userId: string }> {
  const authHeaders = {
    "CF-Connecting-IP": ipAddress,
    "Content-Type": "application/json",
  };
  const requestCode = await workerFetch(
    "/api/auth/email-otp/send-verification-otp",
    {
      method: "POST",
      body: JSON.stringify({ email, type: "sign-in" }),
      headers: authHeaders,
    },
  );
  expect(requestCode.status).toBe(200);

  const captured = await workerFetch(
    `/api/dev/auth-code?email=${encodeURIComponent(email)}`,
  );
  expect(captured.status).toBe(200);
  const { code } = await captured.json<{ code: string }>();

  const verify = await workerFetch("/api/auth/sign-in/email-otp", {
    method: "POST",
    body: JSON.stringify({ email, otp: code }),
    headers: authHeaders,
  });
  expect(verify.status).toBe(200);

  const setCookie = verify.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  expect(setCookie).toMatch(/;\s*HttpOnly/i);
  expect(setCookie).toMatch(/;\s*SameSite=Lax/i);
  expect(setCookie).toMatch(/;\s*Secure/i);
  const cookie = setCookie?.split(";", 1)[0] ?? "";
  const user = await testEnvironment.DB.prepare(
    "SELECT id FROM user WHERE email = ?",
  )
    .bind(email)
    .first<{ id: string }>();
  expect(user).toBeTruthy();

  const reusedCode = await workerFetch("/api/auth/sign-in/email-otp", {
    method: "POST",
    body: JSON.stringify({ email, otp: code }),
    headers: authHeaders,
  });
  expect(reusedCode.status).toBe(400);

  return { cookie, userId: user?.id ?? "" };
}

function testIpAddress(email: string): string {
  const suffix =
    ([...email].reduce((sum, character) => sum + character.charCodeAt(0), 0) %
      200) +
    20;
  return `192.0.2.${suffix}`;
}

export async function callTrpc<T = unknown>(
  procedure: string,
  input: unknown,
  cookie?: string,
  type: "mutation" | "query" = "mutation",
): Promise<{ status: number; body: TrpcResponse<T> }> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (cookie) headers.set("Cookie", cookie);

  const path =
    type === "query"
      ? `/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `/api/trpc/${procedure}`;
  const response = await workerFetch(
    path,
    type === "query"
      ? { method: "GET", headers }
      : { method: "POST", headers, body: JSON.stringify(input) },
  );

  return {
    status: response.status,
    body: await response.json<TrpcResponse<T>>(),
  };
}

export function getResult<T>(response: TrpcResponse<T>): T {
  if ("error" in response) {
    throw new Error(response.error.json.message);
  }

  return response.result.data;
}

export function workerFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return worker.default.fetch(new Request(`https://localhost${path}`, init));
}
