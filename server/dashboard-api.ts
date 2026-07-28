import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import express from "express";
import JSZip from "jszip";
import { z } from "zod";

import { userDashboardContents } from "../drizzle/schema";
import {
  dashboardContentAssetSchema,
  dashboardAdminImportModuleSchema,
  dashboardMonitoringCurrentTemplateSchema,
  dashboardMetricSchema,
  dashboardModuleImportPreviewSchema,
  dashboardModuleTemplateMetadataSchema,
  dashboardMonitoringAnswerSchema,
  dashboardOptimizationReportSchema,
  dashboardOptimizationReportTemplateSchema,
  dashboardQuestionsTemplateSchema,
  createDashboardModuleTemplateMetadata,
  createDefaultDashboardPayload,
  dashboardPayloadSchema,
  dashboardQuestionSchema,
  dashboardSectionSchema,
  dashboardTableSchema,
  dashboardCitationRecordSchema,
  type DashboardAdminImportModule,
  type DashboardModuleImportPreview,
  type DashboardPayload,
  type KnowledgeAsset,
  type KnowledgeDocument,
} from "../shared/dashboard";
import {
  replaceMonitoringBatchSchema,
  type ReplaceMonitoringBatchInput,
} from "../shared/monitoring";
import {
  responseLogicDraftSchema,
  saveResponseLogicSchema,
  type SaveResponseLogicInput,
} from "../shared/response-logic";
import type { FrontMindRequest } from "./_core/express-auth";
import { requireExpressAuth } from "./_core/express-auth";
import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import {
  getCredentialForUpstreamResource,
  type AuthenticatedUser,
} from "./auth-service";
import {
  assertDashboardEnterpriseIdentity,
  assertWorkspaceAccess,
  createKnowledgeSnapshot,
  DashboardEnterpriseMismatchError,
  DashboardRevisionConflictError,
  getDashboardWorkspace,
  getKnowledgeAsset,
  updateDashboardWorkspace,
  type DashboardWorkspaceWriteHook,
} from "./dashboard-service";
import {
  collectKnowledgeArchiveDescriptors,
  knowledgeArchiveDescriptorHash,
  knowledgeArchiveFileIdFromUrl,
  type KnowledgeArchiveDescriptor,
} from "./knowledge-base-artifact";
import { assertKnowledgeBasePublishable } from "./knowledge-base-progress-service";
import {
  assertServiceCapability,
  ServiceEntitlementError,
  updateWorkspaceQuestionsByAdminBatch,
} from "./service-entitlement";
import {
  getMonitoringFilterOptions,
  getMonitoringCurrentTemplateBatches,
  mergeQuestionOnlyCitationsIntoMonitoringBatch,
  monitoringBeijingDate,
  monitoringModelKey,
  replaceMonitoringBatch,
  replaceMonitoringCurrentTemplateBatches,
} from "./monitoring-service";
import {
  assertResponseLogicDraftPublishable,
  listResponseLogicEntries,
  ResponseLogicRevisionConflictError,
  saveResponseLogicEntriesBatch,
} from "./response-logic-service";
import { getUpstreamBaseUrl } from "./upstream-config";
import { writeWorkspaceAuditEvent } from "./admin-control-plane-service";
import {
  consumeDashboardImportPreflight,
  dashboardImportPreflightStoreForExecutor,
  DashboardImportPreflightError,
  issueDashboardImportPreflight,
} from "./dashboard-import-preflight-service";

const router = express.Router();
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 220 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;

class MonitoringTargetBatchRequiredError extends Error {
  readonly code = "MONITORING_TARGET_BATCH_REQUIRED";
  readonly statusCode = 409;

  constructor() {
    super(
      "该文件只有问题级引用。请先预检并选择一个包含答案明细的目标监控批次。",
    );
  }
}

class MonitoringPreviewRequiredError extends Error {
  readonly code = "MONITORING_PREVIEW_REQUIRED";
  readonly statusCode = 409;

  constructor() {
    super("问题监控文件必须先完成预检，再使用预检返回的文件哈希发布。");
  }
}

class MonitoringFileChangedError extends Error {
  readonly code = "MONITORING_FILE_CHANGED";
  readonly statusCode = 409;

  constructor() {
    super("文件内容已发生变化，请重新预检后再发布。");
  }
}

class DashboardImportPreviewRequiredError extends Error {
  readonly code = "DASHBOARD_IMPORT_PREVIEW_REQUIRED";
  readonly statusCode = 409;

  constructor() {
    super("该模块文件必须先完成预检，再使用预检返回的文件哈希发布。");
  }
}

class DashboardImportFileChangedError extends Error {
  readonly code = "DASHBOARD_IMPORT_FILE_CHANGED";
  readonly statusCode = 409;

  constructor() {
    super("模块文件内容已发生变化，请重新预检后再发布。");
  }
}

class DashboardTemplateRevisionError extends Error {
  readonly code = "DASHBOARD_TEMPLATE_REVISION_CONFLICT";
  readonly statusCode = 409;

  constructor(message = "模板已过期，请下载当前内容模板后重新编辑。") {
    super(message);
  }
}
const requiredKnowledgeFiles = [
  "README.md",
  "00_knowledge_tree.md",
  "00_crawl_coverage_report.md",
  "00_web_intelligence_report.md",
  "00_source_index.md",
  "09_media_assets/asset_inventory.md",
  "10_reference_assets/reference_asset_inventory.md",
] as const;
const storageRoot = path.resolve(
  process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
    path.join(process.cwd(), ".frontmind-dashboard-assets"),
);

export function assertDashboardAssetStorageConfigured() {
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.FRONTMIND_DASHBOARD_ASSET_DIR?.trim()
  ) {
    throw new Error(
      "FRONTMIND_DASHBOARD_ASSET_DIR is required in production for durable dashboard assets",
    );
  }
}

export async function removeStoredKnowledgeAssets(keys: string[]) {
  await Promise.all(
    keys.map((key) =>
      unlink(path.join(storageRoot, key)).catch(() => undefined),
    ),
  );
}

const textExtensions = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".csv",
  ".html",
  ".htm",
]);
const imageMimeByExtension: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

function decodeHeader(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  try {
    return decodeURIComponent(value).slice(0, 512);
  } catch {
    return value.slice(0, 512);
  }
}

function dashboardRevisionHeader(value: string | undefined) {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("看板版本号无效，请刷新后重试");
  }
  return Number(value);
}

function safeArchivePath(value: string) {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .slice(0, 512);
}

function validateArchiveEntryPath(value: string) {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-z]:/i.test(value)
  ) {
    throw new Error("知识库 ZIP 包含不安全的文件路径");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("知识库 ZIP 包含不安全的文件路径");
  }
  const normalized = parts.join("/");
  if (normalized.length > 512) {
    throw new Error("知识库 ZIP 中的文件路径过长");
  }
  return normalized;
}

