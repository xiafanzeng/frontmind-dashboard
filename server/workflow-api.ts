import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import axios from "axios";
import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import JSZip from "jszip";
import type {
  WorkflowStepLoadRequest,
  WorkflowStepLoadResponse,
  WorkflowUploadedFile,
  WorkflowUploadResponse,
} from "../shared/workflow";
import {
  buildOperatorMessages,
  getPrivateWorkflowStep,
  loadPrivateSkillPackage,
  resolveWorkflowRoot,
  workflowManifest,
} from "./workflow/manifest";
import { getFrontMindCredentials, toUpstreamAgentProfile } from "./upstream-config";
import { recordUpstreamResource } from "./auth-service";
import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";

const router = Router();
const uploadsRoot = path.resolve(process.cwd(), ".workflow-uploads");
const uploadIndexName = "index.json";
const defaultUploadRetentionMs = 24 * 60 * 60 * 1000;

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

interface StoredWorkflowUploadedFile extends WorkflowUploadedFile {
  storedName: string;
}

function sanitizeSegment(value: string, fallback: string) {
  const safe = String(value || "")
    .replace(/[\\/\0]/g, "_")
    .replace(/^\.+$/, "")
    .trim()
    .slice(0, 140);
  return safe || fallback;
}

function sanitizeFileName(value: string) {
  return sanitizeSegment(value, "upload.bin");
}

