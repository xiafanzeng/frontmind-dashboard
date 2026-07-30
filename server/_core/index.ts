import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { sql } from "drizzle-orm";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import manusProxy from "../manus-proxy";
import knowledgeBaseApi, {
  getKnowledgeBaseSkillDescriptor,
  recoverOpenKnowledgeBaseTasks,
} from "../knowledge-base-api";
import responseLogicApi, {
  getResponseLogicSkillDescriptor,
} from "../response-logic-api";
import dashboardApi, {
  assertDashboardAssetStorageConfigured,
} from "../dashboard-api";
import brandQuestionPortfolioApi from "../brand-question-portfolio-api";
import { getBrandQuestionPortfolioSkillDescriptor } from "../brand-question-portfolio-runtime";
import preparedFileRouter from "../prepared-file-router";
import presalesProxy, {
  assertPresalesProxyConfigured,
} from "../presales-proxy";
import provisioningRouter, {
  assertProvisioningConfigured,
} from "../provisioning-router";
import { preparedFileService } from "../prepared-file-service";
import {
  attachOptionalActiveCredential,
  requireExpressAuth,
} from "./express-auth";
import { resolveUpstreamCredential } from "./upstream-credential";
import { enforceFrontMindProxyAccess } from "./frontmind-proxy-policy";
import { assertCredentialEncryptionConfigured } from "../auth-service";
import { getDb } from "../db";
import deliveryTicketAttachmentRouter from "../delivery-ticket-attachment-router";
import icpMaterialRouter from "../icp-material-router";
import {
  assertIcpMaterialStorageConfigured,
  startIcpMaterialRetentionScheduler,
} from "../icp-material-service";
import { startApiUsageSnapshotScheduler } from "../api-usage-snapshot-service";
import {
  assertDedicatedMonitorCredentialConfigured,
  isDedicatedMonitorCredentialConfigured,
  monitorBaseUrl,
} from "../presales-monitor";
import {
  assertFrontMindPublicUrlConfigured,
  isFrontMindPublicUrlConfigured,
} from "../public-url";
import {
  assertDashboardImportPreflightConfigured,
  startDashboardImportPreflightCleanupScheduler,
} from "../dashboard-import-preflight-service";
import websiteContentTemplateApi from "../website-content-template-api";
import { assertAdminAccessLevelsBackfilled } from "../admin-control-plane-service";
import {
  assertUpstreamBaseUrlConfigured,
  isUpstreamBaseUrlConfigured,
} from "../upstream-config";
import { createPaymentReceiptLedgerService } from "../payment-receipt-ledger-service";
import { createProjectOrderRegistryService } from "../project-order-registry-service";

const paymentReceiptLedgerReadiness = createPaymentReceiptLedgerService();
const projectOrderRegistryReadiness = createProjectOrderRegistryService();
const applicationBuildSha =
  process.env.FRONTMIND_BUILD_SHA?.trim() ||
  process.env.COMMIT_SHA?.trim() ||
  process.env.RENDER_GIT_COMMIT?.trim() ||
  null;

function assertProductionConfiguration() {
  if (process.env.NODE_ENV !== "production") return;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production");
  }
  assertCredentialEncryptionConfigured();
  assertPresalesProxyConfigured();
  assertProvisioningConfigured();
  assertIcpMaterialStorageConfigured();
  assertDedicatedMonitorCredentialConfigured();
  monitorBaseUrl();
  assertFrontMindPublicUrlConfigured();
  assertUpstreamBaseUrlConfigured();
  assertDashboardAssetStorageConfigured();
  assertDashboardImportPreflightConfigured();
}

async function getRuntimeSkillReadiness() {
  const [knowledgeBase, brandQuestions, responseLogic] = await Promise.all([
    getKnowledgeBaseSkillDescriptor(),
    getBrandQuestionPortfolioSkillDescriptor(),
    getResponseLogicSkillDescriptor(),
  ]);
  return [knowledgeBase, brandQuestions, responseLogic];
}