function isSupportedImageBytes(extension: string, bytes: Buffer) {
  if (extension === ".png") {
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (extension === ".gif") {
    return ["GIF87a", "GIF89a"].includes(
      bytes.subarray(0, 6).toString("ascii"),
    );
  }
  if (extension === ".webp") {
    return (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  if (extension === ".avif") {
    return (
      bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
      bytes.subarray(8, 32).includes(Buffer.from("avif"))
    );
  }
  return false;
}

export function validateProgressReportScreenshot(input: {
  filename: string;
  bytes: Buffer;
}) {
  const extension = path.extname(input.filename).toLowerCase();
  const mimeType = imageMimeByExtension[extension];
  if (!mimeType || ![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    throw new Error("答案截图仅支持 PNG、JPG 或 WEBP");
  }
  if (!isSupportedImageBytes(extension, input.bytes)) {
    throw new Error("答案截图内容与文件扩展名不一致");
  }
  return { extension, mimeType };
}

function titleFromPath(filePath: string) {
  return (
    path
      .basename(filePath, path.extname(filePath))
      .replace(/^\d+[._-]*/, "")
      .replace(/[-_]+/g, " ")
      .trim() || "知识文档"
  );
}

function htmlToMarkdownLikeText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n")
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n")
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n")
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTextDocument(filePath: string, content: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html" || extension === ".htm") {
    return htmlToMarkdownLikeText(content);
  }
  if (extension === ".json") {
    try {
      return `\`\`\`json\n${JSON.stringify(JSON.parse(content), null, 2)}\n\`\`\``;
    } catch {
      return content;
    }
  }
  return content.replace(/^\uFEFF/, "").trim();
}

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function optionalCsvNumber(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function csvStringList(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return [];
  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch {
    // Pipe-separated cells are easier to author in a spreadsheet.
  }
  return normalized
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function dashboardFromCsv(text: string, displayName: string) {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("CSV 至少需要表头和一行内容");
  const headers = rows[0]!.map((header) => header.toLowerCase());
  const records = rows
    .slice(1)
    .map((values) =>
      Object.fromEntries(
        headers.map((header, index) => [header, values[index] || ""]),
      ),
    );
  const payload = createDefaultDashboardPayload(displayName);
  const brand = records.find((record) => record.type === "brand");
  if (brand?.value || brand?.title)
    payload.brandName = brand.value || brand.title;
  const headline = records.find((record) => record.type === "headline");
  if (headline?.value || headline?.title) {
    payload.headline = headline.value || headline.title;
  }
  const summary = records.find((record) => record.type === "summary");
  if (summary?.value || summary?.description) {
    payload.summary = summary.value || summary.description;
  }
  payload.metrics = records
    .filter((record) => record.type === "metric")
    .map((record) => ({
      label: record.title || record.label || "指标",
      value: record.value || "-",
      unit: record.unit || undefined,
      note: record.note || undefined,
    }));
  const sectionIds = [
    ...new Set(
      records
        .filter((record) =>
          ["section", "item", "table", "table_row"].includes(record.type),
        )
        .map((record) => record.section || "overview"),
    ),
  ];
  payload.sections = sectionIds.map((sectionId) => {
    const sectionRecord = records.find(
      (record) =>
        record.type === "section" &&
        (record.section || "overview") === sectionId,
    );
    const tables = records
      .filter(
        (record) =>
          record.type === "table" &&
          (record.section || "overview") === sectionId,
      )
      .map((record, tableIndex) => {
        const tableId = (record.id || `table-${tableIndex + 1}`)
          .trim()
          .slice(0, 80);
        const columns = csvStringList(record.columns || record.value).slice(
          0,
          50,
        );
        const tableRows = records
          .filter(
            (candidate) =>
              candidate.type === "table_row" &&
              (candidate.section || "overview") === sectionId &&
              (candidate.table_id || candidate.id) === tableId,
          )
          .map((candidate) =>
            csvStringList(candidate.values || candidate.value).slice(
              0,
              columns.length,
            ),
          )
          .filter((row) => row.length > 0);
        return {
          id: tableId,
          title: (record.title || "数据表格").trim().slice(0, 160),
          description:
            (record.description || record.note || "").trim().slice(0, 1_000) ||
            undefined,
          columns,
          rows: tableRows,
        };
      })
      .filter((table) => table.columns.length > 0);
    return {
      id: sectionId.slice(0, 80),
      title: sectionRecord?.title || sectionId,
      subtitle: sectionRecord?.subtitle || undefined,
      body: sectionRecord?.description || sectionRecord?.value || undefined,
      items: records
        .filter(
          (record) =>
            record.type === "item" &&
            (record.section || "overview") === sectionId,
        )
        .map((record) => ({
          title: record.title || "内容",
          description: record.description || record.value || undefined,
          meta: record.meta || undefined,
          imageUrl: record.imageurl || record.image_url || undefined,
        })),
      tables,
    };
  });
  payload.questions = records
    .filter((record) => record.type === "question")
    .map((record, index) => ({
      id: (record.id || record.question_id || `question-${index + 1}`)
        .trim()
        .slice(0, 191),
      groupId: (record.group || record.group_id || "general")
        .trim()
        .slice(0, 128),
      groupTitle: (record.group_title || record.section || "问题")
        .trim()
        .slice(0, 255),
      groupSubtitle: (record.group_subtitle || record.subtitle || "")
        .trim()
        .slice(0, 300),
      tone: ["plum", "teal", "amber", "blue"].includes(record.tone)
        ? (record.tone as "plum" | "teal" | "amber" | "blue")
        : "plum",
      question: (record.title || record.question || "").trim().slice(0, 2_000),
      intent: (record.intent || record.description || "")
        .trim()
        .slice(0, 8_000),
      summary: (record.summary || record.value || "").trim().slice(0, 8_000),
    }))
    .filter((question) => question.question);
  payload.monitoringAnswers = records
    .filter((record) => record.type === "monitor_answer")
    .map((record, index) => ({
      id: (record.id || `monitor-answer-${index + 1}`).trim().slice(0, 191),
      questionId: (record.question_id || record.section || "")
        .trim()
        .slice(0, 191),
      platform: (record.platform || record.model || "").trim().slice(0, 128),
      collectedAt: (record.collected_at || record.date || "")
        .trim()
        .slice(0, 64),
      answerNo: Math.max(
        1,
        Math.trunc(optionalCsvNumber(record.answer_no) || 1),
      ),
      content: (record.answer || record.description || record.value || "")
        .trim()
        .slice(0, 200_000),
      citationCount: optionalCsvNumber(record.citation_count),
      monitorRank: optionalCsvNumber(record.monitor_rank),
      screenshotUrl: (record.screenshot_url || record.image_url || "")
        .trim()
        .slice(0, 2_048),
      citations:
        record.source_title || record.source_url
          ? [
              {
                title: (record.source_title || "").trim().slice(0, 1_000),
                url: (record.source_url || "").trim().slice(0, 2_048),
                media: (record.media || "").trim().slice(0, 255),
              },
            ]
          : [],
    }))
    .filter((record) => record.questionId && record.platform && record.content);
  payload.citations = records
    .filter((record) => record.type === "citation")
    .map((record, index) => ({
      id: (record.id || `citation-${index + 1}`).trim().slice(0, 191),
      questionId: (record.question_id || record.section || "")
        .trim()
        .slice(0, 191),
      model: (record.model || record.platform || "").trim().slice(0, 128),
      question: (record.question || record.value || "").trim().slice(0, 2_000),
      title: (record.title || record.source_title || "").trim().slice(0, 1_000),
      url: (record.url || record.source_url || "").trim().slice(0, 2_048),
      media: (record.media || "").trim().slice(0, 255),
      domain: (record.domain || "").trim().slice(0, 255),
      date: (record.date || record.collected_at || "").trim().slice(0, 64),
    }))
    .filter((record) => record.title || record.url);
  const assetRows = records.filter((record) => record.type === "content_asset");
  payload.contentAssets = assetRows.map((record, index) => {
    const assetId = (record.id || `asset-${index + 1}`).trim().slice(0, 80);
    const articles = records
      .filter(
        (candidate) =>
          candidate.type === "content_article" &&
          (candidate.asset_id || candidate.section) === assetId,
      )
      .map((candidate, articleIndex) => ({
        id: (candidate.id || `${assetId}-article-${articleIndex + 1}`)
          .trim()
          .slice(0, 191),
        title: (candidate.title || "内容").trim().slice(0, 500),
        intro: (candidate.description || "").trim().slice(0, 8_000),
        sections:
          candidate.value || candidate.summary
            ? [
                {
                  heading: (candidate.subtitle || "正文").trim().slice(0, 500),
                  body: (candidate.value || candidate.summary || "")
                    .trim()
                    .slice(0, 30_000),
                  media: candidate.image_url
                    ? [
                        {
                          url: candidate.image_url.trim().slice(0, 2_048),
                          alt: (candidate.title || "").trim().slice(0, 500),
                          caption: (candidate.note || "")
                            .trim()
                            .slice(0, 1_000),
                          source: (candidate.source_url || "")
                            .trim()
                            .slice(0, 2_048),
                        },
                      ]
                    : [],
                },
              ]
            : [],
      }));
    const imageCount = optionalCsvNumber(record.image_count || record.images);
    const impact = optionalCsvNumber(record.impact);
    return {
      id: assetId,
      group: (record.group || record.section || "内容资产")
        .trim()
        .slice(0, 255),
      name: (record.title || record.name || "内容资产").trim().slice(0, 255),
      description: (record.description || "").trim().slice(0, 2_000),
      wordRange: (record.word_range || record.words || "").trim().slice(0, 128),
      ...(imageCount === undefined
        ? {}
        : { imageCount: Math.max(0, Math.trunc(imageCount)) }),
      scene: (record.scene || "").trim().slice(0, 1_000),
      ...(impact === undefined
        ? {}
        : { impact: Math.max(0, Math.min(100, impact)) }),
      articles,
    };
  });
  return dashboardPayloadSchema.parse(payload);
}

const dashboardImportModuleSchema = z.union([
  z.literal("full"),
  dashboardAdminImportModuleSchema,
]);

export type DashboardImportModule = z.infer<typeof dashboardImportModuleSchema>;

function dashboardImportModule(value: string | undefined) {
  return dashboardImportModuleSchema.parse(value?.trim() || "full");
}

export function assertDashboardImportRevision(input: {
  expectedRevision: number | undefined;
  currentRevision: number;
}) {
  if (input.expectedRevision === undefined) {
    throw new Error("缺少看板版本号，请刷新管理页面后重新上传");
  }
  if (input.expectedRevision !== input.currentRevision) {
    throw new DashboardRevisionConflictError();
  }
}

export function assertDashboardImportModuleEnabled(
  module: DashboardImportModule,
): asserts module is DashboardAdminImportModule {
  if (module === "full") {
    throw new Error("整份看板导入已停用。请下载并上传对应模块的当前内容模板。");
  }
}

export function assertDashboardImportPublishHash(input: {
  module: DashboardAdminImportModule;
  fileHash: string;
  expectedFileHash: string | undefined;
}) {
  const expectedFileHash = String(input.expectedFileHash || "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedFileHash)) {
    if (input.module === "monitoring") {
      throw new MonitoringPreviewRequiredError();
    }
    throw new DashboardImportPreviewRequiredError();
  }
  if (expectedFileHash !== input.fileHash) {
    if (input.module === "monitoring") {
      throw new MonitoringFileChangedError();
    }
    throw new DashboardImportFileChangedError();
  }
}

function normalizedQuestionText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function assertOptimizationReportQuestionScope(
  report: NonNullable<DashboardPayload["optimizationReport"]>,
  questions: ReadonlyArray<{ id: string; question: string }>,
) {
  const allowedQuestions = new Map(
    questions.map((question) => [question.id, question]),
  );
  const assertQuestion = (
    questionId: string,
    questionText: string,
    label: string,
  ) => {
    if (!questionId) {
      throw new Error(`${label}缺少问题 ID`);
    }
    const allowed = allowedQuestions.get(questionId);
    if (!allowed) {
      throw new Error(`${label}不属于当前用户的问题`);
    }
    if (
      normalizedQuestionText(allowed.question) !==
      normalizedQuestionText(questionText)
    ) {
      throw new Error(`${label}题面与当前用户的问题不一致`);
    }
  };

  for (const baseline of report.questionBaselines ?? []) {
    assertQuestion(
      baseline.questionId || baseline.id,
      baseline.question,
      "优化前基准",
    );
  }
  for (const questionReport of report.questionReports ?? []) {
    assertQuestion(
      questionReport.id,
      questionReport.question,
      "逐问题进度报告",
    );
  }
}

export function mergeDashboardModule(input: {
  existing: DashboardPayload;
  incoming: DashboardPayload;
  module: Exclude<DashboardImportModule, "section-table" | "response-logic">;
}) {
  const { existing, incoming, module } = input;
  if (module === "full") return dashboardPayloadSchema.parse(incoming);
  if (module === "profile") {
    return dashboardPayloadSchema.parse({
      ...existing,
      brandName: incoming.brandName,
      headline: incoming.headline,
      summary: incoming.summary,
    });
  }
  if (module === "metrics") {
    return dashboardPayloadSchema.parse({
      ...existing,
      metrics: incoming.metrics,
    });
  }
  if (module === "sections") {
    return dashboardPayloadSchema.parse({
      ...existing,
      sections: incoming.sections,
    });
  }
  if (module === "keywords") {
    return dashboardPayloadSchema.parse({
      ...existing,
      keywordTables: incoming.keywordTables,
    });
  }
  if (module === "questions") {
    return dashboardPayloadSchema.parse({
      ...existing,
      questions: incoming.questions,
    });
  }
  if (module === "monitoring") {
    return dashboardPayloadSchema.parse({
      ...existing,
      monitoringAnswers: incoming.monitoringAnswers,
      citations: incoming.citations,
    });
  }
  if (module === "content-assets") {
    return dashboardPayloadSchema.parse({
      ...existing,
      contentAssets: incoming.contentAssets,
    });
  }
  return dashboardPayloadSchema.parse({
    ...existing,
    optimizationReport: incoming.optimizationReport,
  });
}

function dashboardPayloadFromModuleJson(input: {
  text: string;
  existing: DashboardPayload;
  module: Exclude<DashboardImportModule, "section-table" | "response-logic">;
  currentRevision?: number;
}) {
  const raw = JSON.parse(input.text);
  if (input.module === "full") return dashboardPayloadSchema.parse(raw);
  if (input.currentRevision === undefined) {
    throw new DashboardTemplateRevisionError(
      "无法核验当前内容模板修订号，请刷新管理页面后重试。",
    );
  }
  parseDashboardModuleTemplateMetadata({
    raw,
    expectedModule: input.module,
    currentRevision: input.currentRevision,
  });
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const incoming = { ...input.existing };
  if (input.module === "profile") {
    const profile = z
      .object({
        brandName: z.string().trim().min(1).max(160),
        headline: z.string().trim().min(1).max(300),
        summary: z.string().trim().max(4_000).default(""),
      })
      .parse(value.profile ?? raw);
    return dashboardPayloadSchema.parse({ ...incoming, ...profile });
  }
  if (input.module === "metrics") {
    return dashboardPayloadSchema.parse({
      ...incoming,
      metrics: z
        .array(dashboardMetricSchema)
        .max(24)
        .parse(value.metrics ?? raw),
    });
  }
  if (input.module === "sections") {
    return dashboardPayloadSchema.parse({
      ...incoming,
      sections: z
        .array(dashboardSectionSchema)
        .max(40)
        .parse(value.sections ?? raw),
    });
  }
  if (input.module === "keywords") {
    return dashboardPayloadSchema.parse({
      ...incoming,
      keywordTables: z
        .array(dashboardTableSchema)
        .max(20)
        .parse(value.keywordTables ?? value.tables ?? raw),
    });
  }
  if (input.module === "questions") {
    return dashboardPayloadSchema.parse({
      ...incoming,
      questions: z
        .array(dashboardQuestionSchema)
        .max(500)
        .parse(value.questions ?? raw),
    });
  }
  if (input.module === "monitoring") {
    return dashboardPayloadSchema.parse({
      ...incoming,
      monitoringAnswers: z
        .array(dashboardMonitoringAnswerSchema)
        .max(100_000)
        .parse(value.monitoringAnswers ?? []),
      citations: z
        .array(dashboardCitationRecordSchema)
        .max(100_000)
        .parse(value.citations ?? []),
    });
  }
  if (input.module === "content-assets") {
    return dashboardPayloadSchema.parse({
      ...incoming,
      contentAssets: z
        .array(dashboardContentAssetSchema)
        .max(200)
        .parse(value.contentAssets ?? raw),
    });
  }
  const template = parseOptimizationReportTemplate({
    raw,
    currentRevision: input.currentRevision,
  });
  return dashboardPayloadSchema.parse({
    ...incoming,
    optimizationReport: template.optimizationReport,
  });
}

export function parseDashboardModuleTemplateMetadata(input: {
  raw: unknown;
  expectedModule: Exclude<DashboardImportModule, "full" | "section-table">;
  currentRevision: number;
}) {
  const parsed = dashboardModuleTemplateMetadataSchema.safeParse(input.raw);
  if (!parsed.success) {
    throw new DashboardTemplateRevisionError(
      "JSON 文件不是当前内容模板，请重新下载对应模块模板后编辑。",
    );
  }
  if (parsed.data.module !== input.expectedModule) {
    throw new DashboardTemplateRevisionError(
      `模板模块不匹配：当前上传入口为 ${input.expectedModule}`,
    );
  }
  if (parsed.data.templateRevision !== input.currentRevision) {
    throw new DashboardTemplateRevisionError();
  }
  return parsed.data;
}

export function parseOptimizationReportTemplate(input: {
  raw: unknown;
  currentRevision: number;
}) {
  parseDashboardModuleTemplateMetadata({
    raw: input.raw,
    expectedModule: "optimization-report",
    currentRevision: input.currentRevision,
  });
  const parsed = dashboardOptimizationReportTemplateSchema.safeParse(input.raw);
  if (!parsed.success) {
    throw new DashboardTemplateRevisionError(
      "优化报告文件不是当前内容模板，请重新下载模板后编辑。",
    );
  }
  if (parsed.data.templateRevision !== input.currentRevision) {
    throw new DashboardTemplateRevisionError();
  }
  return parsed.data;
}

function recordFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function recordDiffByKey<T>(
  before: readonly T[],
  after: readonly T[],
  recordKey: (item: T, index: number) => string,
) {
  const keyed = (items: readonly T[]) => {
    const occurrences = new Map<string, number>();
    return new Map(
      items.map((item, index) => {
        const baseKey = recordKey(item, index) || `row-${index + 1}`;
        const occurrence = (occurrences.get(baseKey) ?? 0) + 1;
        occurrences.set(baseKey, occurrence);
        return [`${baseKey}#${occurrence}`, item] as const;
      }),
    );
  };
  const beforeById = keyed(before);
  const afterById = keyed(after);
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [id, item] of afterById) {
    const previous = beforeById.get(id);
    if (!previous) {
      added += 1;
    } else if (recordFingerprint(previous) === recordFingerprint(item)) {
      unchanged += 1;
    } else {
      updated += 1;
    }
  }
  let removed = 0;
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) removed += 1;
  }
  return { added, updated, removed, unchanged };
}

function recordDiff<T extends { id?: string; questionId?: string }>(
  before: readonly T[],
  after: readonly T[],
) {
  return recordDiffByKey(before, after, (item) =>
    String(item.questionId || item.id || ""),
  );
}

function previewValue(value: unknown) {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function recordStats<T>(input: {
  label: string;
  before: readonly T[];
  after: readonly T[];
  key: (item: T, index: number) => string;
}) {
  const diff = recordDiffByKey(input.before, input.after, input.key);
  return {
    label: input.label,
    beforeCount: input.before.length,
    afterCount: input.after.length,
    ...diff,
  };
}

function recordStatsSummary(
  stats: DashboardModuleImportPreview["recordStats"][number],
) {
  return `${stats.label}：现有 ${stats.beforeCount} 条，导入后 ${stats.afterCount} 条；新增 ${stats.added}、更新 ${stats.updated}、删除 ${stats.removed}、不变 ${stats.unchanged}`;
}

export function buildDashboardModuleImportPreview(input: {
  module: Exclude<
    DashboardAdminImportModule,
    "monitoring" | "response-logic" | "optimization-report"
  >;
  current: DashboardPayload;
  incoming: DashboardPayload;
  sourceName: string;
  fileHash: string;
  templateRevision: number;
  sectionId?: string;
}): DashboardModuleImportPreview {
  const recordStatsList: DashboardModuleImportPreview["recordStats"] = [];
  const changedFields: DashboardModuleImportPreview["changedFields"] = [];

  if (input.module === "profile") {
    const fields = [
      ["brandName", "企业名称"],
      ["headline", "看板标题"],
      ["summary", "企业摘要"],
    ] as const;
    for (const [field, label] of fields) {
      if (
        recordFingerprint(input.current[field]) !==
        recordFingerprint(input.incoming[field])
      ) {
        changedFields.push({
          field,
          label,
          before: previewValue(input.current[field]),
          after: previewValue(input.incoming[field]),
        });
      }
    }
    recordStatsList.push({
      label: "企业资料字段",
      beforeCount: fields.length,
      afterCount: fields.length,
      added: 0,
      updated: changedFields.length,
      removed: 0,
      unchanged: fields.length - changedFields.length,
    });
  } else if (input.module === "metrics") {
    recordStatsList.push(
      recordStats({
        label: "看板指标",
        before: input.current.metrics,
        after: input.incoming.metrics,
        key: (metric, index) => metric.label || `metric-${index + 1}`,
      }),
    );
  } else if (input.module === "sections") {
    recordStatsList.push(
      recordStats({
        label: "内容板块",
        before: input.current.sections,
        after: input.incoming.sections,
        key: (section) => section.id,
      }),
    );
  } else if (input.module === "section-table") {
    if (!input.sectionId) {
      throw new Error("板块表格预检缺少板块 ID");
    }
    const currentSection = input.current.sections.find(
      (section) => section.id === input.sectionId,
    );
    const incomingSection = input.incoming.sections.find(
      (section) => section.id === input.sectionId,
    );
    if (!currentSection || !incomingSection) {
      throw new Error("没有找到要预检的内容板块");
    }
    recordStatsList.push(
      recordStats({
        label: `板块表格（${currentSection.title}）`,
        before: currentSection.tables ?? [],
        after: incomingSection.tables ?? [],
        key: (table) => table.id,
      }),
    );
  } else if (input.module === "keywords") {
    recordStatsList.push(
      recordStats({
        label: "词库表格",
        before: input.current.keywordTables,
        after: input.incoming.keywordTables,
        key: (table) => table.id,
      }),
    );
  } else if (input.module === "questions") {
    recordStatsList.push(
      recordStats({
        label: "问题目录",
        before: input.current.questions,
        after: input.incoming.questions,
        key: (question) => question.id,
      }),
    );
  } else {
    recordStatsList.push(
      recordStats({
        label: "内容资产",
        before: input.current.contentAssets,
        after: input.incoming.contentAssets,
        key: (asset) => asset.id,
      }),
    );
  }

  const summary =
    changedFields.length > 0
      ? [
          `将更新字段：${changedFields.map((field) => field.label).join("、")}`,
          ...recordStatsList.map(recordStatsSummary),
        ]
      : recordStatsList.map(recordStatsSummary);
  return dashboardModuleImportPreviewSchema.parse({
    mode: "dashboard-module",
    module: input.module,
    sourceName: input.sourceName,
    fileHash: input.fileHash,
    templateRevision: input.templateRevision,
    ...(input.sectionId ? { sectionId: input.sectionId } : {}),
    summary,
    recordStats: recordStatsList,
    changedFields,
  });
}

export function assertResponseLogicImportRecordVersions(input: {
  current: ReadonlyArray<{
    questionId: string;
    revision: number;
  }>;
  incoming: readonly VersionedResponseLogicImport[];
}) {
  const currentByQuestionId = new Map(
    input.current.map((record) => [record.questionId, record]),
  );
  for (const incoming of input.incoming) {
    const actualRevision =
      currentByQuestionId.get(incoming.questionId)?.revision ?? 0;
    if (incoming.expectedRevision !== actualRevision) {
      throw new DashboardTemplateRevisionError(
        `应答逻辑 ${incoming.questionId} 已更新到 R${actualRevision}，当前模板为 R${incoming.expectedRevision}；请重新下载当前内容模板。`,
      );
    }
  }
}

export function buildResponseLogicImportPreview(input: {
  current: ReadonlyArray<{
    questionId: string;
    question: string;
    draft: unknown;
    confirmed?: unknown;
    revision: number;
  }>;
  incoming: readonly VersionedResponseLogicImport[];
  sourceName: string;
  fileHash: string;
  templateRevision: number;
}): DashboardModuleImportPreview {
  assertResponseLogicImportRecordVersions(input);
  const comparableDraft = (value: unknown) => {
    const draft =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return {
      concern: String(draft.concern ?? ""),
      conclusion: String(draft.conclusion ?? ""),
      facts: String(draft.facts ?? ""),
      pending: String(draft.pending ?? ""),
      boundaries: String(draft.boundaries ?? ""),
      references: String(draft.references ?? ""),
      images: Array.isArray(draft.images) ? draft.images : [],
      attachments: [],
    };
  };
  const comparableCurrent = input.current.map((record) => ({
    questionId: record.questionId,
    question: record.question,
    draft: comparableDraft(record.confirmed ?? record.draft),
    publish: Boolean(record.confirmed),
  }));
  const comparableIncoming = input.incoming.map((record) => ({
    questionId: record.questionId,
    question: record.question,
    draft: comparableDraft(record.draft),
    publish: record.publish,
  }));
  const stats = recordStats({
    label: "应答逻辑",
    before: comparableCurrent,
    after: comparableIncoming,
    key: (record) => record.questionId,
  });
  const publishCount = comparableIncoming.filter(
    (record) => record.publish,
  ).length;
  return dashboardModuleImportPreviewSchema.parse({
    mode: "dashboard-module",
    module: "response-logic",
    sourceName: input.sourceName,
    fileHash: input.fileHash,
    templateRevision: input.templateRevision,
    summary: [
      recordStatsSummary(stats),
      `其中 ${publishCount} 条会发布为正式确认版本，其余保存为草稿。`,
    ],
    recordStats: [stats],
    changedFields: [],
  });
}

type AuthoritativeServiceQuestion = {
  id: string;
  category:
    | "industry"
    | "competitor_comparison"
    | "reputation"
    | "product_scenario";
  question: string;
  intent?: string | null;
  rationale?: string | null;
  revision: number;
};

const DASHBOARD_QUESTION_GROUPS = {
  industry: {
    groupId: "ranking",
    groupTitle: "行业词",
    tone: "amber" as const,
  },
  competitor_comparison: {
    groupId: "comparison",
    groupTitle: "竞品对比词",
    tone: "blue" as const,
  },
  reputation: {
    groupId: "reputation",
    groupTitle: "美誉舆情词",
    tone: "plum" as const,
  },
  product_scenario: {
    groupId: "scenario",
    groupTitle: "产品场景词",
    tone: "teal" as const,
  },
};

export function dashboardQuestionCatalogFromService(input: {
  questions: readonly AuthoritativeServiceQuestion[];
  managedQuestions?: readonly DashboardPayload["questions"][number][];
}) {
  const managedByIdentity = new Map<
    string,
    DashboardPayload["questions"][number]
  >();
  for (const managed of input.managedQuestions ?? []) {
    managedByIdentity.set(managed.id, managed);
  }
  return input.questions.map((question) => {
    const managed = managedByIdentity.get(question.id);
    const group = DASHBOARD_QUESTION_GROUPS[question.category];
    return dashboardQuestionSchema.parse({
      id: question.id,
      groupId: group.groupId,
      groupTitle: group.groupTitle,
      groupSubtitle: managed?.groupSubtitle ?? "",
      tone: group.tone,
      question: question.question,
      intent: question.intent ?? managed?.intent ?? "",
      summary: question.rationale ?? managed?.summary ?? "",
    });
  });
}

export function dashboardPayloadWithServiceQuestionCatalog(input: {
  payload: DashboardPayload;
  questions: readonly AuthoritativeServiceQuestion[];
}) {
  return dashboardPayloadSchema.parse({
    ...input.payload,
    questions: dashboardQuestionCatalogFromService({
      questions: input.questions,
      managedQuestions: input.payload.questions,
    }),
  });
}

export function parseAuthoritativeQuestionsTemplate(input: {
  raw: unknown;
  currentRevision: number;
  currentQuestions: readonly AuthoritativeServiceQuestion[];
}) {
  parseDashboardModuleTemplateMetadata({
    raw: input.raw,
    expectedModule: "questions",
    currentRevision: input.currentRevision,
  });
  const template = dashboardQuestionsTemplateSchema.parse(input.raw);
  if (input.currentQuestions.length === 0) {
    throw new Error("当前服务没有可通过模板维护的正式问题");
  }
  const currentById = new Map(
    input.currentQuestions.map((question) => [question.id, question]),
  );
  if (
    template.questions.length !== input.currentQuestions.length ||
    template.questions.some((question) => !currentById.has(question.id))
  ) {
    throw new Error(
      "正式问题模板必须完整保留当前问题目录；新增或删除问题请走问题选择流程。",
    );
  }
  for (const question of template.questions) {
    const current = currentById.get(question.id)!;
    if (question.revision !== current.revision) {
      throw new DashboardTemplateRevisionError(
        `正式问题 ${question.id} 已更新到 R${current.revision}，请重新下载当前内容模板。`,
      );
    }
    if (question.category !== current.category) {
      throw new Error(
        `正式问题 ${question.id} 的问题类型不能通过内容模板修改。`,
      );
    }
  }
  return template;
}

export function buildAuthoritativeQuestionsImportPreview(input: {
  sourceName: string;
  fileHash: string;
  templateRevision: number;
  current: readonly AuthoritativeServiceQuestion[];
  incoming: ReturnType<typeof parseAuthoritativeQuestionsTemplate>["questions"];
}) {
  const stats = recordStats({
    label: "正式问题目录",
    before: input.current.map((question) => ({
      id: question.id,
      revision: question.revision,
      category: question.category,
      question: question.question,
      intent: question.intent ?? null,
      rationale: question.rationale ?? null,
    })),
    after: input.incoming,
    key: (question) => question.id,
  });
  return dashboardModuleImportPreviewSchema.parse({
    mode: "dashboard-module",
    module: "questions",
    sourceName: input.sourceName,
    fileHash: input.fileHash,
    templateRevision: input.templateRevision,
    summary: [
      recordStatsSummary(stats),
      "问题 ID、类型和逐题修订号由正式服务锁定；本次只更新题面、意图和推荐理由。",
    ],
    recordStats: [stats],
    changedFields: [],
  });
}

function monitoringTemplateComparableBatch(
  batch: ReturnType<
    typeof dashboardMonitoringCurrentTemplateSchema.parse
  >["batches"][number],
) {
  return {
    sourceName: batch.sourceName,
    collectedAt: batch.collectedAt,
    samples: batch.samples,
    citations: batch.citations,
  };
}

export function parseMonitoringCurrentTemplate(input: {
  raw: unknown;
  currentRevision: number;
  workspaceUserId: number;
  currentBatches: Awaited<
    ReturnType<typeof getMonitoringCurrentTemplateBatches>
  >;
}) {
  parseDashboardModuleTemplateMetadata({
    raw: input.raw,
    expectedModule: "monitoring",
    currentRevision: input.currentRevision,
  });
  const template = dashboardMonitoringCurrentTemplateSchema.parse(input.raw);
  if (template.workspaceUserId !== input.workspaceUserId) {
    throw new Error("问题监控模板绑定的企业与当前工作台不一致");
  }
  const currentByKey = new Map(
    input.currentBatches.map((batch) => [batch.batchKey, batch]),
  );
  if (
    template.batches.length !== input.currentBatches.length ||
    template.batches.some((batch) => !currentByKey.has(batch.batchKey))
  ) {
    throw new Error(
      "问题监控模板必须完整保留当前服务的监控批次；新增数据请上传原始监控表。",
    );
  }
  for (const batch of template.batches) {
    const current = currentByKey.get(batch.batchKey)!;
    if (batch.revision !== current.revision) {
      throw new DashboardTemplateRevisionError(
        `监控批次 ${batch.batchKey} 已更新到 R${current.revision}，请重新下载当前内容模板。`,
      );
    }
  }
  const changedBatchCount = template.batches.filter(
    (batch) =>
      JSON.stringify(monitoringTemplateComparableBatch(batch)) !==
      JSON.stringify(
        monitoringTemplateComparableBatch(currentByKey.get(batch.batchKey)!),
      ),
  ).length;
  if (changedBatchCount === 0) {
    throw new Error("问题监控当前内容模板与正式数据一致，无需发布");
  }
  return { template, changedBatchCount };
}

export function buildMonitoringCurrentTemplatePreview(input: {
  template: ReturnType<typeof dashboardMonitoringCurrentTemplateSchema.parse>;
  changedBatchCount: number;
  sourceName: string;
  fileHash: string;
  templateRevision: number;
}) {
  const samples = input.template.batches.flatMap((batch) => batch.samples);
  const citations = input.template.batches.flatMap((batch) => batch.citations);
  const questions = [
    ...new Set([...samples, ...citations].map((record) => record.questionId)),
  ];
  const models = [
    ...new Set([
      ...samples.map((sample) => sample.platform),
      ...citations.map((citation) => citation.model),
    ]),
  ];
  const dates = [
    ...new Set(
      input.template.batches
        .map((batch) => monitoringBeijingDate(batch.collectedAt))
        .filter(Boolean),
    ),
  ].sort();
  return {
    module: "monitoring" as const,
    mode: "answer-linked" as const,
    sourceName: input.sourceName,
    fileHash: input.fileHash,
    templateRevision: input.templateRevision,
    summary: [
      `当前正式监控批次 ${input.template.batches.length} 个，其中 ${input.changedBatchCount} 个包含待发布变化。`,
      `答案 ${samples.length} 条，引用 ${citations.length} 条。`,
    ],
    targetBatchRequired: false,
    availableBatches: [],
    questions,
    models,
    dates,
    sampleCount: samples.length,
    citationCount: citations.length,
    exactLinked: citations.filter((citation) =>
      Boolean(citation.sampleSourceRecordId),
    ).length,
    issues: [],
    currentTemplate: true,
    changedBatchCount: input.changedBatchCount,
  };
}

export function buildOptimizationReportImportPreview(input: {
  current: DashboardPayload["optimizationReport"];
  incoming: NonNullable<DashboardPayload["optimizationReport"]>;
  fileHash: string;
  sourceName: string;
  templateRevision: number;
}) {
  return {
    mode: "optimization-report" as const,
    module: "optimization-report" as const,
    sourceName: input.sourceName,
    fileHash: input.fileHash,
    templateRevision: input.templateRevision,
    summary: [
      `逐问题报告：新增 ${
        recordDiff(
          input.current?.questionReports ?? [],
          input.incoming.questionReports ?? [],
        ).added
      }、更新 ${
        recordDiff(
          input.current?.questionReports ?? [],
          input.incoming.questionReports ?? [],
        ).updated
      }、删除 ${
        recordDiff(
          input.current?.questionReports ?? [],
          input.incoming.questionReports ?? [],
        ).removed
      }`,
      `优化后效果将向用户开放 ${
        (input.incoming.questionReports ?? []).filter(
          (report) => report.afterEffect?.released,
        ).length
      } 项。`,
    ],
    questionReports: recordDiff(
      input.current?.questionReports ?? [],
      input.incoming.questionReports ?? [],
    ),
    questionBaselines: recordDiff(
      input.current?.questionBaselines ?? [],
      input.incoming.questionBaselines ?? [],
    ),
    releasedAfterEffects: (input.incoming.questionReports ?? []).filter(
      (report) => report.afterEffect?.released,
    ).length,
    questions: (input.incoming.questionReports ?? []).map((report) => ({
      id: report.id,
      question: report.question,
      afterEffectReleased: Boolean(report.afterEffect?.released),
    })),
  };
}

function tabularCellText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "object") return String(value).trim();
  const record = value as {
    text?: unknown;
    result?: unknown;
    hyperlink?: unknown;
    richText?: Array<{ text?: unknown }>;
  };
  if (record.richText) {
    return record.richText
      .map((part) => String(part.text || ""))
      .join("")
      .trim();
  }
  if (record.text !== undefined) return String(record.text).trim();
  if (record.result !== undefined) return tabularCellText(record.result);
  if (record.hyperlink !== undefined) return String(record.hyperlink).trim();
  return String(value).trim();
}

function trimTabularRow(row: string[]) {
  const copy = [...row];
  while (copy.length > 0 && !copy.at(-1)) copy.pop();
  return copy;
}

function normalizeTableRows(
  rows: string[][],
  title: string,
  tableIndex: number,
) {
  const usableRows = rows
    .map(trimTabularRow)
    .filter((row) => row.some(Boolean));
  if (usableRows.length === 0) return null;
  const width = Math.min(50, Math.max(...usableRows.map((row) => row.length)));
  const columns = Array.from({ length: width }, (_, index) => {
    const value = usableRows[0]?.[index]?.trim();
    return value || `列 ${index + 1}`;
  });
  const normalizedTitle = title.trim() || `数据表格 ${tableIndex + 1}`;
  const slug =
    normalizedTitle
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || `table-${tableIndex + 1}`;
  return dashboardTableSchema.parse({
    id: `${slug}-${tableIndex + 1}`.slice(0, 80),
    title: normalizedTitle.slice(0, 160),
    columns,
    rows: usableRows
      .slice(1, 10_001)
      .map((row) =>
        Array.from({ length: width }, (_, index) =>
          String(row[index] || "").slice(0, 8_000),
        ),
      ),
  });
}

function csvTextFromRows(rows: string[][]) {
  const cell = (value: string) =>
    /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return rows.map((row) => row.map(cell).join(",")).join("\n");
}

async function workbookRows(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return workbook.worksheets.map((worksheet) => {
    const rows: string[][] = [];
    // ExcelJS derives worksheet.columnCount by scanning rows. Cache it once
    // so large monitoring exports do not become an O(n²) import.
    const worksheetColumnCount = Math.min(50, worksheet.columnCount);
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.from(
        { length: Math.min(50, Math.max(row.cellCount, worksheetColumnCount)) },
        (_, index) => tabularCellText(row.getCell(index + 1).value),
      );
      rows.push(trimTabularRow(values));
    });
    return { title: worksheet.name, rows };
  });
}

