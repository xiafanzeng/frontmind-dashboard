import { and, eq } from "drizzle-orm";
import { Router, type Response } from "express";

import {
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
} from "../drizzle/schema";
import type { FrontMindRequest } from "./_core/express-auth";
import {
  KnowledgeArchiveValidationError,
  validateKnowledgeArchiveForDownload,
} from "./dashboard-api";
import { getDb } from "./db";
import {
  assertKnowledgeBasePackageMatchesBuild,
  KnowledgeBasePackageBindingError,
} from "./knowledge-base-package-validation";
import {
  KnowledgeBuildArtifactError,
  knowledgeBuildArtifactStorageKeyBelongsTo,
  readKnowledgeBuildArtifact,
  type KnowledgeBuildArtifactKind,
} from "./knowledge-build-artifact-store";

const router = Router();

type ArtifactBuild = Pick<
  typeof knowledgeBaseBuilds.$inferSelect,
  | "id"
  | "userId"
  | "generation"
  | "status"
  | "skillVersion"
  | "revision"
  | "logoStorageKey"
  | "logoSha256"
  | "logoBytes"
  | "logoFilename"
  | "logoMimeType"
  | "packageStorageKey"
  | "packageArchiveSha256"
  | "packageSizeBytes"
  | "packageFilename"
>;

export type KnowledgeBaseArtifactDescriptor = {
  kind: KnowledgeBuildArtifactKind;
  storageKey: string;
  sha256: string;
  bytes: number;
  filename: string;
  mimeType: string;
  disposition: "inline" | "attachment";
};

function safeDownloadFilename(value: string | null, fallback: string) {
  const basename = String(value || "")
    .normalize("NFKC")
    .replace(/[\\/\u0000-\u001f\u007f]/gu, "_")
    .trim()
    .slice(0, 180);
  return basename || fallback;
}

function safeLogoMimeType(value: string | null) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/avif",
    "image/gif",
  ].includes(normalized)
    ? normalized
    : "application/octet-stream";
}

/**
 * Resolve only metadata owned by this build generation. The deterministic
 * storage key check prevents a corrupted row from reading another build's
 * immutable artifact even when the authenticated user is the same.
 */
export function resolveKnowledgeBaseArtifactDescriptor(
  build: ArtifactBuild,
  kind: KnowledgeBuildArtifactKind,
): KnowledgeBaseArtifactDescriptor {
  if (kind === "logo") {
    if (
      !build.logoStorageKey ||
      !knowledgeBuildArtifactStorageKeyBelongsTo({
        storageKey: build.logoStorageKey,
        userId: build.userId,
        buildId: build.id,
        generation: build.generation,
        kind,
      }) ||
      !build.logoSha256 ||
      !build.logoBytes
    ) {
      throw new KnowledgeBuildArtifactError(
        "ARTIFACT_NOT_FOUND",
        "企业官方主 Logo 尚未完成持久化",
      );
    }
    return {
      kind,
      storageKey: build.logoStorageKey,
      sha256: build.logoSha256,
      bytes: build.logoBytes,
      filename: safeDownloadFilename(build.logoFilename, "official-logo"),
      mimeType: safeLogoMimeType(build.logoMimeType),
      disposition: "inline",
    };
  }

  if (
    (build.status !== "ready_to_publish" && build.status !== "published") ||
    !build.packageStorageKey ||
    !knowledgeBuildArtifactStorageKeyBelongsTo({
      storageKey: build.packageStorageKey,
      userId: build.userId,
      buildId: build.id,
      generation: build.generation,
      kind,
    }) ||
    !build.packageArchiveSha256 ||
    !build.packageSizeBytes
  ) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_NOT_FOUND",
      "知识库最终 ZIP 尚未完成持久化和校验",
    );
  }
  return {
    kind,
    storageKey: build.packageStorageKey,
    sha256: build.packageArchiveSha256,
    bytes: build.packageSizeBytes,
    filename: safeDownloadFilename(
      build.packageFilename,
      "frontmind-knowledge-base.zip",
    ),
    mimeType: "application/zip",
    disposition: "attachment",
  };
}

