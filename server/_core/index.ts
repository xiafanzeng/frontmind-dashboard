import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { sql } from "drizzle-orm";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import manusProxy from "../manus-proxy";
import workflowApi, { cleanupStaleWorkflowUploads } from "../workflow-api";
import newsReleaseApi from "../news-release-api";
import knowledgeBaseApi from "../knowledge-base-api";
import preparedFileRouter from "../prepared-file-router";
import { preparedFileService } from "../prepared-file-service";
import {
  attachOptionalActiveCredential,
  requireExpressAuth,
} from "./express-auth";
import { resolveUpstreamCredential } from "./upstream-credential";
import { assertCredentialEncryptionConfigured } from "../auth-service";
import { getDb } from "../db";

function assertProductionConfiguration() {
  if (process.env.NODE_ENV !== "production") return;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production");
  }
  assertCredentialEncryptionConfigured();
}

async function startServer() {
  assertProductionConfiguration();
  await preparedFileService.initialize();
  const app = express();
  const server = createServer(app);
  void cleanupStaleWorkflowUploads();
  app.disable("x-powered-by");
  // 1Panel/OpenResty is the single trusted reverse proxy in production.
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      "object-src 'none'; worker-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
    if (process.env.NODE_ENV === "production") {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    next();
  });
  // JSON/form payloads keep a bounded parser. Binary upload routes use the raw
  // request stream and are not subject to this application-body limit.
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  app.get("/healthz", async (_req, res) => {
    try {
      const db = await getDb();
      if (!db) throw new Error("Database is not configured");
      await db.execute(sql`select 1`);
      const preparedFiles = await preparedFileService.health();
      res.json({
        status: "ok",
        preparedFiles: {
          status: "ok",
          availableBytes: preparedFiles.availableBytes,
          queueLength: preparedFiles.queueLength,
          activeWorkers: preparedFiles.activeWorkers,
        },
      });
    } catch (error) {
      console.error("[Health] Database readiness check failed", error);
      res.status(503).json({ status: "unavailable" });
    }
  });

  // FrontMind API proxy - avoids CORS issues while keeping upstream details server-side.
  app.use(
    "/api/frontmind/assets",
    requireExpressAuth,
    preparedFileRouter,
  );
  app.use(
    "/api/frontmind",
    requireExpressAuth,
    resolveUpstreamCredential,
    manusProxy,
  );
  app.use("/api/manus", (_req, res) => {
    res.status(404).json({ error: { message: "Not found", code: "NOT_FOUND" } });
  });
  // Server-side workflow loader. Public manifest only; private skill content never leaves server.
  app.use(
    "/api/workflow",
    requireExpressAuth,
    attachOptionalActiveCredential,
    workflowApi,
  );
  // One-click homepage news release workflow. Hidden execution prompt is assembled server-side.
  app.use(
    "/api/news-release",
    requireExpressAuth,
    resolveUpstreamCredential,
    newsReleaseApi,
  );
  // One-click enterprise knowledge base workflow powered by the Socratic KB skill.
  app.use(
    "/api/knowledge-base",
    requireExpressAuth,
    resolveUpstreamCredential,
    knowledgeBaseApi,
  );
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

  // Return a controlled response for malformed percent-encoded request paths.
  app.use((err: any, _req: any, res: any, next: any) => {
    if (err instanceof URIError) {
      // Silently ignore URI decode errors from malformed paths
      res.status(400).end();
      return;
    }
    console.error("[HTTP] Unhandled request error", err);
    if (res.headersSent) {
      next(err);
      return;
    }
    const candidateStatus = Number(err?.status ?? err?.statusCode);
    const status =
      Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 600
        ? candidateStatus
        : 500;
    res.status(status).json({
      error: {
        message: status === 413 ? "请求内容过大" : "服务器暂时无法完成请求",
        code: status === 413 ? "PAYLOAD_TOO_LARGE" : "INTERNAL_SERVER_ERROR",
      },
    });
  });

  const port = Number.parseInt(process.env.PORT || "3001", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${port}/`);
  });
}

startServer().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
