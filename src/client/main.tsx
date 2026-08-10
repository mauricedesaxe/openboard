import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import type { AppRouter } from "../server/trpc";

import { App } from "./App";
import { TRPCProvider } from "./trpc";
import "./styles.css";

function Root() {
  const [queryClient] = useState(() => new QueryClient());
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

createRoot(root).render(<Root />);