function safeDecodeHeader(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getUploadDir(userId: number, runId: string, stepId: string) {
  return path.join(
    uploadsRoot,
    String(userId),
    sanitizeSegment(runId, "run"),
    sanitizeSegment(stepId, "step")
  );
}

function toPublicUpload(file: StoredWorkflowUploadedFile): WorkflowUploadedFile {
  return {
    id: file.id,
    name: file.name,
    type: file.type,
    size: file.size,
    stepId: file.stepId,
    uploadedAt: file.uploadedAt,
  };
}

async function readUploadIndex(userId: number, runId: string, stepId: string) {
  const indexPath = path.join(getUploadDir(userId, runId, stepId), uploadIndexName);
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as StoredWorkflowUploadedFile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeUploadIndex(
  userId: number,
  runId: string,
  stepId: string,
  files: StoredWorkflowUploadedFile[],
) {
  const uploadDir = getUploadDir(userId, runId, stepId);
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(path.join(uploadDir, uploadIndexName), JSON.stringify(files, null, 2), "utf-8");
}

export async function cleanupStaleWorkflowUploads() {
  const retentionMs = Number(process.env.FRONTMIND_WORKFLOW_UPLOAD_TTL_MS || defaultUploadRetentionMs);
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) return;

  let userEntries;
  try {
    userEntries = await fs.readdir(uploadsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const cutoff = Date.now() - retentionMs;
  await Promise.all(
    userEntries
      .filter(entry => entry.isDirectory())
      .map(async userEntry => {
        const userPath = path.join(uploadsRoot, userEntry.name);
        try {
          const runEntries = await fs.readdir(userPath, { withFileTypes: true });
          await Promise.all(
            runEntries
              .filter(entry => entry.isDirectory())
              .map(async runEntry => {
                const runPath = path.join(userPath, runEntry.name);
                const stat = await fs.stat(runPath);
                if (stat.mtimeMs < cutoff) {
                  await fs.rm(runPath, { recursive: true, force: true });
                }
              }),
          );
          if ((await fs.readdir(userPath)).length === 0) {
            await fs.rmdir(userPath);
          }
        } catch {
          // Ignore cleanup races.
        }
      })
  );
}

async function listPublicUploads(userId: number, runId: string, stepId: string) {
  const files = await readUploadIndex(userId, runId, stepId);
  return files.map(toPublicUpload);
}

async function addPathToZip(zip: JSZip, workflowRoot: string, relativeSource: string) {
  const rootPath = path.resolve(workflowRoot);
  const fullPath = path.resolve(rootPath, relativeSource);
  const relativeToRoot = path.relative(rootPath, fullPath);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return;
  }

  const stat = await fs.stat(fullPath);
  if (stat.isFile()) {
    const buffer = await fs.readFile(fullPath);
    zip.file(path.posix.join("workflow", relativeToRoot.split(path.sep).join("/")), buffer);
    return;
  }

  if (!stat.isDirectory()) {
    return;
  }

  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    await addPathToZip(zip, workflowRoot, path.join(relativeSource, entry.name));
  }
}

function buildRunContextMarkdown(
  step: NonNullable<ReturnType<typeof getPrivateWorkflowStep>>,
  body: WorkflowStepLoadRequest,
  uploads: WorkflowUploadedFile[]
) {
  const fields = body.fields || {};
  const fieldRows = Object.entries(fields)
    .filter(([, value]) => String(value || "").trim().length > 0)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n") || "- 无";
  const uploadRows = uploads
    .map((file) => `- ${file.name} (${file.type || "application/octet-stream"}, ${file.size} bytes)`)
    .join("\n") || "- 无";

  return [
    `# FrontMind Workflow Run Context`,
    ``,
    `## Step`,
    `- id: ${step.id}`,
    `- title: ${step.title}`,
    `- owner: ${step.owner}`,
    `- phase: ${step.phase}`,
    ``,
    `## Operator Fields`,
    fieldRows,
    ``,
    `## Operator Notes`,
    String(body.operatorNotes || "").trim() || "无",
    ``,
    `## Uploaded Files`,
    uploadRows,
    ``,
    `## Expected Outputs`,
    step.outputs.map((output) => `- ${output}`).join("\n"),
    ``,
	  ].join("\n");
}

function buildCurrentStepGateMarkdown(step: NonNullable<ReturnType<typeof getPrivateWorkflowStep>>) {
  return [
    `# Current Step Gate`,
    ``,
    `## Current Step`,
    `- id: ${step.id}`,
    `- title: ${step.title}`,
    `- owner: ${step.owner}`,
    `- phase: ${step.phase}`,
    ``,
    `## Execution Boundary`,
    `This run loads the complete FrontMind Workflow package for global context.`,
    `Execute the workflow only until the current step above is complete, then stop.`,
    `Do not continue into downstream steps even if the original workflow instructions would normally proceed automatically.`,
    ``,
    `## Required Output Boundary`,
    `Begin the response with the current step id and title.`,
    `Output only the deliverables for this current step.`,
    `If required inputs are missing, list the missing items and pause at this step.`,
    ``,
    `## Current Step Expected Outputs`,
    step.outputs.map((output) => `- ${output}`).join("\n"),
    ``,
  ].join("\n");
}

async function buildExecutionBundle(
  userId: number,
  step: NonNullable<ReturnType<typeof getPrivateWorkflowStep>>,
  runId: string,
  body: WorkflowStepLoadRequest,
  uploads: WorkflowUploadedFile[]
) {
  const workflowRoot = await resolveWorkflowRoot();
  if (!workflowRoot) {
    throw new Error("Workflow root not configured");
  }

  const zip = new JSZip();
  await addPathToZip(zip, workflowRoot, ".");

  const storedUploads = await readUploadIndex(userId, runId, step.id);
  const uploadDir = getUploadDir(userId, runId, step.id);
  for (const upload of storedUploads) {
    const uploadPath = path.join(uploadDir, upload.storedName);
    const buffer = await fs.readFile(uploadPath);
    zip.file(path.posix.join("user_uploads", step.id, upload.name), buffer);
  }

  zip.file("RUN_CONTEXT.md", buildRunContextMarkdown(step, body, uploads));
  zip.file("CURRENT_STEP_GATE.md", buildCurrentStepGateMarkdown(step));
  zip.file("PUBLIC_STEP.json", JSON.stringify({
    id: step.id,
    layer: step.layer,
    kind: step.kind,
    title: step.title,
    owner: step.owner,
    inputs: step.inputs,
    outputs: step.outputs,
    dependencies: step.dependencies,
    phase: step.phase,
    currentStepOnly: true,
  }, null, 2));
  zip.file("PUBLIC_WORKFLOW_MANIFEST.json", JSON.stringify(workflowManifest, null, 2));

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

async function uploadBufferToFrontMind(
  baseUrl: string,
  apiKey: string,
  filename: string,
  buffer: Buffer,
  contentType = "application/zip"
) {
  const fileRecordResponse = await axios.post(
    `${baseUrl}/v1/files`,
    { filename },
    {
      headers: {
        "Content-Type": "application/json",
        API_KEY: apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 120000,
      validateStatus: () => true,
    }
  );

  if (fileRecordResponse.status < 200 || fileRecordResponse.status >= 300) {
    throw new Error(`Create file record failed (${fileRecordResponse.status})`);
  }

  const fileRecord = fileRecordResponse.data;
  if (!fileRecord?.id || !fileRecord?.upload_url) {
    throw new Error("Create file record failed: missing file id or upload url");
  }

  const uploadResponse = await axios.put(
    assertSafeExternalUrl(fileRecord.upload_url),
    buffer,
    {
    ...safeExternalRequestOptions,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buffer.length),
    },
    timeout: 300000,
    maxBodyLength: buffer.length,
    maxContentLength: 1024 * 1024,
    validateStatus: () => true,
    },
  );

  if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
    throw new Error(`Upload file failed (${uploadResponse.status})`);
  }

  return { fileId: fileRecord.id as string, filename };
}