type TabularSource = Awaited<ReturnType<typeof workbookRows>>[number];

function normalizedTabularHeader(value: string) {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
}

function legacyMonitoringModelFromSheetName(value: string) {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (/deep[\s_-]*seek/.test(normalized)) return "deepseek";
  if (/(?:百度|文心|baidu)/.test(normalized)) return "baiduai";
  if (/(?:豆包|dou[\s_-]*bao)/.test(normalized)) return "doubao";
  if (/(?:通义|千问|qianwen|qwen)/.test(normalized)) return "qianwen";
  if (/(?:腾讯)?元宝|yuanbao/.test(normalized)) return "yuanbao";
  return normalized.slice(0, 128);
}

function sourceDomain(value: string) {
  try {
    const url = new URL(value);
    return url.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .slice(0, 255);
  } catch {
    return "";
  }
}

/**
 * Accepts the citation-analysis workbook exported by the monitoring platform.
 * Aggregate media/content sheets are deliberately not expanded into fake raw
 * rows; the question-citation sheet is the authoritative record ledger.
 */
export function monitoringPayloadFromTabularSources(input: {
  sources: TabularSource[];
  existing: DashboardPayload;
}) {
  const answers: DashboardPayload["monitoringAnswers"] = [];
  const citations: DashboardPayload["citations"] = [];
  let structuredAnswerSheetsPresent = false;
  const questionById = new Map(
    input.existing.questions.map((question) => [question.id, question]),
  );
  const questionIdsByText = new Map<string, string[]>();
  for (const question of input.existing.questions) {
    const text = question.question
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
    questionIdsByText.set(text, [
      ...(questionIdsByText.get(text) ?? []),
      question.id,
    ]);
  }
  const resolveQuestionId = (value: {
    id: string;
    text: string;
    source: string;
  }) => {
    const requestedId = value.id.trim();
    const requestedText = value.text
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
    if (requestedId) {
      const question = questionById.get(requestedId);
      if (!question) {
        throw new Error(`${value.source}引用了未配置的问题 ID：${requestedId}`);
      }
      if (
        requestedText &&
        question.question.normalize("NFKC").replace(/\s+/g, " ").trim() !==
          requestedText
      ) {
        throw new Error(`${value.source}的问题 ID 与问题原文不一致`);
      }
      return requestedId;
    }
    if (!requestedText) {
      throw new Error(`${value.source}缺少问题 ID 和问题原文`);
    }
    const matches = questionIdsByText.get(requestedText) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `${value.source}的问题原文无法在问题目录中精确匹配`
          : `${value.source}的问题原文匹配多个问题，请填写问题 ID`,
      );
    }
    return matches[0]!;
  };
  const columnIndex = (headers: string[], ...names: string[]) => {
    const normalizedNames = names.map(normalizedTabularHeader);
    return headers.findIndex((header) => normalizedNames.includes(header));
  };
  const requireImportDate = (value: string, source: string) => {
    const normalized = value.trim();
    if (!normalized || !Number.isFinite(Date.parse(normalized))) {
      throw new Error(`${source}的日期无效`);
    }
    return normalized;
  };
  const requireImportUrl = (value: string, source: string) => {
    const normalized = value.trim();
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error();
      }
    } catch {
      throw new Error(`${source}的文章链接无效`);
    }
    return normalized;
  };

  // Parse answer sheets first so citation sheets can bind by an exact answer ID
  // regardless of workbook sheet order.
  for (const source of input.sources) {
    const rows = source.rows
      .map(trimTabularRow)
      .filter((row) => row.some(Boolean));
    const headerIndex = rows.findIndex((row) => {
      const headers = new Set(row.map(normalizedTabularHeader));
      return (
        (headers.has("答案id") ||
          headers.has("answerid") ||
          headers.has("样本id")) &&
        (headers.has("答案正文") ||
          headers.has("答案内容") ||
          headers.has("模型回答") ||
          headers.has("回答内容")) &&
        (headers.has("模型") || headers.has("ai模型") || headers.has("平台"))
      );
    });
    if (headerIndex < 0) {
      const firstHeader = rows[0]?.map(normalizedTabularHeader) ?? [];
      const secondHeader = rows[1]?.map(normalizedTabularHeader) ?? [];
      const isLegacyFiveAnswerSheet =
        firstHeader[0] === "品牌名称" &&
        firstHeader[2] === "问题" &&
        firstHeader[3] === "日期" &&
        /^答案1$/.test(firstHeader[4] || "") &&
        secondHeader[4] === "内容" &&
        secondHeader[5] === "截图链接";
      if (!isLegacyFiveAnswerSheet) continue;
      const model = legacyMonitoringModelFromSheetName(source.title);
      if (!model) {
        throw new Error(`${source.title}无法识别监控模型`);
      }
      rows.slice(2).forEach((row, rowIndex) => {
        const sourceRow = `${source.title} 第 ${rowIndex + 3} 行`;
        const rawQuestion = String(row[2] || "").trim();
        if (!rawQuestion) return;
        const questionId = resolveQuestionId({
          id: "",
          text: rawQuestion,
          source: sourceRow,
        });
        const date = requireImportDate(String(row[3] || ""), sourceRow);
        for (let answerOffset = 0; answerOffset < 5; answerOffset += 1) {
          const columnOffset = 4 + answerOffset * 4;
          const content = String(row[columnOffset] || "").trim();
          const screenshotUrl = String(row[columnOffset + 1] || "").trim();
          const rankText = String(
            row[columnOffset + 3] || row[columnOffset + 2] || "",
          ).trim();
          if (!content && !screenshotUrl && !rankText) continue;
          if (!content) {
            throw new Error(
              `${sourceRow}的答案 ${answerOffset + 1} 缺少答案正文`,
            );
          }
          const answerNo = answerOffset + 1;
          const digest = createHash("sha1")
            .update(
              [source.title, model, questionId, date, answerNo, content].join(
                "\u001f",
              ),
            )
            .digest("hex");
          const rankMatch = rankText.match(/\d+/);
          const monitorRank = rankMatch ? Number(rankMatch[0]) : undefined;
          answers.push({
            id: `legacy-answer-${digest}`,
            questionId,
            platform: model,
            collectedAt: date.slice(0, 64),
            answerNo,
            content: content.slice(0, 200_000),
            citationCount: 0,
            monitorRank:
              Number.isInteger(monitorRank) && Number(monitorRank) > 0
                ? Number(monitorRank)
                : undefined,
            screenshotUrl: screenshotUrl.slice(0, 2_048),
            citations: [],
          });
        }
      });
      continue;
    }
    structuredAnswerSheetsPresent = true;
    const headers = rows[headerIndex]!.map(normalizedTabularHeader);
    const answerIdIndex = columnIndex(
      headers,
      "答案ID",
      "answer_id",
      "answerId",
      "样本ID",
    );
    const questionIdIndex = columnIndex(
      headers,
      "问题ID",
      "question_id",
      "questionId",
    );
    const questionIndex = columnIndex(headers, "问题原文", "监控问题", "问题");
    const modelIndex = columnIndex(headers, "模型", "AI模型", "平台");
    const dateIndex = columnIndex(headers, "采集时间", "采集日期", "日期");
    const contentIndex = columnIndex(
      headers,
      "答案正文",
      "答案内容",
      "模型回答",
      "回答内容",
    );
    const answerNoIndex = columnIndex(
      headers,
      "答案序号",
      "答案编号",
      "answerNo",
    );
    const rankIndex = columnIndex(headers, "答案位次", "排名", "monitorRank");
    const screenshotIndex = columnIndex(
      headers,
      "截图URL",
      "截图链接",
      "screenshotUrl",
    );
    rows.slice(headerIndex + 1).forEach((row, rowIndex) => {
      const sourceRow = `${source.title} 第 ${headerIndex + rowIndex + 2} 行`;
      const answerId = String(row[answerIdIndex] || "").trim();
      const content = String(row[contentIndex] || "").trim();
      if (!answerId && !content) return;
      if (!answerId) {
        throw new Error(`${sourceRow}缺少答案 ID`);
      }
      if (answerId.length > 191) {
        throw new Error(`${sourceRow}的答案 ID 超过 191 个字符`);
      }
      if (!content) {
        throw new Error(`${sourceRow}缺少答案正文`);
      }
      const model = String(row[modelIndex] || "").trim();
      if (!model) {
        throw new Error(`${sourceRow}缺少模型`);
      }
      const rawQuestionId = String(row[questionIdIndex] || "").trim();
      const rawQuestion = String(row[questionIndex] || "").trim();
      if (!rawQuestionId) throw new Error(`${sourceRow}缺少问题 ID`);
      if (!rawQuestion) throw new Error(`${sourceRow}缺少问题原文`);
      const questionId = resolveQuestionId({
        id: rawQuestionId,
        text: rawQuestion,
        source: sourceRow,
      });
      const date = requireImportDate(String(row[dateIndex] || ""), sourceRow);
      const answerNo = Number(String(row[answerNoIndex] || "").trim());
      const monitorRank = Number(String(row[rankIndex] || "").trim());
      answers.push({
        id: answerId.slice(0, 191),
        questionId,
        platform: model.slice(0, 128),
        collectedAt: date.slice(0, 64),
        answerNo:
          Number.isInteger(answerNo) && answerNo > 0 ? answerNo : rowIndex + 1,
        content: content.slice(0, 200_000),
        citationCount: 0,
        monitorRank:
          Number.isInteger(monitorRank) && monitorRank > 0
            ? monitorRank
            : undefined,
        screenshotUrl: String(row[screenshotIndex] || "")
          .trim()
          .slice(0, 2_048),
        citations: [],
      });
    });
  }
  const answerById = new Map<
    string,
    DashboardPayload["monitoringAnswers"][number]
  >();
  for (const answer of answers) {
    if (answerById.has(answer.id)) {
      throw new Error(`答案明细存在重复的答案 ID：${answer.id}`);
    }
    answerById.set(answer.id, answer);
  }
  const citationIds = new Set<string>();
  for (const source of input.sources) {
    const rows = source.rows
      .map(trimTabularRow)
      .filter((row) => row.some(Boolean));
    const headerIndex = rows.findIndex((row) => {
      const headers = new Set(row.map(normalizedTabularHeader));
      const hasQuestion =
        headers.has("监控问题") ||
        headers.has("问题") ||
        headers.has("问题原文") ||
        headers.has("问题id");
      return (
        hasQuestion &&
        (headers.has("文章标题") || headers.has("引用内容")) &&
        (headers.has("文章链接") || headers.has("文章url"))
      );
    });
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex]!.map(normalizedTabularHeader);
    const citationIdIndex = columnIndex(
      headers,
      "引用ID",
      "citation_id",
      "citationId",
    );
    const answerIdIndex = columnIndex(
      headers,
      "答案ID",
      "answer_id",
      "answerId",
      "样本ID",
    );
    const questionIdIndex = columnIndex(
      headers,
      "问题ID",
      "question_id",
      "questionId",
    );
    const modelIndex = columnIndex(headers, "模型", "AI模型", "平台");
    const questionIndex = columnIndex(headers, "问题原文", "监控问题", "问题");
    const titleIndex = columnIndex(headers, "文章标题", "引用内容", "标题");
    const urlIndex = columnIndex(headers, "文章链接", "文章URL", "链接", "URL");
    const mediaIndex = columnIndex(headers, "媒体名称", "媒体信源", "媒体");
    const dateIndex = columnIndex(headers, "引用日期", "日期", "采集日期");
    const requiresExactLinkage =
      structuredAnswerSheetsPresent &&
      (citationIdIndex >= 0 || answerIdIndex >= 0);
    rows.slice(headerIndex + 1).forEach((row, rowIndex) => {
      const sourceRow = `${source.title} 第 ${headerIndex + rowIndex + 2} 行`;
      const answerId = String(row[answerIdIndex] || "").trim();
      const title = String(row[titleIndex] || "").trim();
      const url = String(row[urlIndex] || "").trim();
      if (!answerId && !title && !url) return;
      if (!title && !url) return;
      const providedCitationId = String(row[citationIdIndex] || "").trim();
      if (requiresExactLinkage && !providedCitationId) {
        throw new Error(`${sourceRow}缺少引用 ID`);
      }
      if (providedCitationId.length > 191) {
        throw new Error(`${sourceRow}的引用 ID 超过 191 个字符`);
      }
      if (requiresExactLinkage && !answerId) {
        throw new Error(`${sourceRow}缺少答案 ID`);
      }
      if (providedCitationId && citationIds.has(providedCitationId)) {
        throw new Error(`${sourceRow}存在重复的引用 ID：${providedCitationId}`);
      }
      const linkedAnswer = answerId ? answerById.get(answerId) : undefined;
      if (answerId && !linkedAnswer) {
        throw new Error(`${sourceRow}引用了不存在的答案 ID：${answerId}`);
      }
      const rawQuestionId = String(row[questionIdIndex] || "");
      const rawQuestion = String(row[questionIndex] || "");
      if (requiresExactLinkage && !rawQuestionId.trim()) {
        throw new Error(`${sourceRow}缺少问题 ID`);
      }
      const questionId =
        linkedAnswer && !rawQuestionId.trim() && !rawQuestion.trim()
          ? linkedAnswer.questionId
          : resolveQuestionId({
              id: rawQuestionId,
              text: rawQuestion,
              source: sourceRow,
            });
      if (linkedAnswer && linkedAnswer.questionId !== questionId) {
        throw new Error(`${sourceRow}的答案 ID 与问题不一致`);
      }
      const media = String(row[mediaIndex] || "").trim();
      const date = String(row[dateIndex] || "").trim();
      if (linkedAnswer) {
        if (!title) throw new Error(`${sourceRow}缺少文章标题`);
        const linkedUrl = requireImportUrl(url, sourceRow);
        if (!media) throw new Error(`${sourceRow}缺少媒体名称`);
        requireImportDate(date, sourceRow);
        const citationModel = String(row[modelIndex] || "").trim();
        if (
          citationModel &&
          monitoringModelKey(citationModel) !==
            monitoringModelKey(linkedAnswer.platform)
        ) {
          throw new Error(`${sourceRow}的模型与答案 ID 不一致`);
        }
        citationIds.add(providedCitationId);
        linkedAnswer.citations.push({
          id: providedCitationId,
          title: title.slice(0, 1_000),
          url: linkedUrl.slice(0, 2_048),
          media: media.slice(0, 255),
          publishedAt: date.slice(0, 64),
        });
        linkedAnswer.citationCount = linkedAnswer.citations.length;
        return;
      }
      const model = String(row[modelIndex] || "").trim();
      if (date) requireImportDate(date, sourceRow);
      const digest = createHash("sha1")
        .update(
          [
            source.title,
            rowIndex,
            model,
            questionId,
            title,
            url,
            media,
            date,
          ].join("\u001f"),
        )
        .digest("hex");
      const citationId = (providedCitationId || `citation-${digest}`).slice(
        0,
        191,
      );
      if (citationIds.has(citationId)) {
        throw new Error(`${sourceRow}存在重复的引用 ID：${citationId}`);
      }
      citationIds.add(citationId);
      citations.push({
        id: citationId,
        questionId,
        model: (model || "未标注模型").slice(0, 128),
        question: questionById.get(questionId)?.question || "",
        title: title.slice(0, 1_000),
        url: url.slice(0, 2_048),
        media: media.slice(0, 255),
        domain: sourceDomain(url),
        date: date.slice(0, 64),
      });
    });
  }
  if (answers.length === 0 && citations.length === 0) return null;
  return {
    ...input.existing,
    monitoringAnswers: answers,
    citations,
  } satisfies DashboardPayload;
}