async function startServer() {
  assertProductionConfiguration();
  if (process.env.NODE_ENV === "production") {
    await assertAdminAccessLevelsBackfilled();
    await getRuntimeSkillReadiness();
  }
  await preparedFileService.initialize();
  const app = express();
  const server = createServer(app);
  app.disable("x-powered-by");
  // 1Panel/OpenResty is the single trusted reverse proxy in production.
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
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
  // Authenticate private service routes before the global JSON parser.
  // The legacy ICP route is retained only for historical material access;
  // new ICP material uploads return HTTP 410.
  app.use("/api/internal/presales", presalesProxy);
  app.use("/api/internal/provisioning", provisioningRouter);
  app.use("/api/icp-materials", requireExpressAuth, icpMaterialRouter);

  // JSON/form payloads keep a bounded parser.
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  app.get("/healthz", async (_req, res) => {
    try {
      assertUpstreamBaseUrlConfigured();
      monitorBaseUrl();
      const db = await getDb();
      if (!db) throw new Error("Database is not configured");
      await db.execute(sql`select 1`);
      const [preparedFiles, skills, paymentReceipts, projectOrders] =
        await Promise.all([
          preparedFileService.health(),
          getRuntimeSkillReadiness(),
          paymentReceiptLedgerReadiness.ready(),
          projectOrderRegistryReadiness.ready(),
        ]);
      res.json({
        status: "ok",
        build: {
          sha: applicationBuildSha,
        },
        configuration: {
          monitorCredentialConfigured: isDedicatedMonitorCredentialConfigured(),
          monitorApiBaseUrlConfigured: true,
          publicUrlConfigured: isFrontMindPublicUrlConfigured(),
          upstreamBaseUrlConfigured: isUpstreamBaseUrlConfigured(),
        },
        preparedFiles: {
          status: "ok",
          availableBytes: preparedFiles.availableBytes,
          queueLength: preparedFiles.queueLength,
          activeWorkers: preparedFiles.activeWorkers,
        },
        internalLedgers: {
          paymentReceipts,
          projectOrders,
        },
        skills: skills.map(({ name, version, contentHash }) => ({
          name,
          version,
          contentHash,
        })),
      });
    } catch (error) {
      console.error("[Health] Readiness check failed", error);
      res.status(503).json({ status: "unavailable" });
    }
  });

  // FrontMind API proxy - avoids CORS issues while keeping upstream details server-side.
  app.use(
    "/api/delivery-ticket-attachments",
    requireExpressAuth,
    deliveryTicketAttachmentRouter,
  );
  app.use("/api/frontmind/assets", requireExpressAuth, preparedFileRouter);
  app.use(
    "/api/frontmind",
    requireExpressAuth,
    enforceFrontMindProxyAccess,
    resolveUpstreamCredential,
    manusProxy,
  );
  app.use("/api/manus", (_req, res) => {
    res
      .status(404)
      .json({ error: { message: "Not found", code: "NOT_FOUND" } });
  });
  // One-click enterprise knowledge base workflow powered by the Socratic KB skill.
  app.use(
    "/api/knowledge-base",
    requireExpressAuth,
    attachOptionalActiveCredential,
    knowledgeBaseApi,
  );
  // Per-question response logic workflow powered by a private Skill and Pro.
  app.use(
    "/api/response-logic",
    requireExpressAuth,
    attachOptionalActiveCredential,
    responseLogicApi,
  );
  // Evidence-backed brand question candidates. Capability and quota are
  // resolved server-side before any Pro task is created.
  app.use(
    "/api/brand-question-portfolio",
    requireExpressAuth,
    attachOptionalActiveCredential,
    brandQuestionPortfolioApi,
  );
  // Durable user dashboard content and final knowledge-base snapshot imports.
  app.use("/api/dashboard", dashboardApi);
  // Revision-bound, preview-first bulk completion for the five formal website
  // content ticket categories. Domain/ICP prerequisites are not in this API.
  app.use("/api/website-content-template", websiteContentTemplateApi);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );
  app.use("/api", (_req, res) => {
    res
      .status(404)
      .json({ error: { message: "Not found", code: "NOT_FOUND" } });
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
      Number.isInteger(candidateStatus) &&
      candidateStatus >= 400 &&
      candidateStatus < 600
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

  await startApiUsageSnapshotScheduler();
  startIcpMaterialRetentionScheduler();
  startDashboardImportPreflightCleanupScheduler();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${port}/`);
    if (process.env.NODE_ENV === "production") {
      void recoverOpenKnowledgeBaseTasks()
        .then((result) => {
          console.info(
            "[KnowledgeBaseRecovery] startup_scan_complete",
            JSON.stringify(result),
          );
        })
        .catch((error) => {
          console.error("[KnowledgeBaseRecovery] startup_scan_failed", error);
        });
    }
  });
}

startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