async function uploadStoredUserFiles(
  userId: number,
  baseUrl: string,
  apiKey: string,
  runId: string,
  stepId: string
) {
  const storedUploads = await readUploadIndex(userId, runId, stepId);
  const uploadDir = getUploadDir(userId, runId, stepId);
  const attachments: Array<{ file_id: string; filename: string }> = [];

  for (const upload of storedUploads) {
    const buffer = await fs.readFile(path.join(uploadDir, upload.storedName));
    const uploaded = await uploadBufferToFrontMind(
      baseUrl,
      apiKey,
      upload.name,
      buffer,
      upload.type || "application/octet-stream"
    );
    attachments.push({ file_id: uploaded.fileId, filename: uploaded.filename });
  }

  return attachments;
}

function buildAgentPrompt(step: NonNullable<ReturnType<typeof getPrivateWorkflowStep>>) {
  return [
    `请启动完整 FrontMind Workflow，并执行到当前闸门环节：${step.id}「${step.title}」。`,
    ``,
    `你会收到一个完整 workflow 执行包 ZIP。请先解压并按顺序读取：`,
    `1. RUN_CONTEXT.md：本次用户输入、上传资料和运行上下文。`,
    `2. workflow/Master_Control/FrontMind_Master_Control.md 与 workflow/00.FrontMind总控路由.skill：完整工作流总控。`,
    `3. CURRENT_STEP_GATE.md：本次强制停顿的当前环节。`,
    `4. workflow/Strategy_Workflow 与 workflow/Execution_Workflow：完整策略层与执行层 skill。`,
    `如有用户上传资料，也会在附件中单独提供，并在 ZIP 的 user_uploads/ 中备份。`,
    ``,
    `执行要求：`,
    `1. 先建立完整 FrontMind Workflow 的全局上下文，再进入 ${step.id}「${step.title}」。`,
    `2. 按 ${step.owner} 的职责执行当前环节。`,
    `3. 只输出当前环节结果，开头明确标注“当前环节：${step.id} ${step.title}”。`,
    `4. 当前环节完成后必须暂停，不要自动继续后续 S/E/P 环节。`,
    `5. 如果缺少必要资料，明确列出缺口并停在当前环节。`,
    ``,
    `当前环节预期产物：`,
    step.outputs.map((output) => `- ${output}`).join("\n"),
  ].join("\n");
}

router.get("/manifest", (_req, res) => {
  res.json(workflowManifest);
});

router.delete("/runs/:runId", asyncRoute(async (req, res) => {
  const runId = sanitizeSegment(String(req.params.runId || ""), "");
  if (!runId) {
    res.status(400).json({ error: "Missing run id" });
    return;
  }

  const userId = req.frontmindUser?.id;
  if (!userId) {
    res.status(401).json({ error: "请先登录" });
    return;
  }
  await fs.rm(path.join(uploadsRoot, String(userId), runId), {
    recursive: true,
    force: true,
  });
  res.json({ success: true });
}));