function responseLogicPublishValue(
  value: unknown,
  draft: {
    concern: string;
    conclusion: string;
    facts: string;
    boundaries: string;
    references: string;
  },
) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
  if (["true", "1", "yes", "是", "确认", "发布"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "否", "草稿"].includes(normalized)) {
    return false;
  }
  return [
    draft.concern,
    draft.conclusion,
    draft.facts,
    draft.boundaries,
    draft.references,
  ].every((item) => item.trim().length > 0);
}

function responseLogicImages(value: unknown) {
  if (Array.isArray(value)) return value;
  const normalized = String(value ?? "").trim();
  if (!normalized) return [];
  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error("应答逻辑图片字段必须是 JSON 数组");
  }
}

export type VersionedResponseLogicImport = SaveResponseLogicInput & {
  expectedRevision: number;
};

function responseLogicExpectedRevision(raw: Record<string, unknown>) {
  const value =
    raw.version ??
    raw.revision ??
    raw.recordRevision ??
    raw.record_revision ??
    raw["版本"] ??
    raw["记录版本"] ??
    raw["修订号"];
  const normalized =
    typeof value === "number" ? value : String(value ?? "").trim();
  const revision = normalized === "" ? Number.NaN : Number(normalized);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new DashboardTemplateRevisionError(
      "应答逻辑记录缺少有效的 version；请下载当前内容模板后编辑，不要沿用旧模板。",
    );
  }
  return revision;
}

function authoritativeResponseLogicInput(input: {
  raw: Record<string, unknown>;
  existing: DashboardPayload;
}): VersionedResponseLogicImport {
  const requestedQuestionId = String(
    input.raw.questionId ?? input.raw.question_id ?? input.raw["问题ID"] ?? "",
  ).trim();
  const requestedQuestion = String(
    input.raw.question ?? input.raw["问题"] ?? "",
  ).trim();
  const question =
    input.existing.questions.find(
      (candidate) => candidate.id === requestedQuestionId,
    ) ||
    input.existing.questions.find(
      (candidate) => candidate.question === requestedQuestion,
    );
  if (!question) {
    throw new Error(
      requestedQuestionId || requestedQuestion
        ? `应答逻辑未匹配到问题目录：${requestedQuestionId || requestedQuestion}`
        : "应答逻辑缺少问题 ID 或问题原文",
    );
  }
  const rawDraft =
    input.raw.draft &&
    typeof input.raw.draft === "object" &&
    !Array.isArray(input.raw.draft)
      ? (input.raw.draft as Record<string, unknown>)
      : input.raw;
  const draft = responseLogicDraftSchema.parse({
    concern: String(rawDraft.concern ?? rawDraft["用户真正关心"] ?? ""),
    conclusion: String(
      rawDraft.conclusion ??
        rawDraft["核心结论"] ??
        rawDraft["核心结论/执行口径"] ??
        "",
    ),
    facts: String(
      rawDraft.facts ??
        rawDraft["企业材料"] ??
        rawDraft["企业材料/官方依据"] ??
        "",
    ),
    pending: String(rawDraft.pending ?? rawDraft["企业待确认"] ?? ""),
    boundaries: String(rawDraft.boundaries ?? rawDraft["表达边界"] ?? ""),
    references: String(rawDraft.references ?? rawDraft["参考资料"] ?? ""),
    images: responseLogicImages(rawDraft.images ?? rawDraft["图片"]),
    // Manual imports cannot assert ownership of upstream file IDs.
    attachments: [],
  });
  return {
    ...saveResponseLogicSchema.parse({
      questionId: question.id,
      groupId: question.groupId,
      groupTitle: question.groupTitle,
      question: question.question,
      intent: question.intent,
      summary: question.summary,
      draft,
      publish: responseLogicPublishValue(
        input.raw.publish ?? input.raw["发布"],
        draft,
      ),
    }),
    expectedRevision: responseLogicExpectedRevision(input.raw),
  };
}

function isEmptyResponseLogicPlaceholder(record: VersionedResponseLogicImport) {
  return (
    record.expectedRevision === 0 &&
    !record.publish &&
    [
      record.draft.concern,
      record.draft.conclusion,
      record.draft.facts,
      record.draft.pending,
      record.draft.boundaries,
      record.draft.references,
    ].every((value) => value.trim().length === 0) &&
    record.draft.images.length === 0
  );
}

export function responseLogicImportsFromTabularSources(input: {
  sources: TabularSource[];
  existing: DashboardPayload;
}): VersionedResponseLogicImport[] {
  const records: VersionedResponseLogicImport[] = [];
  for (const source of input.sources) {
    const rows = source.rows
      .map(trimTabularRow)
      .filter((row) => row.some(Boolean));
    if (rows.length < 2) continue;
    const headers = rows[0]!.map((header) => header.trim());
    const normalizedHeaders = headers.map(normalizedTabularHeader);
    const hasQuestion = normalizedHeaders.some((header) =>
      ["questionid", "question_id", "问题id", "问题"].includes(header),
    );
    if (!hasQuestion) continue;
    for (const row of rows.slice(1)) {
      const raw = Object.fromEntries(
        headers.map((header, index) => [header, row[index] ?? ""]),
      );
      const record = authoritativeResponseLogicInput({
        raw,
        existing: input.existing,
      });
      if (!isEmptyResponseLogicPlaceholder(record)) records.push(record);
    }
  }
  const questionIds = records.map((record) => record.questionId);
  if (new Set(questionIds).size !== questionIds.length) {
    throw new Error("应答逻辑文件中同一问题出现了多次");
  }
  if (records.length === 0) {
    throw new Error("文件中没有可导入的应答逻辑记录");
  }
  return records;
}

