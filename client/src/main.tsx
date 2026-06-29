import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient();

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

// ============================================================
// Version check on focus (Stale-While-Revalidate pattern)
//
// Instead of polling every N seconds, we only check for a new
// deployment when the user switches back to this tab. This is
// the same strategy used by Vercel / Next.js in production:
//   - Zero background requests while the user is active or away
//   - One lightweight check (~100 bytes) when the tab regains focus
//   - Automatic reload only when a genuinely new version is detected
// ============================================================
let initialVersion: string | null = null;

async function checkVersion() {
  try {
    const res = await fetch(`/__frontmind__/version.json?_t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const data = await res.json();
    const version = data.version as string;

    if (initialVersion === null) {
      // First load — record the current version
      initialVersion = version;
      console.log(`[VersionCheck] Initial version: ${version}`);
    } else if (version !== initialVersion) {
      // New version detected — reload to pick up new assets
      console.log(
        `[VersionCheck] New version detected: ${version} (was ${initialVersion}). Reloading...`
      );
      window.location.reload();
    }
  } catch {
    // Silently ignore fetch errors (offline, server down, etc.)
  }
}

// Record the initial version on first load
checkVersion();

// Re-check when the user switches back to this tab
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    checkVersion();
  }
});

// Also check on window focus (covers some edge cases not caught by visibilitychange)
window.addEventListener("focus", () => {
  checkVersion();
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