router.post(
  "/runs/:runId/steps/:stepId/uploads",
  express.raw({ type: "application/octet-stream", limit: "100mb" }),
  asyncRoute(async (req, res) => {
    const runId = sanitizeSegment(String(req.params.runId || ""), `wf_${randomUUID()}`);
    const stepId = String(req.params.stepId || "");
    const step = getPrivateWorkflowStep(stepId);
    const userId = req.frontmindUser?.id;

    if (!userId) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    if (!step) {
      res.status(404).json({ error: "Unknown workflow step" });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "Empty upload body" });
      return;
    }

    const originalName = sanitizeFileName(safeDecodeHeader(String(req.header("x-file-name") || "upload.bin")));
    const contentType = String(req.header("x-file-type") || "application/octet-stream");
    const id = randomUUID();
    const storedName = `${id}_${originalName}`;
    const uploadDir = getUploadDir(userId, runId, step.id);
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, storedName), req.body);

    const file: StoredWorkflowUploadedFile = {
      id,
      storedName,
      name: originalName,
      type: contentType,
      size: req.body.length,
      stepId: step.id,
      uploadedAt: new Date().toISOString(),
    };

    const index = await readUploadIndex(userId, runId, step.id);
    index.push(file);
    await writeUploadIndex(userId, runId, step.id, index);

    const response: WorkflowUploadResponse = {
      runId,
      stepId: step.id,
      file: toPublicUpload(file),
    };

    res.json(response);
  })
);

router.post("/steps/:stepId/load", asyncRoute(async (req, res) => {
  const stepId = String(req.params.stepId || "");
  const body = (req.body || {}) as WorkflowStepLoadRequest;
  const loadedPackage = await loadPrivateSkillPackage(stepId);
  const userId = req.frontmindUser?.id;

  if (!userId) {
    res.status(401).json({ error: "请先登录" });
    return;
  }
  if (!loadedPackage) {
    res.status(404).json({ error: "Unknown workflow step" });
    return;
  }

  const runId = body.runId || `wf_${randomUUID()}`;
  const sessionId = `exec_${stepId}_${randomUUID()}`;
  const hasOperatorNotes =
    typeof body.operatorNotes === "string" && body.operatorNotes.trim().length > 0;
  const loaded = loadedPackage.loaded;
  const contextUploads = await listPublicUploads(userId, runId, stepId);
  const uploadMessages =
    contextUploads.length > 0
      ? [`已纳入 ${contextUploads.length} 个上传文件：${contextUploads.map((file) => file.name).join("、")}。`]
      : [];

  const response: WorkflowStepLoadResponse = {
    runId,
    stepId,
    status: loaded ? "loaded" : "missing_private_package",
    loadedAt: new Date().toISOString(),
    sessionId,
    nextStatus: loaded ? "done" : "unavailable",
    serverLoad: {
      privatePackageLoaded: loaded,
      workflowRootConfigured: loadedPackage.workflowRootConfigured,
      checkedSources: loadedPackage.checkedSources,
      availableSources: loadedPackage.availableSources,
      loadedBytes: loadedPackage.loadedBytes,
      promptVisibleToClient: false,
      returnedPromptContent: false,
    },
    contextUploads,
    operatorMessages: [
      ...buildOperatorMessages(
        loadedPackage.step.kind,
        loadedPackage.step.title,
        loadedPackage.step.inputs,
        loadedPackage.step.outputs,
        hasOperatorNotes
      ),
      ...uploadMessages,
    ],
    artifactPlaceholders: loadedPackage.artifactPlaceholders,
    safety: {
      promptStoredServerSide: true,
      frontendReceivesPublicManifestOnly: true,
      rawSkillContentReturned: false,
    },
  };

  res.json(response);
}));