async function responseLogicImportsFromFile(input: {
  buffer: Buffer;
  sourceFileName: string;
  existing: DashboardPayload;
}) {
  const extension = path.extname(input.sourceFileName).toLowerCase();
  if (extension === ".json") {
    const raw = JSON.parse(input.buffer.toString("utf8"));
    const source =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const records = Array.isArray(raw)
      ? raw
      : (source.responseLogic ?? source.records);
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error("应答逻辑 JSON 必须包含 responseLogic 数组");
    }
    const parsed = records
      .map((record) => {
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          throw new Error("应答逻辑 JSON 记录格式无效");
        }
        return authoritativeResponseLogicInput({
          raw: record as Record<string, unknown>,
          existing: input.existing,
        });
      })
      .filter((record) => !isEmptyResponseLogicPlaceholder(record));
    if (parsed.length === 0) {
      throw new Error("文件中没有需要导入的应答逻辑记录");
    }
    const questionIds = parsed.map((record) => record.questionId);
    if (new Set(questionIds).size !== questionIds.length) {
      throw new Error("应答逻辑文件中同一问题出现了多次");
    }
    return parsed;
  }
  const sources =
    extension === ".xlsx"
      ? await workbookRows(input.buffer)
      : [
          {
            title: path.basename(input.sourceFileName, extension),
            rows: parseCsvRows(
              input.buffer.toString("utf8").replace(/^\uFEFF/, ""),
            ),
          },
        ];
  return responseLogicImportsFromTabularSources({
    sources,
    existing: input.existing,
  });
}

async function tabularTablesFromFile(input: {
  buffer: Buffer;
  sourceFileName: string;
}) {
  const extension = path.extname(input.sourceFileName).toLowerCase();
  const sources =
    extension === ".xlsx"
      ? await workbookRows(input.buffer)
      : [
          {
            title:
              path.basename(
                input.sourceFileName,
                path.extname(input.sourceFileName),
              ) || "数据表格",
            rows: parseCsvRows(
              input.buffer.toString("utf8").replace(/^\uFEFF/, ""),
            ),
          },
        ];
  return sources
    .map((source, index) =>
      normalizeTableRows(source.rows, source.title, index),
    )
    .filter((table): table is NonNullable<typeof table> => Boolean(table));
}

async function dashboardPayloadFromFile(input: {
  buffer: Buffer;
  sourceFileName: string;
  existing: DashboardPayload;
  module: Exclude<DashboardImportModule, "section-table" | "response-logic">;
  currentRevision: number;
}) {
  const extension = path.extname(input.sourceFileName).toLowerCase();
  if (extension === ".json") {
    return dashboardPayloadFromModuleJson({
      text: input.buffer.toString("utf8"),
      existing: input.existing,
      module: input.module,
      currentRevision: input.currentRevision,
    });
  }
  const sources =
    extension === ".xlsx"
      ? await workbookRows(input.buffer)
      : [
          {
            title: path.basename(input.sourceFileName, extension),
            rows: parseCsvRows(
              input.buffer.toString("utf8").replace(/^\uFEFF/, ""),
            ),
          },
        ];
  if (input.module === "monitoring") {
    const monitoringPayload = monitoringPayloadFromTabularSources({
      sources,
      existing: input.existing,
    });
    if (monitoringPayload) return monitoringPayload;
  }
  const rows = sources[0]?.rows ?? [];
  const parsed = dashboardFromCsv(
    csvTextFromRows(rows),
    input.existing.brandName,
  );
  return mergeDashboardModule({
    existing: input.existing,
    incoming: parsed,
    module: input.module,
  });
}

function validIsoDate(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function stableMonitoringBatchKey(input: {
  sourceHash?: string;
  monitoringContent: unknown;
}) {
  const digest =
    input.sourceHash?.toLowerCase().match(/^[a-f0-9]{64}$/)?.[0] ??
    createHash("sha256")
      .update(JSON.stringify(input.monitoringContent))
      .digest("hex");
  return `dashboard-import:sha256:${digest}`;
}

function embeddedCitationSourceId(input: {
  answerId: string;
  index: number;
  title: string;
  url: string;
  media: string;
}) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        input.answerId,
        input.index,
        input.title,
        input.url,
        input.media,
      ]),
    )
    .digest("hex")
    .slice(0, 40);
  return `embedded-citation:${digest}`;
}

function assertUniqueSourceRecordIds(
  rows: ReadonlyArray<{ sourceRecordId: string }>,
  label: string,
) {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.sourceRecordId)) {
      throw new Error(`${label}存在重复的记录 ID：${row.sourceRecordId}`);
    }
    seen.add(row.sourceRecordId);
  }
}

/**
 * Converts the dashboard import-only monitoring fields to the normalized
 * monitoring contract. Question text in imported citations is never trusted as
 * a new question: it may only resolve exactly to a question in this payload.
 */
export function buildDashboardMonitoringImport(input: {
  targetUserId: number;
  payload: DashboardPayload;
  sourceFileName: string;
  sourceHash?: string;
  now?: Date;
}): ReplaceMonitoringBatchInput | null {
  const { payload } = input;
  if (
    payload.monitoringAnswers.length === 0 &&
    payload.citations.length === 0
  ) {
    return null;
  }

  const questionById = new Map<string, (typeof payload.questions)[number]>();
  const questionIdsByText = new Map<string, string[]>();
  for (const question of payload.questions) {
    if (questionById.has(question.id)) {
      throw new Error(`问题目录存在重复 ID：${question.id}`);
    }
    questionById.set(question.id, question);
    const ids = questionIdsByText.get(question.question) ?? [];
    ids.push(question.id);
    questionIdsByText.set(question.question, ids);
  }

  const requireQuestionId = (questionId: string) => {
    if (!questionById.has(questionId)) {
      throw new Error(`监控记录引用了未配置的问题：${questionId || "（空）"}`);
    }
    return questionId;
  };
  const resolveCitationQuestionId = (
    citation: (typeof payload.citations)[number],
  ) => {
    if (citation.questionId) return requireQuestionId(citation.questionId);
    if (!citation.question) {
      throw new Error(
        `引用记录 ${citation.id} 缺少 questionId，且没有可用于精确匹配的问题文本`,
      );
    }
    const matches = questionIdsByText.get(citation.question) ?? [];
    if (matches.length === 0) {
      throw new Error(
        `引用记录 ${citation.id} 的问题文本无法在问题目录中精确匹配`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `引用记录 ${citation.id} 的问题文本匹配到多个问题，请明确填写 questionId`,
      );
    }
    return matches[0]!;
  };

  const validDates: string[] = [];
  const collectDate = (value: string | undefined) => {
    const normalized = validIsoDate(value);
    if (normalized) validDates.push(normalized);
    return normalized;
  };

  const samples: ReplaceMonitoringBatchInput["samples"] =
    payload.monitoringAnswers.map((answer) => ({
      sourceRecordId: answer.id,
      questionId: requireQuestionId(answer.questionId),
      platform: answer.platform,
      answerNo: answer.answerNo,
      content: answer.content,
      citationCount: answer.citationCount,
      monitorRank:
        answer.monitorRank === undefined
          ? undefined
          : Math.max(1, Math.trunc(answer.monitorRank)),
      screenshotUrl: answer.screenshotUrl,
      collectedAt: collectDate(answer.collectedAt),
    }));

  const citations: ReplaceMonitoringBatchInput["citations"] = [];
  for (const answer of payload.monitoringAnswers) {
    answer.citations.forEach((citation, index) => {
      citations.push({
        sourceRecordId:
          citation.id ||
          embeddedCitationSourceId({
            answerId: answer.id,
            index,
            title: citation.title,
            url: citation.url,
            media: citation.media,
          }),
        questionId: requireQuestionId(answer.questionId),
        sampleSourceRecordId: answer.id,
        model: answer.platform,
        title: citation.title,
        url: citation.url,
        media: citation.media,
        domain: "",
        publishedAt: citation.publishedAt,
        collectedAt: collectDate(answer.collectedAt),
      });
    });
  }
  for (const citation of payload.citations) {
    const normalizedDate = collectDate(citation.date);
    citations.push({
      sourceRecordId: citation.id,
      questionId: resolveCitationQuestionId(citation),
      model: citation.model || "未标注模型",
      title: citation.title,
      url: citation.url,
      media: citation.media,
      domain: citation.domain,
      publishedAt: normalizedDate,
      collectedAt: normalizedDate,
    });
  }

  assertUniqueSourceRecordIds(samples, "监控样本");
  assertUniqueSourceRecordIds(citations, "引用记录");

  const fallbackDate =
    input.now && Number.isFinite(input.now.getTime()) ? input.now : new Date();
  const collectedAt =
    validDates.length > 0
      ? validDates.reduce((latest, value) =>
          Date.parse(value) > Date.parse(latest) ? value : latest,
        )
      : fallbackDate.toISOString();
  const sourceName =
    input.sourceFileName.trim().slice(0, 512) || "dashboard.json";
  return replaceMonitoringBatchSchema.parse({
    userId: input.targetUserId,
    batchKey: stableMonitoringBatchKey({
      sourceHash: input.sourceHash,
      monitoringContent: { samples, citations },
    }),
    sourceName,
    collectedAt,
    samples,
    citations,
  });
}

export type MonitoringImportPreviewIssue = {
  severity: "warning" | "error";
  code: string;
  message: string;
};

export type MonitoringImportAvailableBatch = {
  batchKey: string;
  sourceName: string;
  collectedAt: number;
  revision: number;
  sampleCount: number;
  citationCount: number;
};

export type MonitoringImportPreview = {
  module: "monitoring";
  mode: "answer-linked" | "answer-only" | "question-only" | "mixed" | "invalid";
  sourceName: string;
  fileHash: string;
  templateRevision: number;
  summary: string[];
  targetBatchRequired: boolean;
  availableBatches: MonitoringImportAvailableBatch[];
  suggestedBatchKey?: string;
  questions: Array<{ id: string; label: string }>;
  models: Array<{ key: string; label: string }>;
  dates: string[];
  sampleCount: number;
  citationCount: number;
  exactLinked: number;
  issues: MonitoringImportPreviewIssue[];
};

