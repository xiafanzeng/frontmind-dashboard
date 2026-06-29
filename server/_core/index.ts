import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import manusProxy from "../manus-proxy";
import workflowApi, { cleanupStaleWorkflowUploads } from "../workflow-api";
import newsReleaseApi from "../news-release-api";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  void cleanupStaleWorkflowUploads();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // FrontMind API proxy - avoids CORS issues while keeping upstream details server-side.
  app.use("/api/frontmind", manusProxy);
  app.use("/api/manus", (_req, res) => {
    res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  });
  // Server-side workflow loader. Public manifest only; private skill content never leaves server.
  app.use("/api/workflow", workflowApi);
  // One-click homepage news release workflow. Hidden execution prompt is assembled server-side.
  app.use("/api/news-release", newsReleaseApi);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  });
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Global error handler to suppress URIError from unresolved Vite
  // environment variable placeholders (e.g. %VITE_ANALYTICS_ENDPOINT%)
  // that cause Express to crash with "Failed to decode param" errors.
  app.use((err: any, _req: any, res: any, next: any) => {
    if (err instanceof URIError) {
      // Silently ignore URI decode errors from malformed paths
      res.status(400).end();
      return;
    }
    next(err);
  });

  const preferredPort = parseInt(process.env.PORT || "3001");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${port}/`);
  });
}

startServer().catch(console.error);