router.post("/steps/:stepId/execute", asyncRoute(async (req, res) => {
  const stepId = String(req.params.stepId || "");
  const body = (req.body || {}) as WorkflowStepLoadRequest & { agentProfile?: string };
  const loadedPackage = await loadPrivateSkillPackage(stepId);
  const step = getPrivateWorkflowStep(stepId);
  const userId = req.frontmindUser?.id;

  if (!userId) {
    res.status(401).json({ error: "请先登录" });
    return;
  }
  if (!loadedPackage || !step) {
    res.status(404).json({ error: "Unknown workflow step" });
    return;
  }

  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  if (!apiKey) {
    res.status(401).json({ error: "Missing API key" });
    return;
  }

  const runId = body.runId || `wf_${randomUUID()}`;
  const sessionId = `exec_${stepId}_${randomUUID()}`;
  const hasOperatorNotes =
    typeof body.operatorNotes === "string" && body.operatorNotes.trim().length > 0;
  const contextUploads = await listPublicUploads(userId, runId, stepId);

  try {
    const bundle = await buildExecutionBundle(
      userId,
      step,
      runId,
      body,
      contextUploads,
    );
    const bundleFile = await uploadBufferToFrontMind(
      baseUrl,
      apiKey,
      `FrontMind_${step.id}_${runId}_full_workflow_bundle.zip`,
      bundle,
      "application/zip"
    );
    const userFileAttachments = await uploadStoredUserFiles(
      userId,
      baseUrl,
      apiKey,
      runId,
      stepId,
    );
    const attachments = [
      { filename: bundleFile.filename, file_id: bundleFile.fileId },
      ...userFileAttachments,
    ];

    if (!req.frontmindUser || !req.frontmindCredential) {
      res.status(401).json({ error: "请先登录并配置 API Key" });
      return;
    }
    for (const attachment of attachments) {
      await recordUpstreamResource({
        userId: req.frontmindUser.id,
        apiCredentialId: req.frontmindCredential.id,
        kind: "file",
        upstreamId: attachment.file_id,
      });
    }

    const taskResponse = await axios.post(
      `${baseUrl}/v1/tasks`,
      {
        prompt: buildAgentPrompt(step),
        agentProfile: toUpstreamAgentProfile(body.agentProfile),
        taskMode: "agent",
        attachments,
      },
      {
        headers: {
          "Content-Type": "application/json",
          API_KEY: apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 120000,
        validateStatus: () => true,
      }
    );

    if (taskResponse.status < 200 || taskResponse.status >= 300) {
      const detail =
        taskResponse.data?.error?.message ||
        taskResponse.data?.message ||
        `Create task failed (${taskResponse.status})`;
      console.warn("[Workflow Execute] create task failed:", detail);
      res.status(taskResponse.status).json({ error: "创建任务失败，请检查 API Key 或稍后重试" });
      return;
    }

    const taskData = taskResponse.data || {};
    const taskId = taskData.id || taskData.task_id;
    if (!taskId) {
      res.status(502).json({ error: "Create task failed: missing task id" });
      return;
    }
    await recordUpstreamResource({
      userId: req.frontmindUser.id,
      apiCredentialId: req.frontmindCredential.id,
      kind: "task",
      upstreamId: String(taskId),
    });
    const normalizedStatus = taskData.status === "failed" ? "error" : (taskData.status || "running");
    const uploadMessages =
      contextUploads.length > 0
        ? [`已纳入 ${contextUploads.length} 个上传文件：${contextUploads.map((file) => file.name).join("、")}。`]
        : [];

    const response: WorkflowStepLoadResponse = {
      runId,
      stepId,
      status: loadedPackage.loaded ? "loaded" : "missing_private_package",
      loadedAt: new Date().toISOString(),
      sessionId,
      task: {
        id: taskId,
        status: normalizedStatus,
        taskUrl: taskData.task_url || taskData.metadata?.task_url,
        title: taskData.task_title || taskData.metadata?.task_title,
      },
      nextStatus: loadedPackage.loaded ? "done" : "unavailable",
      serverLoad: {
        privatePackageLoaded: loadedPackage.loaded,
        workflowRootConfigured: loadedPackage.workflowRootConfigured,
        checkedSources: loadedPackage.checkedSources,
        availableSources: loadedPackage.availableSources,
        loadedBytes: loadedPackage.loadedBytes,
        promptVisibleToClient: false,
        returnedPromptContent: false,
      },
      contextUploads,
      operatorMessages: [
        `已载入完整 FrontMind Workflow 包，并定位到当前环节：${step.id}「${step.title}」。`,
        `本次运行会在当前环节完成后暂停，不会自动继续后续环节。`,
        ...buildOperatorMessages(
          step.kind,
          step.title,
          step.inputs,
          step.outputs,
          hasOperatorNotes
        ),
        ...uploadMessages,
      ],
      artifactPlaceholders: loadedPackage.artifactPlaceholders,
      safety: {
        promptStoredServerSide: true,
        frontendReceivesPublicManifestOnly: true,
        rawSkillContentReturned: false,
      },
    };

    res.json(response);
  } catch (error: any) {
    console.error("[Workflow Execute] error:", error.message);
    res.status(500).json({ error: "执行任务失败，请稍后重试" });
  }
}));

export default router;