export function monitoringImportFileHash(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Pure, side-effect-free projection used by the import preview endpoint. */
export function buildMonitoringImportPreview(input: {
  payload: DashboardPayload;
  batch: ReplaceMonitoringBatchInput;
  sourceName: string;
  fileHash: string;
  templateRevision?: number;
  availableBatches?: MonitoringImportAvailableBatch[];
}): MonitoringImportPreview {
  const { batch } = input;
  const exactLinked = batch.citations.filter(
    (citation) => citation.sampleSourceRecordId,
  ).length;
  const standaloneCitationCount = batch.citations.length - exactLinked;
  const targetBatchRequired =
    batch.samples.length === 0 && standaloneCitationCount > 0;
  const mode =
    batch.samples.length === 0
      ? "question-only"
      : exactLinked > 0 && standaloneCitationCount > 0
        ? "mixed"
        : exactLinked > 0
          ? "answer-linked"
          : "answer-only";
  const questionLabelById = new Map(
    input.payload.questions.map((question) => [question.id, question.question]),
  );
  const questionIds = [
    ...new Set([
      ...batch.samples.map((sample) => sample.questionId),
      ...batch.citations.map((citation) => citation.questionId),
    ]),
  ];
  const modelByKey = new Map<string, { key: string; label: string }>();
  for (const label of [
    ...batch.samples.map((sample) => sample.platform),
    ...batch.citations.map((citation) => citation.model),
  ]) {
    const key = monitoringModelKey(label);
    if (!modelByKey.has(key)) modelByKey.set(key, { key, label });
  }
  const dates = [
    ...new Set(
      [
        batch.collectedAt,
        ...batch.samples.map((sample) => sample.collectedAt),
        ...batch.citations.flatMap((citation) => [
          citation.collectedAt,
          citation.publishedAt,
        ]),
      ]
        .filter((value): value is string => Boolean(value))
        .map(monitoringBeijingDate)
        .filter(Boolean),
    ),
  ].sort((left, right) => right.localeCompare(left));
  const availableBatches = input.availableBatches ?? [];
  const issues: MonitoringImportPreviewIssue[] = [];
  if (targetBatchRequired) {
    issues.push({
      severity: "warning",
      code: "MONITORING_TARGET_BATCH_REQUIRED",
      message:
        "该文件只有问题级引用，没有答案明细。正式导入前请选择一个包含答案的目标批次；系统不会按标题或问题文本将引用模糊绑定到答案。",
    });
  }
  if (batch.samples.length > 0 && exactLinked === 0) {
    issues.push({
      severity: "warning",
      code: "MONITORING_SAMPLE_CITATIONS_MISSING",
      message:
        "已识别答案明细，但没有引用通过答案 ID 精确关联；逐答案信源将显示为空。",
    });
  }
  return {
    module: "monitoring",
    mode,
    sourceName: input.sourceName,
    fileHash: input.fileHash,
    templateRevision: input.templateRevision ?? 0,
    summary: [
      `答案记录 ${batch.samples.length} 条，引用记录 ${batch.citations.length} 条。`,
      exactLinked > 0
        ? `${exactLinked} 条引用已通过答案 ID 精确关联。`
        : "当前文件没有可验证的逐答案引用关联。",
    ],
    targetBatchRequired,
    availableBatches,
    suggestedBatchKey: targetBatchRequired
      ? availableBatches.find((batch) => batch.sampleCount > 0)?.batchKey
      : undefined,
    questions: questionIds.map((id) => ({
      id,
      label: questionLabelById.get(id) || id,
    })),
    models: [...modelByKey.values()],
    dates,
    sampleCount: batch.samples.length,
    citationCount: batch.citations.length,
    exactLinked,
    issues,
  };
}

export async function importDashboardPayload(input: {
  actor: AuthenticatedUser;
  targetUserId: number;
  payload: DashboardPayload;
  sourceFileName: string;
  bindEnterpriseIdentity?: boolean;
  expectedRevision?: number;
  progressReportPeriods?: Array<{
    contractId: string;
    quotaPeriodId: string;
  }>;
  beforeWrite?: DashboardWorkspaceWriteHook;
  afterWrite?: DashboardWorkspaceWriteHook;
  now?: Date;
  dependencies?: {
    updateWorkspace: typeof updateDashboardWorkspace;
    replaceMonitoring: typeof replaceMonitoringBatch;
  };
}) {
  const dependencies = input.dependencies ?? {
    updateWorkspace: updateDashboardWorkspace,
    replaceMonitoring: replaceMonitoringBatch,
  };
  const monitoringBatch = buildDashboardMonitoringImport({
    targetUserId: input.targetUserId,
    payload: input.payload,
    sourceFileName: input.sourceFileName,
    now: input.now,
  });
  const storedPayload: DashboardPayload = {
    ...input.payload,
    monitoringAnswers: [],
    citations: [],
  };
  const dashboard = await dependencies.updateWorkspace({
    userId: input.targetUserId,
    actorUserId: input.actor.id,
    payload: storedPayload,
    sourceName: input.sourceFileName,
    bindEnterpriseIdentity: input.bindEnterpriseIdentity,
    expectedRevision: input.expectedRevision,
    progressReportPeriods: input.progressReportPeriods,
    beforeWrite: input.beforeWrite,
    afterWrite: input.afterWrite,
  });
  if (monitoringBatch) {
    await dependencies.replaceMonitoring({
      actor: input.actor,
      value: monitoringBatch,
    });
  }
  return dashboard;
}

type AtomicDashboardImportModule = Exclude<
  DashboardAdminImportModule,
  "questions" | "monitoring" | "response-logic"
>;

export function dashboardImportTransactionHooks(input: {
  actor: AuthenticatedUser;
  targetUserId: number;
  module: AtomicDashboardImportModule;
  expectedRevision: number;
  fileHash: string;
  preflightToken: string | undefined;
  sourceFileName: string;
  sectionId?: string;
}) {
  const sectionTable = input.module === "section-table";
  return {
    beforeWrite: async (tx: any) => {
      await consumeDashboardImportPreflight({
        token: input.preflightToken,
        binding: {
          actorId: input.actor.id,
          workspaceUserId: input.targetUserId,
          module: input.module,
          revision: input.expectedRevision,
          fileHash: input.fileHash,
          ...(input.sectionId ? { sectionId: input.sectionId } : {}),
        },
        store: dashboardImportPreflightStoreForExecutor(tx),
      });
    },
    afterWrite: async (
      tx: any,
      writeContext: Parameters<DashboardWorkspaceWriteHook>[1],
    ) => {
      await writeWorkspaceAuditEvent(
        {
          actor: input.actor,
          action: sectionTable
            ? "workspace.dashboard.section_table_imported"
            : "workspace.dashboard.module_imported",
          targetType: "dashboard",
          targetId: input.targetUserId,
          workspaceUserId: input.targetUserId,
          metadata: {
            sourceName: input.sourceFileName,
            ...(sectionTable
              ? { sectionId: input.sectionId }
              : { module: input.module }),
            expectedRevision: input.expectedRevision,
            revision: writeContext.nextRevision,
          },
        },
        tx,
      );
    },
  };
}

export async function readKnowledgeArchive(
  buffer: Buffer,
  sourceFileName: string,
  snapshotId: string,
) {
  const extension = path.extname(sourceFileName).toLowerCase();
  if (extension !== ".zip") {
    if (!textExtensions.has(extension)) {
      throw new Error("知识库文件仅支持 ZIP、Markdown、TXT、JSON 或 CSV");
    }
    return {
      documents: [
        {
          path: safeArchivePath(sourceFileName),
          title: titleFromPath(sourceFileName),
          content: normalizeTextDocument(
            sourceFileName,
            buffer.toString("utf8"),
          ),
        },
      ] as KnowledgeDocument[],
      assets: [] as KnowledgeAsset[],
      storedAssetKeys: [] as string[],
    };
  }

  if (
    buffer.length < 4 ||
    (buffer.subarray(0, 4).toString("binary") !== "PK\u0003\u0004" &&
      buffer.subarray(0, 4).toString("binary") !== "PK\u0005\u0006" &&
      buffer.subarray(0, 4).toString("binary") !== "PK\u0007\u0008")
  ) {
    throw new Error("知识库文件不是有效的 ZIP 压缩包");
  }
  const archive = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(
      `知识库压缩包文件过多，最多支持 ${MAX_ARCHIVE_ENTRIES} 个文件`,
    );
  }
  const documents: KnowledgeDocument[] = [];
  const assets: KnowledgeAsset[] = [];
  const storedAssetKeys: string[] = [];
  let unpackedBytes = 0;
  let declaredUnpackedBytes = 0;
  await mkdir(storageRoot, { recursive: true });

  try {
    const normalizedPaths = new Set<string>();
    const packagePaths: string[] = [];
    for (const entry of entries) {
      const rawPath =
        (entry as typeof entry & { unsafeOriginalName?: string })
          .unsafeOriginalName || entry.name;
      if (
        rawPath.startsWith("__MACOSX/") ||
        rawPath === ".DS_Store" ||
        rawPath.endsWith("/.DS_Store")
      ) {
        continue;
      }
      const archivePath = validateArchiveEntryPath(rawPath);
      const normalizedKey = archivePath.normalize("NFKC").toLowerCase();
      if (normalizedPaths.has(normalizedKey)) {
        throw new Error(`知识库 ZIP 包含重复文件：${archivePath}`);
      }
      normalizedPaths.add(normalizedKey);
      packagePaths.push(archivePath);
      const fileExtension = path.extname(archivePath).toLowerCase();
      if (fileExtension === ".html" || fileExtension === ".htm") {
        throw new Error("知识库 ZIP 不允许包含 HTML 或交互式网页文件");
      }
      const unixPermissions =
        typeof entry.unixPermissions === "number"
          ? entry.unixPermissions
          : Number.parseInt(String(entry.unixPermissions || ""), 8);
      if (
        Number.isFinite(unixPermissions) &&
        (unixPermissions & 0o170000) === 0o120000
      ) {
        throw new Error("知识库 ZIP 不允许包含符号链接");
      }
      const declaredCompressed = Number(
        (
          entry as typeof entry & {
            _data?: { compressedSize?: number; uncompressedSize?: number };
          }
        )._data?.compressedSize || 0,
      );
      const declaredUncompressed = Number(
        (
          entry as typeof entry & {
            _data?: { compressedSize?: number; uncompressedSize?: number };
          }
        )._data?.uncompressedSize || 0,
      );
      const declaredLimit = imageMimeByExtension[fileExtension]
        ? MAX_IMAGE_BYTES
        : MAX_DOCUMENT_BYTES;
      if (declaredUncompressed > declaredLimit) {
        throw new Error(`知识库文件过大：${archivePath}`);
      }
      declaredUnpackedBytes += Math.max(0, declaredUncompressed);
      if (declaredUnpackedBytes > MAX_UNPACKED_BYTES) {
        throw new Error("知识库解压后内容过大，最多支持 220 MB");
      }
      if (
        declaredUncompressed > 1024 * 1024 &&
        declaredCompressed > 0 &&
        declaredUncompressed / declaredCompressed > MAX_COMPRESSION_RATIO
      ) {
        throw new Error(`知识库 ZIP 中的文件压缩比异常：${archivePath}`);
      }
      const mimeType = imageMimeByExtension[fileExtension];
      if (!textExtensions.has(fileExtension) && !mimeType) continue;
      const bytes = await entry.async("nodebuffer");
      unpackedBytes += bytes.length;
      if (unpackedBytes > MAX_UNPACKED_BYTES) {
        throw new Error("知识库解压后内容过大，最多支持 220 MB");
      }
      if (mimeType) {
        if (bytes.length > MAX_IMAGE_BYTES) {
          throw new Error(`知识库图片过大：${archivePath}`);
        }
        if (!isSupportedImageBytes(fileExtension, bytes)) {
          throw new Error(`知识库图片格式与内容不匹配：${archivePath}`);
        }
        const key = `${randomUUID()}${fileExtension}`;
        await writeFile(path.join(storageRoot, key), bytes, { flag: "wx" });
        storedAssetKeys.push(key);
        assets.push({ key, path: archivePath, mimeType, size: bytes.length });
      } else {
        if (bytes.length > MAX_DOCUMENT_BYTES) {
          throw new Error(`知识库文档过大：${archivePath}`);
        }
        documents.push({
          path: archivePath,
          title: titleFromPath(archivePath),
          content: normalizeTextDocument(archivePath, bytes.toString("utf8")),
        });
      }
    }

    const roots = new Set(
      packagePaths.map((entryPath) => entryPath.split("/")[0]),
    );
    if (
      roots.size !== 1 ||
      packagePaths.some((entryPath) => !entryPath.includes("/"))
    ) {
      throw new Error("知识库 ZIP 必须只包含一个企业知识库根目录");
    }
    const root = [...roots][0]!;
    const lowerPaths = new Set(
      packagePaths.map((entryPath) => entryPath.toLowerCase()),
    );
    const missingRequired = requiredKnowledgeFiles.filter(
      (requiredPath) =>
        !lowerPaths.has(`${root}/${requiredPath}`.toLowerCase()),
    );
    if (missingRequired.length > 0) {
      throw new Error(`知识库 ZIP 缺少标准文件：${missingRequired.join("、")}`);
    }
    if (documents.length === 0) {
      throw new Error("压缩包中没有可展示的 Markdown、TXT、JSON 或 CSV 文档");
    }
    const linkedDocuments = documents.map((document) => {
      let content = document.content;
      assets.forEach((asset, index) => {
        const url = `/api/dashboard/knowledge/assets/${snapshotId}/${index}`;
        const relativePath = path.posix.relative(
          path.posix.dirname(document.path),
          asset.path,
        );
        const candidates = [
          asset.path,
          encodeURI(asset.path),
          relativePath,
          encodeURI(relativePath),
          path.basename(asset.path),
        ];
        for (const candidate of candidates) {
          content = content.replaceAll(`(${candidate})`, `(${url})`);
          content = content.replaceAll(`(./${candidate})`, `(${url})`);
        }
      });
      return { ...document, content };
    });
    return { documents: linkedDocuments, assets, storedAssetKeys };
  } catch (error) {
    await Promise.all(
      storedAssetKeys.map((key) =>
        unlink(path.join(storageRoot, key)).catch(() => undefined),
      ),
    );
    throw error;
  }
}

function normalizedEnterpriseEvidence(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

export function assertKnowledgeArchiveEnterpriseIdentity(input: {
  enterpriseIdentityConfirmed: boolean;
  brandName: string;
  documents: KnowledgeDocument[];
}) {
  const brandName = normalizedEnterpriseEvidence(input.brandName);
  if (!input.enterpriseIdentityConfirmed || !brandName) {
    throw new Error("请先由管理员配置并发布当前账号的企业名称");
  }
  const identityDocuments = input.documents.filter((document) => {
    const basename = path.posix.basename(document.path).toLowerCase();
    return (
      basename === "readme.md" ||
      basename === "00_knowledge_tree.md" ||
      basename === "00_source_index.md"
    );
  });
  const candidates =
    identityDocuments.length > 0 ? identityDocuments : input.documents;
  const matches = candidates.some((document) =>
    normalizedEnterpriseEvidence(
      `${document.title}\n${document.content}`,
    ).includes(brandName),
  );
  if (!matches) {
    throw new Error(
      `知识库包未声明当前账号绑定企业“${input.brandName}”，请核对目标用户后重新上传`,
    );
  }
}

function upstreamHeaders(apiKey: string) {
  return {
    API_KEY: apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
}

export async function downloadArchiveBytes(input: {
  descriptor: KnowledgeArchiveDescriptor;
  apiKey: string;
  baseUrl: string;
}) {
  let filename = input.descriptor.filename;
  let downloadUrl: string | undefined;
  let headers: Record<string, string> | undefined;
  const fileId =
    input.descriptor.fileId ||
    (input.descriptor.url
      ? knowledgeArchiveFileIdFromUrl(input.descriptor.url)
      : undefined);

  if (fileId) {
    const metadataResponse = await axios.get(
      `${input.baseUrl}/v1/files/${encodeURIComponent(fileId)}`,
      {
        headers: upstreamHeaders(input.apiKey),
        proxy: false,
        timeout: 120_000,
        maxContentLength: 2 * 1024 * 1024,
        validateStatus: () => true,
      },
    );
    if (metadataResponse.status !== 200) {
      throw new Error(`读取知识库文件信息失败 (${metadataResponse.status})`);
    }
    const returnedFileId = String(
      metadataResponse.data?.id || metadataResponse.data?.file_id || "",
    );
    if (returnedFileId && returnedFileId !== fileId) {
      throw new Error("读取到的知识库文件与最终版本不匹配");
    }
    if (metadataResponse.data?.filename) {
      filename = String(metadataResponse.data.filename);
    }
    if (metadataResponse.data?.upload_url) {
      downloadUrl = assertSafeExternalUrl(
        String(metadataResponse.data.upload_url),
      );
    } else {
      downloadUrl = `${input.baseUrl}/v1/files/${encodeURIComponent(fileId)}/content`;
      headers = upstreamHeaders(input.apiKey);
    }
  } else if (input.descriptor.url) {
    downloadUrl = assertSafeExternalUrl(input.descriptor.url);
  }

  if (!downloadUrl) throw new Error("知识库文件没有可验证的下载地址");
  const controller = new AbortController();
  let response = await axios.get(downloadUrl, {
    ...(headers
      ? { maxRedirects: 0, proxy: false as const }
      : safeExternalRequestOptions),
    headers,
    responseType: "stream",
    timeout: 120_000,
    maxContentLength: MAX_ARCHIVE_BYTES,
    signal: controller.signal,
    validateStatus: () => true,
  });
  if (
    headers &&
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.location
  ) {
    const redirectUrl = assertSafeExternalUrl(
      new URL(String(response.headers.location), downloadUrl).toString(),
    );
    response = await axios.get(redirectUrl, {
      ...safeExternalRequestOptions,
      responseType: "stream",
      timeout: 120_000,
      maxContentLength: MAX_ARCHIVE_BYTES,
      signal: controller.signal,
      validateStatus: () => true,
    });
  }
  if (response.status !== 200) {
    response.data?.destroy?.();
    throw new Error(`下载知识库 ZIP 失败 (${response.status})`);
  }
  const declaredLength = Number(response.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
    response.data?.destroy?.();
    throw new Error("知识库 ZIP 超过 250 MB");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let lastProgressAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastProgressAt >= 120_000) {
      controller.abort();
    }
  }, 10_000);
  watchdog.unref();
  try {
    for await (const rawChunk of response.data as AsyncIterable<
      Buffer | Uint8Array | string
    >) {
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk);
      totalBytes += chunk.length;
      if (totalBytes > MAX_ARCHIVE_BYTES) {
        controller.abort();
        throw new Error("知识库 ZIP 超过 250 MB");
      }
      chunks.push(chunk);
      lastProgressAt = Date.now();
    }
  } finally {
    clearInterval(watchdog);
  }
  const buffer = Buffer.concat(chunks, totalBytes);
  if (buffer.length === 0) throw new Error("知识库 ZIP 内容为空");
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new Error("知识库 ZIP 超过 250 MB");
  }
  if (!filename.toLowerCase().endsWith(".zip")) {
    filename = `${path.basename(filename, path.extname(filename)) || "knowledge-base"}.zip`;
  }
  return { buffer, filename };
}

function bodyBuffer(req: express.Request) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return Buffer.alloc(0);
}

router.use(requireExpressAuth);