function sendArtifactError(res: Response, error: unknown) {
  if (error instanceof KnowledgeBuildArtifactError) {
    const status = error.code === "ARTIFACT_NOT_FOUND" ? 404 : 409;
    res.status(status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (
    error instanceof KnowledgeArchiveValidationError ||
    error instanceof KnowledgeBasePackageBindingError
  ) {
    res.status(409).json({
      error: {
        code: "ARTIFACT_INTEGRITY_MISMATCH",
        message: "知识库最终 ZIP 安全或结构复核未通过",
      },
    });
    return;
  }
  // Archive errors may contain customer filenames or decoded manifest text.
  // Keep runtime logs on the same allowlisted, content-free contract as the
  // reconcile worker; the authenticated response below remains actionable.
  console.error(
    "[KnowledgeBaseArtifact] durable_read_failed",
    JSON.stringify({ errorCode: "ARTIFACT_READ_FAILED" }),
  );
  res.status(500).json({
    error: {
      code: "ARTIFACT_READ_FAILED",
      message: "知识库资源读取失败，请稍后重试",
    },
  });
}

async function serveBuildArtifact(
  req: FrontMindRequest,
  res: Response,
  kind: KnowledgeBuildArtifactKind,
) {
  const userId = req.frontmindUser?.id;
  if (!userId) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "请先登录" },
    });
    return;
  }
  const buildId = String(req.params.buildId || "").trim();
  const db = await getDb();
  if (!db) {
    res.status(503).json({
      error: { code: "DATABASE_UNAVAILABLE", message: "数据库暂不可用" },
    });
    return;
  }

  const build = (
    await db
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, buildId),
          eq(knowledgeBaseBuilds.userId, userId),
        ),
      )
      .limit(1)
  )[0];
  if (!build) {
    res.status(404).json({
      error: { code: "BUILD_NOT_FOUND", message: "知识库构建记录不存在" },
    });
    return;
  }

  try {
    const descriptor = resolveKnowledgeBaseArtifactDescriptor(build, kind);
    const buffer = await readKnowledgeBuildArtifact({
      userId,
      buildId: build.id,
      generation: build.generation,
      kind,
      expectedSha256: descriptor.sha256,
      expectedBytes: descriptor.bytes,
      storageKey: descriptor.storageKey,
    });
    if (kind === "package") {
      const nodes = await db
        .select()
        .from(knowledgeBaseBuildNodes)
        .where(eq(knowledgeBaseBuildNodes.buildId, build.id));
      await validateKnowledgeArchiveForDownload({
        buffer,
        sourceFileName: descriptor.filename,
        expectedSha256: descriptor.sha256,
        expectedBytes: descriptor.bytes,
        validationProfile:
          build.skillVersion === "1" ? "historical" : "dashboard-enterprise-v1",
        archiveContractVersions:
          build.skillVersion === "1"
            ? undefined
            : build.skillVersion === "4"
              ? [3]
              : [2, 3],
        ...(build.skillVersion === "3" || build.skillVersion === "4"
          ? {
              validateParsed: (parsed) => {
                if (
                  build.skillVersion === "4" &&
                  parsed.packageBuildRevision !== build.revision
                ) {
                  throw new KnowledgeBuildArtifactError(
                    "ARTIFACT_INTEGRITY_MISMATCH",
                    "知识库最终 ZIP buildRevision 与已绑定版本不一致",
                  );
                }
                assertKnowledgeBasePackageMatchesBuild({
                  nodes: nodes.map((node) => ({
                    leafId: node.leafId,
                    title: node.title,
                    branchId: node.branchId,
                    branchTitle: node.branchTitle,
                    ordinal: node.ordinal,
                    status: node.status,
                    contentMarkdown: node.contentMarkdown,
                    contentSha256: node.contentSha256,
                  })),
                  documents: parsed.documents,
                  assets: parsed.assets,
                  expectedLogoSha256: String(build.logoSha256 || ""),
                  legacyV3Compatibility: build.skillVersion === "3",
                });
              },
            }
          : {}),
      });
    }
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Content-Type", descriptor.mimeType);
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("ETag", `\"sha256-${descriptor.sha256}\"`);
    res.setHeader(
      "Content-Disposition",
      `${descriptor.disposition}; filename*=UTF-8''${encodeURIComponent(
        descriptor.filename,
      )}`,
    );
    res.end(buffer);
  } catch (error) {
    sendArtifactError(res, error);
  }
}

router.get("/:buildId/logo", (req: FrontMindRequest, res) => {
  void serveBuildArtifact(req, res, "logo");
});

router.get("/:buildId/package", (req: FrontMindRequest, res) => {
  void serveBuildArtifact(req, res, "package");
});

export default router;
