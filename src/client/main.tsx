import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import type { AppRouter } from "../server/trpc";

import { App } from "./App";
import { initializeBrowserTelemetry } from "./browser-telemetry";
import { TRPCProvider } from "./trpc";
import "./styles.css";

function Root() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: shouldRetryQuery },
        },
      }),
  );
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: "/api/trpc" })],
    }),
  );

  return (
    <StrictMode>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </TRPCProvider>
    </StrictMode>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("The application root is missing.");
}

initializeBrowserTelemetry();
createRoot(root).render(<Root />);

function shouldRetryQuery(failureCount: number, error: Error): boolean {
  const data = (error as { data?: unknown }).data;
  const httpStatus =
    typeof data === "object" &&
    data !== null &&
    "httpStatus" in data &&
    typeof data.httpStatus === "number"
      ? data.httpStatus
      : undefined;
  return failureCount < 3 && (httpStatus === undefined || httpStatus >= 500);
}