router.get(
  "/monitoring-template/:userId",
  async (req: FrontMindRequest, res) => {
    const targetUserId = Number(req.params.userId);
    try {
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        throw new Error("用户 ID 无效");
      }
      const actor = req.frontmindUser!;
      const [workspace, batches] = await Promise.all([
        getDashboardWorkspace(targetUserId),
        getMonitoringCurrentTemplateBatches({
          actor,
          userId: targetUserId,
        }),
      ]);
      const template = dashboardMonitoringCurrentTemplateSchema.parse({
        ...createDashboardModuleTemplateMetadata({
          module: "monitoring",
          revision: workspace.revision,
        }),
        workspaceUserId: targetUserId,
        batches,
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="frontmind-monitoring-current-${targetUserId}-R${workspace.revision}.json"`,
      );
      res.send(Buffer.from(JSON.stringify(template, null, 2), "utf8"));
    } catch (error) {
      res
        .status(
          error instanceof ServiceEntitlementError
            ? error.statusCode
            : error instanceof DashboardRevisionConflictError
              ? 409
              : 400,
        )
        .json({
          error: {
            code: "MONITORING_TEMPLATE_DOWNLOAD_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "问题监控当前内容模板下载失败",
          },
        });
    }
  },
);

router.put(
  "/report-assets/:userId",
  express.raw({ type: "application/octet-stream", limit: "12mb" }),
  async (req: FrontMindRequest, res) => {
    const actor = req.frontmindUser!;
    const targetUserId = Number(req.params.userId);
    try {
      if (actor.role !== "admin") {
        throw new Error("只有管理员可以上传进度报告截图");
      }
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        throw new Error("用户 ID 无效");
      }
      await assertWorkspaceAccess(actor, targetUserId);
      const bytes = bodyBuffer(req);
      if (bytes.length === 0) throw new Error("答案截图文件为空");
      const filename = decodeHeader(
        req.header("x-file-name"),
        "answer-screenshot",
      );
      const { extension, mimeType } = validateProgressReportScreenshot({
        filename,
        bytes,
      });
      const assetName = `${randomUUID()}${extension}`;
      const relativeKey = path.join(
        "progress-report-screenshots",
        String(targetUserId),
        assetName,
      );
      const absolutePath = path.join(storageRoot, relativeKey);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, bytes, { flag: "wx" });
      const url = `/api/dashboard/report-assets/${targetUserId}/${assetName}`;
      await writeWorkspaceAuditEvent({
        actor,
        action: "workspace.progress_report.screenshot_uploaded",
        targetType: "dashboard",
        targetId: targetUserId,
        workspaceUserId: targetUserId,
        metadata: {
          filename,
          mimeType,
          byteLength: bytes.length,
          assetName,
        },
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ id: assetName, url, filename, mimeType });
    } catch (error) {
      console.error("[Dashboard] Report screenshot upload failed", error);
      res.status(400).json({
        error: {
          code: "REPORT_SCREENSHOT_UPLOAD_FAILED",
          message: error instanceof Error ? error.message : "答案截图上传失败",
        },
      });
    }
  },
);

router.get(
  "/report-assets/:userId/:assetName",
  async (req: FrontMindRequest, res) => {
    const targetUserId = Number(req.params.userId);
    const assetName = String(req.params.assetName || "");
    try {
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        throw new Error("资源不存在");
      }
      if (
        !/^[0-9a-f-]{36}\.(?:png|jpe?g|webp)$/i.test(assetName) ||
        assetName.includes("..")
      ) {
        throw new Error("资源不存在");
      }
      await assertWorkspaceAccess(req.frontmindUser!, targetUserId);
      const extension = path.extname(assetName).toLowerCase();
      const mimeType = imageMimeByExtension[extension];
      if (!mimeType) throw new Error("资源不存在");
      const bytes = await readFile(
        path.join(
          storageRoot,
          "progress-report-screenshots",
          String(targetUserId),
          assetName,
        ),
      );
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("Content-Disposition", "inline");
      res.send(bytes);
    } catch {
      res
        .status(404)
        .json({ error: { message: "资源不存在", code: "NOT_FOUND" } });
    }
  },
);

router.post("/knowledge/publish", async (req: FrontMindRequest, res) => {
  const actor = req.frontmindUser!;
  const body = (req.body || {}) as {
    conversationId?: string;
    userId?: number;
  };
  const targetUserId =
    body.userId === undefined ? actor.id : Number(body.userId);
  const conversationId = String(body.conversationId || "").trim();
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    res.status(400).json({
      error: { message: "用户 ID 无效", code: "BAD_REQUEST" },
    });
    return;
  }
  if (!conversationId) {
    res.status(400).json({
      error: { message: "缺少知识库对话标识", code: "BAD_REQUEST" },
    });
    return;
  }

  let storedAssetKeys: string[] = [];
  try {
    await assertWorkspaceAccess(actor, targetUserId);
    await assertServiceCapability(targetUserId, "knowledgeBuild");
    const build = await assertKnowledgeBasePublishable({
      userId: targetUserId,
      conversationId,
    });
    const taskId = String(build.packageTaskId || "");
    if (
      !taskId ||
      taskId !== build.upstreamTaskId ||
      build.packageRevision !== build.revision ||
      !build.packageOutputItemId ||
      !build.packageDescriptorHash
    ) {
      throw new Error("最终知识库文件尚未与当前完成版本绑定");
    }
    const credential = await getCredentialForUpstreamResource(
      targetUserId,
      "task",
      taskId,
    );
    if (!credential)
      throw new Error("知识库任务不属于当前用户或 API Key 已失效");

    const baseUrl = getUpstreamBaseUrl(req);
    const taskResponse = await axios.get(
      `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`,
      {
        headers: upstreamHeaders(credential.apiKey),
        proxy: false,
        timeout: 120_000,
        maxContentLength: 50 * 1024 * 1024,
        validateStatus: () => true,
      },
    );
    if (taskResponse.status !== 200) {
      throw new Error(`读取知识库任务结果失败 (${taskResponse.status})`);
    }
    const task = taskResponse.data?.task || taskResponse.data || {};
    const returnedTaskId = String(task.id || task.task_id || "");
    if (returnedTaskId !== taskId) {
      throw new Error("读取到的知识库任务与当前完成版本不匹配");
    }
    if (task.status !== "completed") {
      throw new Error(
        task.status === "failed" || task.status === "error"
          ? "知识库任务执行失败，无法发布"
          : "知识库任务仍在处理中",
      );
    }
    const output = Array.isArray(task.output) ? task.output : [];
    const matchingDescriptors = collectKnowledgeArchiveDescriptors(
      output,
    ).filter(
      (candidate) =>
        candidate.outputItemId === build.packageOutputItemId &&
        knowledgeArchiveDescriptorHash(candidate) ===
          build.packageDescriptorHash &&
        (!build.packageFileId || candidate.fileId === build.packageFileId),
    );
    if (matchingDescriptors.length !== 1) {
      throw new Error("任务结果中无法唯一确认当前版本的知识库 ZIP");
    }
    const descriptor = matchingDescriptors[0]!;

    const downloaded = await downloadArchiveBytes({
      descriptor,
      apiKey: credential.apiKey,
      baseUrl,
    });
    const archiveHash = createHash("sha256")
      .update(downloaded.buffer)
      .digest("hex");
    const snapshotId = randomUUID();
    const parsed = await readKnowledgeArchive(
      downloaded.buffer,
      downloaded.filename,
      snapshotId,
    );
    storedAssetKeys = parsed.storedAssetKeys;
    const workspace = await getDashboardWorkspace(targetUserId);
    assertKnowledgeArchiveEnterpriseIdentity({
      enterpriseIdentityConfirmed: Boolean(workspace.enterpriseIdentityBoundAt),
      brandName: workspace.payload.brandName,
      documents: parsed.documents,
    });
    const snapshot = await createKnowledgeSnapshot({
      snapshotId,
      userId: targetUserId,
      actorUserId: actor.id,
      sourceFileName: downloaded.filename,
      sourceConversationId: conversationId,
      sourceBuildId: build.id,
      sourceBuildRevision: build.revision,
      sourceTaskId: taskId,
      sourceArtifactHash: build.packageDescriptorHash,
      archiveHash,
      documents: parsed.documents,
      assets: parsed.assets,
      totalBytes: downloaded.buffer.length,
    });
    res.json({ kind: "knowledge", snapshot });
  } catch (error) {
    await Promise.all(
      storedAssetKeys.map((key) =>
        unlink(path.join(storageRoot, key)).catch(() => undefined),
      ),
    );
    console.error("[Dashboard] Knowledge publish failed", error);
    res
      .status(error instanceof ServiceEntitlementError ? error.statusCode : 400)
      .json({
        error: {
          message: error instanceof Error ? error.message : "无法发布知识库",
          code:
            error instanceof ServiceEntitlementError
              ? error.code
              : "KNOWLEDGE_PUBLISH_FAILED",
        },
      });
  }
});

router.put(
  "/import/:userId",
  express.raw({ type: "application/octet-stream", limit: "250mb" }),
  async (req: FrontMindRequest, res) => {
    const actor = req.frontmindUser!;
    const targetUserId =
      req.params.userId === "me" ? actor.id : Number(req.params.userId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      res
        .status(400)
        .json({ error: { message: "用户 ID 无效", code: "BAD_REQUEST" } });
      return;
    }
    try {
      await assertWorkspaceAccess(actor, targetUserId);
      const buffer = bodyBuffer(req);
      if (buffer.length === 0) throw new Error("上传文件为空");
      const sourceFileName = decodeHeader(
        req.header("x-file-name"),
        "dashboard.json",
      );
      const fileHash = monitoringImportFileHash(buffer);
      const importPreview =
        String(req.header("x-import-preview") || "").toLowerCase() === "true";
      const sourceConversationId =
        req.header("x-conversation-id")?.trim() || undefined;
      const expectedRevision = dashboardRevisionHeader(
        req.header("x-dashboard-revision"),
      );
      const extension = path.extname(sourceFileName).toLowerCase();
      const mode = req.header("x-import-mode") || "auto";
      const mayEditDashboard = actor.role === "admin";
      if (
        mode === "dashboard" ||
        (mode === "auto" && [".csv", ".json", ".xlsx"].includes(extension))
      ) {
        if (!mayEditDashboard) throw new Error("用户账号不能直接发布看板数据");
        const existing = await getDashboardWorkspace(targetUserId);
        assertDashboardImportRevision({
          expectedRevision,
          currentRevision: existing.revision,
        });
        const importModule = dashboardImportModule(
          req.header("x-dashboard-module"),
        );
        assertDashboardImportModuleEnabled(importModule);
        const sectionIdHeader =
          importModule === "section-table"
            ? String(req.header("x-dashboard-section-id") || "").trim()
            : undefined;
        const targetBatchKeyHeader =
          importModule === "monitoring"
            ? String(
                req.header("x-monitoring-target-batch-key") || "",
              ).trim() || undefined
            : undefined;
        if (!importPreview) {
          assertDashboardImportPublishHash({
            module: importModule,
            fileHash,
            expectedFileHash:
              importModule === "monitoring"
                ? req.header("x-monitoring-file-hash") ||
                  req.header("x-import-file-hash")
                : req.header("x-import-file-hash"),
          });
        }
        const servicePortal = await assertServiceCapability(
          targetUserId,
          importModule === "monitoring"
            ? "monitoring"
            : importModule === "response-logic"
              ? "responseLogic"
              : importModule === "questions"
                ? "questionSelection"
                : importModule === "keywords"
                  ? "globalKeywords"
                  : importModule === "optimization-report"
                    ? "progressReport"
                    : "contentAssets",
        );
        if (![".csv", ".json", ".xlsx"].includes(extension)) {
          throw new Error("看板板块仅支持 CSV、XLSX 或 JSON");
        }
        if (
          [
            "profile",
            "metrics",
            "sections",
            "keywords",
            "questions",
            "response-logic",
            "content-assets",
          ].includes(importModule) &&
          extension !== ".json"
        ) {
          throw new Error("该模块只接受下载后保留修订号的 JSON 当前内容模板");
        }
        if (importModule === "optimization-report" && extension !== ".json") {
          throw new Error("进度报告仅支持带修订号的 JSON 当前内容模板");
        }
        if (!existing.enterpriseIdentityBoundAt && importModule !== "profile") {
          throw new Error(
            "请先由管理员确认并发布当前账号的企业名称，再上传其他内容板块",
          );
        }
        if (importModule === "response-logic") {
          if (extension === ".json") {
            parseDashboardModuleTemplateMetadata({
              raw: JSON.parse(buffer.toString("utf8")),
              expectedModule: "response-logic",
              currentRevision: existing.revision,
            });
          }
          const values = await responseLogicImportsFromFile({
            buffer,
            sourceFileName,
            existing: dashboardPayloadWithServiceQuestionCatalog({
              payload: existing.payload,
              questions: servicePortal.purchasedQuestions,
            }),
          });
          for (const value of values) {
            if (value.publish) {
              assertResponseLogicDraftPublishable(value.draft);
            }
          }
          if (importPreview) {
            const currentRecords = await listResponseLogicEntries(targetUserId);
            const preview = buildResponseLogicImportPreview({
              current: currentRecords,
              incoming: values,
              sourceName: sourceFileName,
              fileHash,
              templateRevision: existing.revision,
            });
            const credential = await issueDashboardImportPreflight({
              binding: {
                actorId: actor.id,
                workspaceUserId: targetUserId,
                module: "response-logic",
                revision: existing.revision,
                fileHash,
              },
            });
            res.json({
              kind: "dashboard-module-preview",
              preview: {
                ...preview,
                ...credential,
              },
            });
            return;
          }
          const records = await saveResponseLogicEntriesBatch({
            userId: targetUserId,
            entries: values.map(({ expectedRevision, ...value }) => ({
              expectedRevision,
              value,
            })),
            beforeWrite: async (tx) => {
              const dashboardRows = await tx
                .select({ revision: userDashboardContents.revision })
                .from(userDashboardContents)
                .where(eq(userDashboardContents.userId, targetUserId))
                .limit(1)
                .for("update");
              assertDashboardImportRevision({
                expectedRevision,
                currentRevision: dashboardRows[0]?.revision ?? 0,
              });
              await consumeDashboardImportPreflight({
                token: req.header("x-import-preflight-token"),
                binding: {
                  actorId: actor.id,
                  workspaceUserId: targetUserId,
                  module: "response-logic",
                  revision: expectedRevision!,
                  fileHash,
                },
                store: dashboardImportPreflightStoreForExecutor(tx),
              });
            },
            afterWrite: async (tx, savedRecords = []) => {
              await writeWorkspaceAuditEvent(
                {
                  actor,
                  action: "workspace.response_logic.imported",
                  targetType: "response_logic",
                  targetId: targetUserId,
                  workspaceUserId: targetUserId,
                  metadata: {
                    sourceName: sourceFileName,
                    recordCount: savedRecords.length,
                    publishedCount: values.filter((value) => value.publish)
                      .length,
                    revisions: savedRecords.map((record) => ({
                      questionId: record.questionId,
                      revision: record.revision,
                    })),
                  },
                },
                tx,
              );
            },
          });
          res.json({
            kind: "response-logic",
            module: importModule,
            records,
          });
          return;
        }
        if (importModule === "questions") {
          if (extension !== ".json") {
            throw new Error(
              "正式问题目录只支持带逐题修订号的 JSON 当前内容模板",
            );
          }
          const template = parseAuthoritativeQuestionsTemplate({
            raw: JSON.parse(buffer.toString("utf8")),
            currentRevision: existing.revision,
            currentQuestions: servicePortal.purchasedQuestions,
          });
          const preview = buildAuthoritativeQuestionsImportPreview({
            sourceName: sourceFileName,
            fileHash,
            templateRevision: existing.revision,
            current: servicePortal.purchasedQuestions,
            incoming: template.questions,
          });
          if (importPreview) {
            const credential = await issueDashboardImportPreflight({
              binding: {
                actorId: actor.id,
                workspaceUserId: targetUserId,
                module: "questions",
                revision: existing.revision,
                fileHash,
              },
            });
            res.json({
              kind: "dashboard-module-preview",
              preview: {
                ...preview,
                ...credential,
              },
            });
            return;
          }
          const questions = await updateWorkspaceQuestionsByAdminBatch({
            userId: targetUserId,
            actorUserId: actor.id,
            entries: template.questions.map((question) => ({
              questionId: question.id,
              expectedRevision: question.revision,
              category: question.category,
              question: question.question,
              intent: question.intent,
              rationale: question.rationale,
            })),
            beforeWrite: async (tx) => {
              const dashboardRows = await tx
                .select({ revision: userDashboardContents.revision })
                .from(userDashboardContents)
                .where(eq(userDashboardContents.userId, targetUserId))
                .limit(1)
                .for("update");
              assertDashboardImportRevision({
                expectedRevision,
                currentRevision: dashboardRows[0]?.revision ?? 0,
              });
              await consumeDashboardImportPreflight({
                token: req.header("x-import-preflight-token"),
                binding: {
                  actorId: actor.id,
                  workspaceUserId: targetUserId,
                  module: "questions",
                  revision: expectedRevision!,
                  fileHash,
                },
                store: dashboardImportPreflightStoreForExecutor(tx),
              });
            },
            afterWrite: async (tx, updatedQuestions = []) => {
              await writeWorkspaceAuditEvent(
                {
                  actor,
                  action: "workspace.questions.template_imported",
                  targetType: "workspace_question",
                  targetId: targetUserId,
                  workspaceUserId: targetUserId,
                  metadata: {
                    sourceName: sourceFileName,
                    recordCount: template.questions.length,
                    updatedCount: updatedQuestions.length,
                    questionIds: updatedQuestions.map(
                      (question) => question.id,
                    ),
                  },
                },
                tx,
              );
            },
          });
          res.json({
            kind: "questions",
            module: importModule,
            questions,
          });
          return;
        }
        if (importModule === "monitoring" && extension === ".json") {
          const currentBatches = await getMonitoringCurrentTemplateBatches({
            actor,
            userId: targetUserId,
          });
          const { template, changedBatchCount } =
            parseMonitoringCurrentTemplate({
              raw: JSON.parse(buffer.toString("utf8")),
              currentRevision: existing.revision,
              workspaceUserId: targetUserId,
              currentBatches,
            });
          const preview = buildMonitoringCurrentTemplatePreview({
            template,
            changedBatchCount,
            sourceName: sourceFileName,
            fileHash,
            templateRevision: existing.revision,
          });
          if (importPreview) {
            const credential = await issueDashboardImportPreflight({
              binding: {
                actorId: actor.id,
                workspaceUserId: targetUserId,
                module: "monitoring",
                revision: existing.revision,
                fileHash,
              },
            });
            res.json({
              kind: "monitoring-preview",
              preview: {
                ...preview,
                ...credential,
              },
            });
            return;
          }
          const batches = await replaceMonitoringCurrentTemplateBatches({
            actor,
            userId: targetUserId,
            batches: template.batches,
            beforeWrite: async (tx) => {
              const dashboardRows = await tx
                .select({ revision: userDashboardContents.revision })
                .from(userDashboardContents)
                .where(eq(userDashboardContents.userId, targetUserId))
                .limit(1)
                .for("update");
              assertDashboardImportRevision({
                expectedRevision,
                currentRevision: dashboardRows[0]?.revision ?? 0,
              });
              await consumeDashboardImportPreflight({
                token: req.header("x-import-preflight-token"),
                binding: {
                  actorId: actor.id,
                  workspaceUserId: targetUserId,
                  module: "monitoring",
                  revision: expectedRevision!,
                  fileHash,
                },
                store: dashboardImportPreflightStoreForExecutor(tx),
              });
            },
            afterWrite: async (tx, updatedBatches = []) => {
              await writeWorkspaceAuditEvent(
                {
                  actor,
                  action: "workspace.monitoring.template_imported",
                  targetType: "monitoring_batch",
                  targetId: targetUserId,
                  workspaceUserId: targetUserId,
                  metadata: {
                    sourceName: sourceFileName,
                    fileHash,
                    changedBatchCount: updatedBatches.length,
                    batches: updatedBatches,
                  },
                },
                tx,
              );
            },
          });
          res.json({
            kind: "monitoring",
            module: importModule,
            batches,
          });
          return;
        }
        if (importModule === "section-table") {
          if (extension === ".json") {
            throw new Error("板块表格请上传 CSV 或 XLSX");
          }
          const sectionId = sectionIdHeader || "";
          const targetSection = existing.payload.sections.find(
            (section) => section.id === sectionId,
          );
          if (!targetSection) throw new Error("没有找到要更新的内容板块");
          const tables = await tabularTablesFromFile({
            buffer,
            sourceFileName,
          });
          if (tables.length === 0) throw new Error("上传文件中没有可展示表格");
          const payload = dashboardPayloadSchema.parse({
            ...existing.payload,
            sections: existing.payload.sections.map((section) =>
              section.id === sectionId ? { ...section, tables } : section,
            ),
          });
          if (importPreview) {
            const credential = await issueDashboardImportPreflight({
              binding: {
                actorId: actor.id,
                workspaceUserId: targetUserId,
                module: "section-table",
                revision: existing.revision,
                fileHash,
                sectionId,
              },
            });
            res.json({
              kind: "dashboard-module-preview",
              preview: {
                ...buildDashboardModuleImportPreview({
                  module: "section-table",
                  current: existing.payload,
                  incoming: payload,
                  sourceName: sourceFileName,
                  fileHash,
                  templateRevision: existing.revision,
                  sectionId,
                }),
                ...credential,
              },
            });
            return;
          }
          const dashboard = await updateDashboardWorkspace({
            userId: targetUserId,
            actorUserId: actor.id,
            payload,
            sourceName: sourceFileName,
            expectedRevision,
            ...dashboardImportTransactionHooks({
              actor,
              targetUserId,
              module: "section-table",
              expectedRevision: expectedRevision!,
              fileHash,
              preflightToken: req.header("x-import-preflight-token"),
              sourceFileName,
              sectionId,
            }),
          });
          res.json({ kind: "dashboard", module: importModule, dashboard });
          return;
        }
        let payload: DashboardPayload;
        try {
          payload =
            importModule === "keywords" && extension !== ".json"
              ? dashboardPayloadSchema.parse({
                  ...existing.payload,
                  keywordTables: await tabularTablesFromFile({
                    buffer,
                    sourceFileName,
                  }),
                })
              : await dashboardPayloadFromFile({
                  buffer,
                  sourceFileName,
                  existing:
                    importModule === "monitoring"
                      ? dashboardPayloadWithServiceQuestionCatalog({
                          payload: existing.payload,
                          // Monitoring rows belong to the formally purchased
                          // question catalog. The dashboard content copy can be
                          // empty or stale and must never decide whether a real
                          // monitoring export is accepted.
                          questions: servicePortal.purchasedQuestions,
                        })
                      : existing.payload,
                  module: importModule,
                  currentRevision: existing.revision,
                });
        } catch (error) {
          if (importModule !== "monitoring" || !importPreview) throw error;
          const available = await getMonitoringFilterOptions(
            targetUserId,
            servicePortal.quotaPeriods.map((period) => period.periodId),
          );
          res.json({
            kind: "monitoring-preview",
            preview: {
              module: "monitoring",
              mode: "invalid",
              sourceName: sourceFileName,
              fileHash,
              templateRevision: existing.revision,
              summary: ["文件未通过格式校验，不能发布。"],
              targetBatchRequired: false,
              availableBatches: available.batches,
              questions: [],
              models: [],
              dates: [],
              sampleCount: 0,
              citationCount: 0,
              exactLinked: 0,
              issues: [
                {
                  severity: "error",
                  code: "MONITORING_IMPORT_INVALID",
                  message:
                    error instanceof Error
                      ? error.message
                      : "无法识别监控导入文件",
                },
              ],
            } satisfies MonitoringImportPreview,
          });
          return;
        }
        if (importModule === "monitoring") {
          const monitoringBatch = buildDashboardMonitoringImport({
            targetUserId,
            payload,
            sourceFileName,
            sourceHash: fileHash,
          });
          if (!monitoringBatch) {
            if (importPreview) {
              const available = await getMonitoringFilterOptions(
                targetUserId,
                servicePortal.quotaPeriods.map((period) => period.periodId),
              );
              res.json({
                kind: "monitoring-preview",
                preview: {
                  module: "monitoring",
                  mode: "invalid",
                  sourceName: sourceFileName,
                  fileHash,
                  templateRevision: existing.revision,
                  summary: ["文件中没有可发布的监控答案或引用记录。"],
                  targetBatchRequired: false,
                  availableBatches: available.batches,
                  questions: [],
                  models: [],
                  dates: [],
                  sampleCount: 0,
                  citationCount: 0,
                  exactLinked: 0,
                  issues: [
                    {
                      severity: "error",
                      code: "MONITORING_IMPORT_EMPTY",
                      message: "文件中没有可发布的监控答案或引用记录",
                    },
                  ],
                } satisfies MonitoringImportPreview,
              });
              return;
            }
            throw new Error("文件中没有可发布的监控答案或引用记录");
          }
          const available = await getMonitoringFilterOptions(
            targetUserId,
            servicePortal.quotaPeriods.map((period) => period.periodId),
          );
          const preview = buildMonitoringImportPreview({
            payload,
            batch: monitoringBatch,
            sourceName: sourceFileName,
            fileHash,
            templateRevision: existing.revision,
            availableBatches: available.batches,
          });
          if (importPreview) {
            let boundTargetBatchKey = targetBatchKeyHeader;
            if (boundTargetBatchKey) {
              const allowedTarget = available.batches.some(
                (batch) =>
                  batch.batchKey === boundTargetBatchKey &&
                  batch.sampleCount > 0,
              );
              if (!allowedTarget) {
                throw new MonitoringTargetBatchRequiredError();
              }
            }
            if (preview.targetBatchRequired && !boundTargetBatchKey) {
              boundTargetBatchKey = preview.suggestedBatchKey;
            }
            const credential =
              !preview.targetBatchRequired || boundTargetBatchKey
                ? await issueDashboardImportPreflight({
                    binding: {
                      actorId: actor.id,
                      workspaceUserId: targetUserId,
                      module: "monitoring",
                      revision: existing.revision,
                      fileHash,
                      ...(boundTargetBatchKey
                        ? { targetBatchKey: boundTargetBatchKey }
                        : {}),
                    },
                  })
                : undefined;
            res.json({
              kind: "monitoring-preview",
              preview: {
                ...preview,
                ...(boundTargetBatchKey
                  ? { preflightTargetBatchKey: boundTargetBatchKey }
                  : {}),
                ...(credential ?? {}),
              },
            });
            return;
          }
          const targetBatchKey = targetBatchKeyHeader || "";
          if (preview.targetBatchRequired && !targetBatchKey) {
            throw new MonitoringTargetBatchRequiredError();
          }
          const transactionHooks = {
            beforeWrite: async (tx: any) => {
              const dashboardRows = await tx
                .select({ revision: userDashboardContents.revision })
                .from(userDashboardContents)
                .where(eq(userDashboardContents.userId, targetUserId))
                .limit(1)
                .for("update");
              assertDashboardImportRevision({
                expectedRevision,
                currentRevision: dashboardRows[0]?.revision ?? 0,
              });
              await consumeDashboardImportPreflight({
                token: req.header("x-import-preflight-token"),
                binding: {
                  actorId: actor.id,
                  workspaceUserId: targetUserId,
                  module: "monitoring",
                  revision: expectedRevision!,
                  fileHash,
                  ...(preview.targetBatchRequired ? { targetBatchKey } : {}),
                },
                store: dashboardImportPreflightStoreForExecutor(tx),
              });
            },
            afterWrite: async (
              tx: any,
              batch?: {
                batchId: string;
                batchKey: string;
                sampleCount: number;
                citationCount: number;
                idempotent: boolean;
              },
            ) => {
              if (!batch) throw new Error("监控批次发布结果缺失");
              await writeWorkspaceAuditEvent(
                {
                  actor,
                  action: "workspace.monitoring.imported",
                  targetType: "monitoring_batch",
                  targetId: batch.batchId,
                  workspaceUserId: targetUserId,
                  metadata: {
                    sourceName: sourceFileName,
                    batchKey: batch.batchKey,
                    sampleCount: batch.sampleCount,
                    citationCount: batch.citationCount,
                    idempotent: batch.idempotent,
                    fileHash,
                    targetBatchKey: preview.targetBatchRequired
                      ? targetBatchKey
                      : undefined,
                  },
                },
                tx,
              );
            },
          };
          const batch = preview.targetBatchRequired
            ? await mergeQuestionOnlyCitationsIntoMonitoringBatch({
                actor,
                targetUserId,
                targetBatchKey,
                value: monitoringBatch,
                ...transactionHooks,
              })
            : await replaceMonitoringBatch({
                actor,
                value: monitoringBatch,
                ...transactionHooks,
              });
          res.json({ kind: "monitoring", module: importModule, batch });
          return;
        }
        if (
          payload.optimizationReport &&
          (importModule === "optimization-report" ||
            (payload.optimizationReport.questionBaselines?.length ?? 0) > 0 ||
            (payload.optimizationReport.questionReports?.length ?? 0) > 0)
        ) {
          assertOptimizationReportQuestionScope(payload.optimizationReport, [
            ...servicePortal.purchasedQuestions,
            ...servicePortal.historicalQuestions,
          ]);
        }
        if (importModule === "optimization-report" && importPreview) {
          if (!payload.optimizationReport) {
            throw new Error("优化报告模板中没有可预检的报告内容");
          }
          const credential = await issueDashboardImportPreflight({
            binding: {
              actorId: actor.id,
              workspaceUserId: targetUserId,
              module: "optimization-report",
              revision: existing.revision,
              fileHash,
            },
          });
          res.json({
            kind: "optimization-report-preview",
            preview: {
              ...buildOptimizationReportImportPreview({
                current: existing.payload.optimizationReport,
                incoming: payload.optimizationReport,
                fileHash,
                sourceName: sourceFileName,
                templateRevision: existing.revision,
              }),
              ...credential,
            },
          });
          return;
        }
        assertDashboardEnterpriseIdentity(existing, payload);
        if (importPreview && importModule !== "optimization-report") {
          const credential = await issueDashboardImportPreflight({
            binding: {
              actorId: actor.id,
              workspaceUserId: targetUserId,
              module: importModule,
              revision: existing.revision,
              fileHash,
            },
          });
          res.json({
            kind: "dashboard-module-preview",
            preview: {
              ...buildDashboardModuleImportPreview({
                module: importModule,
                current: existing.payload,
                incoming: payload,
                sourceName: sourceFileName,
                fileHash,
                templateRevision: existing.revision,
              }),
              ...credential,
            },
          });
          return;
        }
        const dashboard = await importDashboardPayload({
          actor,
          targetUserId,
          payload,
          sourceFileName,
          bindEnterpriseIdentity: importModule === "profile",
          expectedRevision,
          progressReportPeriods:
            importModule === "optimization-report"
              ? servicePortal.quotaPeriods.map((period) => ({
                  contractId: period.contractId,
                  quotaPeriodId: period.periodId,
                }))
              : undefined,
          ...dashboardImportTransactionHooks({
            actor,
            targetUserId,
            module: importModule,
            expectedRevision: expectedRevision!,
            fileHash,
            preflightToken: req.header("x-import-preflight-token"),
            sourceFileName,
          }),
        });
        res.json({ kind: "dashboard", module: importModule, dashboard });
        return;
      }

      if (actor.role === "user") {
        throw new Error(
          "用户知识库只能通过“更新知识库”发布已绑定任务的最终版本",
        );
      }
      await assertServiceCapability(targetUserId, "knowledgeDisplay");

      let sourceBuildId: string | undefined;

      const snapshotId = randomUUID();
      const parsed = await readKnowledgeArchive(
        buffer,
        sourceFileName,
        snapshotId,
      );
      try {
        const workspace = await getDashboardWorkspace(targetUserId);
        assertKnowledgeArchiveEnterpriseIdentity({
          enterpriseIdentityConfirmed: Boolean(
            workspace.enterpriseIdentityBoundAt,
          ),
          brandName: workspace.payload.brandName,
          documents: parsed.documents,
        });
        const snapshot = await createKnowledgeSnapshot({
          snapshotId,
          userId: targetUserId,
          actorUserId: actor.id,
          sourceFileName,
          sourceConversationId,
          sourceBuildId,
          documents: parsed.documents,
          assets: parsed.assets,
          totalBytes: buffer.length,
        });
        await writeWorkspaceAuditEvent({
          actor,
          action: "workspace.knowledge.published",
          targetType: "knowledge_snapshot",
          targetId: snapshot?.id ?? snapshotId,
          workspaceUserId: targetUserId,
          metadata: {
            sourceName: sourceFileName,
            sourceConversationId,
            sourceBuildId,
            documentCount: snapshot?.documentCount ?? parsed.documents.length,
            imageCount: snapshot?.imageCount ?? parsed.assets.length,
            totalBytes: snapshot?.totalBytes ?? buffer.length,
          },
        });
        res.json({ kind: "knowledge", snapshot });
      } catch (error) {
        await Promise.all(
          parsed.storedAssetKeys.map((key) =>
            unlink(path.join(storageRoot, key)).catch(() => undefined),
          ),
        );
        throw error;
      }
    } catch (error) {
      console.error("[Dashboard] Import failed", error);
      const enterpriseMismatch =
        error instanceof DashboardEnterpriseMismatchError;
      const revisionConflict = error instanceof DashboardRevisionConflictError;
      const monitoringTargetRequired =
        error instanceof MonitoringTargetBatchRequiredError;
      const monitoringPreviewConflict =
        error instanceof MonitoringPreviewRequiredError ||
        error instanceof MonitoringFileChangedError;
      const dashboardImportPreviewConflict =
        error instanceof DashboardImportPreviewRequiredError ||
        error instanceof DashboardImportFileChangedError ||
        error instanceof DashboardTemplateRevisionError;
      const dashboardImportPreflightConflict =
        error instanceof DashboardImportPreflightError;
      const responseLogicRevisionConflict =
        error instanceof ResponseLogicRevisionConflictError;
      res
        .status(
          error instanceof ServiceEntitlementError
            ? error.statusCode
            : monitoringTargetRequired
              ? error.statusCode
              : monitoringPreviewConflict
                ? error.statusCode
                : dashboardImportPreviewConflict
                  ? error.statusCode
                  : dashboardImportPreflightConflict
                    ? error.statusCode
                    : responseLogicRevisionConflict
                      ? error.statusCode
                      : enterpriseMismatch || revisionConflict
                        ? 409
                        : 400,
        )
        .json({
          error: {
            message: error instanceof Error ? error.message : "无法导入文件",
            code:
              error instanceof ServiceEntitlementError
                ? error.code
                : enterpriseMismatch
                  ? "ENTERPRISE_IDENTITY_CONFLICT"
                  : revisionConflict
                    ? "DASHBOARD_REVISION_CONFLICT"
                    : monitoringTargetRequired
                      ? error.code
                      : monitoringPreviewConflict
                        ? error.code
                        : dashboardImportPreviewConflict
                          ? error.code
                          : dashboardImportPreflightConflict
                            ? error.code
                            : responseLogicRevisionConflict
                              ? error.code
                              : "IMPORT_FAILED",
          },
        });
    }
  },
);

router.get(
  "/knowledge/assets/:snapshotId/:assetIndex",
  async (req: FrontMindRequest, res) => {
    try {
      const assetIndex = Number(req.params.assetIndex);
      if (!Number.isInteger(assetIndex) || assetIndex < 0)
        throw new Error("资源不存在");
      const result = await getKnowledgeAsset({
        snapshotId: req.params.snapshotId,
        assetIndex,
      });
      if (!result) throw new Error("资源不存在");
      await assertWorkspaceAccess(req.frontmindUser!, result.snapshot.userId);
      const bytes = await readFile(path.join(storageRoot, result.asset.key));
      res.setHeader("Content-Type", result.asset.mimeType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("Content-Disposition", "inline");
      res.send(bytes);
    } catch {
      res
        .status(404)
        .json({ error: { message: "资源不存在", code: "NOT_FOUND" } });
    }
  },
);

export default router;
