import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { sanitizePdfFile } from "./manus-proxy";

interface PdfWorkerData {
  inputPath: string;
  outputPath: string;
  workDir: string;
  largePdfThresholdBytes: number;
}

const data = workerData as PdfWorkerData;

function send(message: unknown) {
  parentPort?.postMessage(message);
}

async function run(
  command: string,
  args: string[],
  onActivity?: () => void,
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.on("data", () => onActivity?.());
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      onActivity?.();
      stderr += String(chunk).slice(0, 16_000);
    });
    child.on("error", error => reject(error));
    child.on("exit", code => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${command} exited with ${code}: ${stderr.slice(-2_000)}`,
          ),
        );
      }
    });
  });
}

async function runCapture(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += String(chunk).slice(0, 16_000);
    });
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) resolve(stdout);
      else {
        reject(
          new Error(
            `${command} exited with ${code}: ${stderr.slice(-2_000)}`,
          ),
        );
      }
    });
  });
}

async function commandAvailable(command: string) {
  try {
    await run(command, ["-v"]);
    return true;
  } catch {
    try {
      await run(command, ["--version"]);
      return true;
    } catch {
      return false;
    }
  }
}

async function getPageCount(filePath: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("pdfinfo", [filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", code => {
      if (code !== 0) {
        reject(new Error(`pdfinfo failed: ${stderr.slice(-2_000)}`));
        return;
      }
      const pages = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
      if (!Number.isInteger(pages) || pages < 1) {
        reject(new Error("pdfinfo did not return a valid page count"));
        return;
      }
      resolve(pages);
    });
  });
}

async function sanitizeSinglePdf(inputPath: string, outputPath: string) {
  const result = await sanitizePdfFile(inputPath, outputPath);
  return result.wasSanitized;
}

async function sanitizeLargePdf(pageCount: number) {
  const splitPattern = path.join(data.workDir, "source-%06d.pdf");
  await run("pdfseparate", [data.inputPath, splitPattern]);
  const sourcePages = (await fs.readdir(data.workDir))
    .filter(name => /^source-\d+\.pdf$/.test(name))
    .sort();
  if (sourcePages.length !== pageCount) {
    throw new Error(
      `PDF split page mismatch: expected ${pageCount}, got ${sourcePages.length}`,
    );
  }

  const sanitizedPages: string[] = [];
  let wasSanitized = false;
  for (let index = 0; index < sourcePages.length; index += 1) {
    const sourcePage = path.join(data.workDir, sourcePages[index]);
    const sanitizedPage = path.join(
      data.workDir,
      `prepared-${String(index + 1).padStart(6, "0")}.pdf`,
    );
    wasSanitized =
      (await sanitizeSinglePdf(sourcePage, sanitizedPage)) || wasSanitized;
    sanitizedPages.push(sanitizedPage);
    await fs.rm(sourcePage, { force: true });
    send({
      type: "progress",
      phase: "sanitizing",
      page: index + 1,
      pageCount,
    });
  }

  send({ type: "progress", phase: "optimizing", pageCount });
  const mergedPath = path.join(data.workDir, "merged.pdf");
  await run("pdfunite", [...sanitizedPages, mergedPath]);
  await run(
    "gs",
    [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.6",
      "-dPDFSETTINGS=/prepress",
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      "-dSubsetFonts=true",
      "-dPreserveAnnots=true",
      "-dNOPAUSE",
      "-dBATCH",
      `-sOutputFile=${data.outputPath}`,
      mergedPath,
    ],
    () => send({ type: "progress", phase: "optimizing", pageCount }),
  );
  return wasSanitized;
}

async function main() {
  await fs.mkdir(data.workDir, { recursive: true, mode: 0o700 });
  const stat = await fs.stat(data.inputPath);
  const [hasPdfInfo, hasPdfToText] = await Promise.all([
    commandAvailable("pdfinfo"),
    commandAvailable("pdftotext"),
  ]);
  if (!hasPdfInfo || !hasPdfToText) {
    throw Object.assign(
      new Error("缺少 PDF 校验工具；请在服务器安装 poppler-utils"),
      { code: "PDF_TOOLING_UNAVAILABLE" },
    );
  }
  const pageCount = await getPageCount(data.inputPath);
  send({ type: "progress", phase: "sanitizing", page: 0, pageCount });

  let wasSanitized: boolean;
  if (stat.size >= data.largePdfThresholdBytes) {
    const [hasPdfSeparate, hasPdfUnite, hasGhostscript] = await Promise.all([
      commandAvailable("pdfseparate"),
      commandAvailable("pdfunite"),
      commandAvailable("gs"),
    ]);
    if (!hasPdfSeparate || !hasPdfUnite || !hasGhostscript) {
      throw Object.assign(
        new Error(
          "大文件处理需要 Poppler 和 Ghostscript；请安装 poppler-utils 与 ghostscript",
        ),
        { code: "PDF_TOOLING_UNAVAILABLE" },
      );
    }
    wasSanitized = await sanitizeLargePdf(pageCount);
  } else {
    wasSanitized = await sanitizeSinglePdf(data.inputPath, data.outputPath);
    send({ type: "progress", phase: "optimizing", pageCount });
  }

  const outputPageCount = await getPageCount(data.outputPath);
  if (outputPageCount !== pageCount) {
    throw Object.assign(
      new Error(
        `处理前后页数不一致：${pageCount} -> ${outputPageCount}`,
      ),
      { code: "PDF_PAGE_COUNT_MISMATCH" },
    );
  }
  const extractedText = await runCapture("pdftotext", [data.outputPath, "-"]);
  const sourceBrand = ["ma", "nus"].join("");
  if (new RegExp(`\\b${sourceBrand}\\b`, "i").test(extractedText)) {
    throw Object.assign(
      new Error("品牌替换校验未通过，处理结果未发布"),
      { code: "BRAND_REPLACEMENT_INCOMPLETE" },
    );
  }
  send({
    type: "complete",
    pageCount: outputPageCount,
    wasSanitized,
  });
}

void main().catch((error: any) => {
  send({
    type: "error",
    code: error?.code || "PDF_PREPARATION_FAILED",
    message: error?.message || "PDF 处理失败",
  });
});
