import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { launch as launchChrome } from "chrome-launcher";
import JSZip from "jszip";
import lighthouse from "lighthouse";
import { chromium, type Page } from "playwright";
import { z } from "zod";

import { siteBriefSchema, type SiteBrief } from "../../shared/siteops";
import { canonicalJson } from "../../shared/siteops-workflow";
import {
  NATIVE_SOURCE_ALLOWED_DEPENDENCIES,
  type ValidatedNativeReactSource,
} from "./native-react-source";

const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const MAX_BUILD_LOG_BYTES = 256 * 1024;
const MAX_DIST_BYTES = 30 * 1024 * 1024;
const MAX_DIST_FILES = 1_000;
const MAX_DIST_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_BUILD_TIMEOUT_MS = 90_000;
const MAX_BUILD_TIMEOUT_MS = 120_000;
const NATIVE_RENDERER = "twenty_first_native" as const;
const NATIVE_QA_POLICY = "siteops-native-hard-safety-v1" as const;
const SAFE_BUILD_ERROR_MARKER = "__FRONTMIND_NATIVE_BUILD_ERROR__";
const NATIVE_DOCUMENT_CSP =
  "default-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; media-src 'self' data:; manifest-src 'none'; base-uri 'self'; form-action 'none'";
const HOST_DEPENDENCY_ALLOWLIST = new Set<string>(
  NATIVE_SOURCE_ALLOWED_DEPENDENCIES,
);

const buildCoordinatesSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    knowledgeSnapshotId: z.string().max(191).nullable().optional(),
    workflowVersion: z.string().trim().min(1).max(64).nullable().optional(),
    selectionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable()
      .optional(),
  })
  .strict();

export type NativeReactBuildCoordinates = z.infer<
  typeof buildCoordinatesSchema
>;

export type NativeReactBuildInput = {
  sourceZip: Buffer;
  validatedSource: ValidatedNativeReactSource;
  build: NativeReactBuildCoordinates;
  brief: SiteBrief | unknown;
  mode: "preview" | "production";
  canonicalOrigin?: string | null;
  target?: "global_excluding_cn" | "mainland_cn" | null;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Tests and bounded smoke checks can omit Chromium without changing the
   * hard compile/static-safety decision. Omission is recorded as a warning. */
  browserQa?: boolean;
  lighthouseQa?: boolean;
};

export type NativeReactBuildWarning = {
  phase: "browser_qa" | "lighthouse";
  code: string;
  checkId: string;
};

export type NativeReactBuildDelivery = {
  renderMode: typeof NATIVE_RENDERER;
  qaStatus: "passed" | "passed_with_warnings";
  warningCodes: string[];
};

export type NativeReactBuildContractV1 = {
  schemaVersion: 1;
  contractKind: "twenty_first_native_build_contract";
  renderer: "twenty_first_native_react_v1";
  buildId: string;
  projectId: string;
  mode: "preview" | "production";
  canonicalOrigin: string | null;
  target: "global_excluding_cn" | "mainland_cn" | null;
  routes: string[];
  sourceSha256: string;
  distSha256: string;
};

export type NativeReactQaReportV1 = {
  schemaVersion: 1;
  policyVersion: typeof NATIVE_QA_POLICY;
  passed: true;
  mode: "preview" | "production";
  routes: string[];
  checks: Array<{ id: string; passed: true; detail: string }>;
  browser: {
    available: boolean;
    lighthouse: {
      performance: number | null;
      accessibility: number | null;
      bestPractices: number | null;
      seo: number | null;
      cls: number | null;
    };
    axeViolationCount: number;
    axeViolationIds: string[];
    screenshotFiles: string[];
  };
  buildDelivery: NativeReactBuildDelivery;
  warnings: NativeReactBuildWarning[];
  fileCount: number;
  totalBytes: number;
};

export type MaterializedNativeReactSite = {
  contract: NativeReactBuildContractV1;
  contractJson: Buffer;
  contractSha256: string;
  /** The exact validated Provider/Manus archive; it is never regenerated. */
  sourceZip: Buffer;
  sourceSha256: string;
  distZip: Buffer;
  distSha256: string;
  qaJson: Buffer;
  qaSha256: string;
  visualQaZip: Buffer;
  visualQaSha256: string;
  provenanceJson: Buffer;
  provenanceSha256: string;
  buildLog: Buffer;
  files: ReadonlyMap<string, Buffer>;
  buildDelivery: NativeReactBuildDelivery;
};

export type NativeReactBuildErrorCode =
  | "NATIVE_BUILD_INPUT_INVALID"
  | "NATIVE_BUILD_SOURCE_MISMATCH"
  | "NATIVE_BUILD_DEPENDENCY_UNAVAILABLE"
  | "NATIVE_BUILD_RUNTIME_UNAVAILABLE"
  | "NATIVE_BUILD_COMPILE_FAILED"
  | "NATIVE_BUILD_RENDER_FAILED"
  | "NATIVE_BUILD_TIMEOUT"
  | "NATIVE_BUILD_ABORTED"
  | "NATIVE_BUILD_LOG_LIMIT_EXCEEDED"
  | "NATIVE_BUILD_DIST_INVALID"
  | "NATIVE_BUILD_DIST_LIMIT_EXCEEDED"
  | "NATIVE_BUILD_ROUTE_MISSING"
  | "NATIVE_BUILD_LOCAL_ASSET_MISSING"
  | "NATIVE_BUILD_NETWORK_FORBIDDEN"
  | "NATIVE_BUILD_SECRET_FORBIDDEN";

export type NativeReactBuildDiagnostic = {
  code: string;
  file: string | null;
  line: number | null;
  column: number | null;
};

export class NativeReactBuildError extends Error {
  constructor(
    readonly code: NativeReactBuildErrorCode,
    readonly diagnostics: readonly NativeReactBuildDiagnostic[] = [],
  ) {
    super(code);
    this.name = "NativeReactBuildError";
  }
}

type OutputFile = { path: string; bytes: Buffer };

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBuffer(value: unknown) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new NativeReactBuildError("NATIVE_BUILD_ABORTED");
  }
}

function boundedTimeout(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_BUILD_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value!), 5_000), MAX_BUILD_TIMEOUT_MS);
}

function validateCanonicalOrigin(
  mode: "preview" | "production",
  raw: string | null | undefined,
) {
  if (mode === "preview") {
    if (raw) throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
    return null;
  }
  if (!raw) throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.hostname === "localhost"
  ) {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  return parsed.origin;
}

function routePath(raw: string) {
  const trimmed = raw.trim();
  const withSlash =
    trimmed === "/" ? "/" : `/${trimmed.replace(/^\/+|\/+$/gu, "")}/`;
  const parts = withSlash.split("/").filter(Boolean);
  if (
    withSlash.includes("\\") ||
    withSlash.includes("%") ||
    withSlash.includes("?") ||
    withSlash.includes("#") ||
    withSlash.includes("\0") ||
    withSlash.normalize("NFKC") !== withSlash ||
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        !/^[a-z0-9](?:[a-z0-9_-]{0,62})$/u.test(part),
    )
  ) {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}/`;
}

function routeOutput(route: string) {
  return route === "/" ? "index.html" : `${route.slice(1)}index.html`;
}

function archiveDependencies(packageJson: Readonly<Record<string, unknown>>) {
  const names = new Set<string>(["react", "react-dom"]);
  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    const value = packageJson[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const name of Object.keys(value)) names.add(name);
  }
  for (const name of names) {
    if (!HOST_DEPENDENCY_ALLOWLIST.has(name)) {
      throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
    }
  }
  return [...names].sort();
}

function hostPackageRoot(name: string) {
  const require = createRequire(import.meta.url);
  try {
    let directory = path.dirname(require.resolve(name));
    for (let depth = 0; depth < 16; depth += 1) {
      const manifestPath = path.join(directory, "package.json");
      try {
        const manifest = JSON.parse(
          readFileSync(manifestPath, "utf8"),
        ) as Record<string, unknown>;
        if (manifest.name === name) return directory;
      } catch {
        // Keep walking until the package root owning the resolved entry.
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    throw new Error("HOST_PACKAGE_ROOT_NOT_FOUND");
  } catch {
    throw new NativeReactBuildError("NATIVE_BUILD_DEPENDENCY_UNAVAILABLE", [
      { code: "HOST_PACKAGE_MISSING", file: null, line: null, column: null },
    ]);
  }
}

async function linkHostDependencies(root: string, dependencies: string[]) {
  const modules = path.join(root, "node_modules");
  await mkdir(modules, { recursive: false, mode: 0o700 });
  for (const dependency of dependencies) {
    const target = path.join(modules, ...dependency.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await symlink(hostPackageRoot(dependency), target, "dir");
  }
}

async function writeValidatedSource(
  root: string,
  source: ValidatedNativeReactSource,
) {
  for (const [filename, bytes] of [...source.files.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const target = path.join(root, ...filename.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
  }
  const indexPath = path.join(root, source.htmlEntrypoint);
  const raw = await readFile(indexPath, "utf8");
  const withoutExistingBase = raw.replace(/<base\b[^>]*>/giu, "");
  const normalized = /<head\b[^>]*>/iu.test(withoutExistingBase)
    ? withoutExistingBase.replace(
        /<head\b([^>]*)>/iu,
        '<head$1><base href="/">',
      )
    : `<!doctype html><html><head><base href="/"></head><body>${withoutExistingBase}</body></html>`;
  await writeFile(indexPath, normalized, { encoding: "utf8", mode: 0o600 });
}

function resolveHostModule(name: string) {
  const require = createRequire(import.meta.url);
  try {
    return pathToFileURL(require.resolve(name)).href;
  } catch {
    throw new NativeReactBuildError("NATIVE_BUILD_RUNTIME_UNAVAILABLE");
  }
}

function controlledViteBuilderSource(input: {
  viteModuleUrl: string;
  tailwindModuleUrl: string | null;
  useTailwind: boolean;
  allowedDependencies: string[];
}) {
  return `
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

const denyNetwork = () => { throw new Error("NATIVE_BUILD_NETWORK_FORBIDDEN"); };
for (const module of [http, https]) { module.request = denyNetwork; module.get = denyNetwork; }
net.connect = denyNetwork;
net.createConnection = denyNetwork;
tls.connect = denyNetwork;
dgram.createSocket = denyNetwork;
globalThis.fetch = denyNetwork;
globalThis.WebSocket = class { constructor() { denyNetwork(); } };
syncBuiltinESMExports();

const root = process.cwd();
const allowedDependencies = new Set(${JSON.stringify(input.allowedDependencies)});
const sourceBoundary = {
  name: "frontmind-native-source-boundary",
  enforce: "pre",
  resolveId(source, importer) {
    if (typeof source !== "string" || source.startsWith("\\0")) return null;
    const clean = source.split(/[?#]/, 1)[0];
    if (/^file:/iu.test(clean) || clean.startsWith("/@fs/")) {
      throw Object.assign(new Error("NATIVE_BUILD_SOURCE_BOUNDARY"), { code: "NATIVE_BUILD_SOURCE_BOUNDARY" });
    }
    if (!importer || !path.isAbsolute(importer)) return null;
    const importerRelative = path.relative(root, importer.split("?", 1)[0]);
    if (importerRelative.startsWith("../") || path.isAbsolute(importerRelative) || importerRelative.startsWith("node_modules/")) return null;
    if (clean.startsWith(".")) {
      const target = path.resolve(path.dirname(importer), clean);
      const relative = path.relative(root, target);
      if (relative.startsWith("../") || path.isAbsolute(relative)) {
        throw Object.assign(new Error("NATIVE_BUILD_SOURCE_BOUNDARY"), { code: "NATIVE_BUILD_SOURCE_BOUNDARY" });
      }
      return null;
    }
    if (clean === "vite/modulepreload-polyfill") return null;
    if (clean.startsWith("/") || clean.startsWith("@/")) return null;
    const dependency = clean.startsWith("@") ? clean.split("/", 2).join("/") : clean.split("/", 1)[0];
    if (!allowedDependencies.has(dependency)) {
      throw Object.assign(new Error("NATIVE_BUILD_DEPENDENCY_BOUNDARY"), { code: "NATIVE_BUILD_DEPENDENCY_BOUNDARY" });
    }
    return null;
  },
};
const safeDiagnostic = (error) => {
  const nested = Array.isArray(error?.errors) && error.errors.length > 0
    ? error.errors[0]
    : Array.isArray(error?.cause?.errors) && error.cause.errors.length > 0
      ? error.cause.errors[0]
      : error?.cause;
  const nestedLocation = nested?.location && typeof nested.location === "object" ? nested.location : null;
  const rawIdCandidate = typeof nestedLocation?.file === "string"
    ? nestedLocation.file
    : typeof nested?.id === "string"
      ? nested.id
      : typeof error?.id === "string"
        ? error.id
        : null;
  const rawId = rawIdCandidate ? rawIdCandidate.split("?")[0] : null;
  const relative = rawId && path.isAbsolute(rawId) ? path.relative(root, rawId).replaceAll("\\\\", "/") : rawId;
  const safeFile = relative && !relative.startsWith("../") && !path.isAbsolute(relative) && relative.length <= 240 ? relative : null;
  const location = error?.loc && typeof error.loc === "object" ? error.loc : null;
  const line = nestedLocation?.line ?? location?.line;
  const column = nestedLocation?.column ?? location?.column;
  const safeMessage = typeof error?.message === "string" ? error.message : "";
  const boundaryCode = ["NATIVE_BUILD_SOURCE_BOUNDARY", "NATIVE_BUILD_DEPENDENCY_BOUNDARY"].find((code) => safeMessage.includes(code));
  const diagnosticCode = boundaryCode ?? (typeof nested?.code === "string" ? nested.code : error?.code);
  return {
    code: typeof diagnosticCode === "string" && /^[A-Z0-9_:-]{1,80}$/.test(diagnosticCode) ? diagnosticCode : "VITE_BUILD_ERROR",
    file: safeFile,
    line: Number.isSafeInteger(line) && line > 0 ? line : null,
    column: Number.isSafeInteger(column) && column >= 0 ? column : null,
  };
};

try {
  const { build } = await import(${JSON.stringify(input.viteModuleUrl)});
  const plugins = [sourceBoundary];
  if (${JSON.stringify(input.useTailwind)}) {
    const tailwindModule = await import(${JSON.stringify(input.tailwindModuleUrl)});
    const tailwind = tailwindModule.default ?? tailwindModule;
    plugins.push(tailwind());
  }
  await build({
    root,
    base: "/",
    configFile: false,
    publicDir: "public",
    appType: "spa",
    plugins,
    logLevel: "silent",
    clearScreen: false,
    resolve: {
      alias: { "@": path.join(root, "src") },
      dedupe: ["react", "react-dom"],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": JSON.stringify({}),
      "global": "globalThis",
    },
    esbuild: { jsx: "automatic", jsxDev: false },
    css: { postcss: { plugins: [] } },
    build: {
      outDir: path.join(root, "dist"),
      emptyOutDir: true,
      copyPublicDir: true,
      assetsInlineLimit: 4096,
      cssCodeSplit: false,
      sourcemap: false,
      minify: "esbuild",
      target: "es2020",
      reportCompressedSize: false,
      rollupOptions: {
        input: path.join(root, "index.html"),
        output: {
          inlineDynamicImports: true,
          entryFileNames: "assets/app-[hash].js",
          chunkFileNames: "assets/chunk-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  });
} catch (error) {
  process.stderr.write(${JSON.stringify(SAFE_BUILD_ERROR_MARKER)} + JSON.stringify(safeDiagnostic(error)) + "\\n");
  process.exitCode = 1;
}
`;
}

function sourceUsesTailwind(files: ReadonlyMap<string, Buffer>) {
  for (const [filename, bytes] of files) {
    if (!/\.(?:css|less|sass|scss)$/iu.test(filename)) continue;
    const value = bytes.toString("utf8");
    if (
      /@tailwind\s+|@import\s+["']tailwindcss(?:\/[^"']*)?["']/iu.test(value)
    ) {
      return true;
    }
  }
  return false;
}

function parseBuildDiagnostics(output: Buffer) {
  const value = output.toString("utf8");
  const markerIndex = value.lastIndexOf(SAFE_BUILD_ERROR_MARKER);
  if (markerIndex < 0) return [];
  const raw = value
    .slice(markerIndex + SAFE_BUILD_ERROR_MARKER.length)
    .split(/\r?\n/u, 1)[0];
  try {
    const parsed = JSON.parse(raw) as NativeReactBuildDiagnostic;
    if (
      parsed &&
      typeof parsed.code === "string" &&
      (parsed.file === null || typeof parsed.file === "string") &&
      (parsed.line === null || Number.isSafeInteger(parsed.line)) &&
      (parsed.column === null || Number.isSafeInteger(parsed.column))
    ) {
      return [parsed];
    }
  } catch {
    // The caller receives only the stable compile code.
  }
  return [];
}

async function runControlledViteBuild(input: {
  root: string;
  source: ValidatedNativeReactSource;
  dependencies: string[];
  timeoutMs: number;
  abortSignal?: AbortSignal;
}) {
  assertNotAborted(input.abortSignal);
  const useTailwind = sourceUsesTailwind(input.source.files);
  const viteModuleUrl = resolveHostModule("vite");
  const tailwindModuleUrl = useTailwind
    ? resolveHostModule("@tailwindcss/vite")
    : null;
  const builder = path.join(input.root, ".frontmind-native-build.mjs");
  await writeFile(
    builder,
    controlledViteBuilderSource({
      viteModuleUrl,
      tailwindModuleUrl,
      useTailwind,
      allowedDependencies: input.dependencies,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=512", builder],
      {
        cwd: input.root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          NODE_ENV: "production",
          HOME: input.root,
          LANG: "C.UTF-8",
          TZ: "UTC",
          NO_COLOR: "1",
          CI: "1",
          PATH: path.dirname(process.execPath),
          npm_config_offline: "true",
          npm_config_ignore_scripts: "true",
          VITE_CJS_IGNORE_WARNING: "true",
        },
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const collect = (raw: Buffer) => {
      if (overflow) return;
      bytes += raw.length;
      if (bytes > MAX_BUILD_LOG_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(raw);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const abort = () => child.kill("SIGKILL");
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    const cleanup = () =>
      input.abortSignal?.removeEventListener("abort", abort);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      cleanup();
      reject(new NativeReactBuildError("NATIVE_BUILD_RUNTIME_UNAVAILABLE"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      cleanup();
      const output = Buffer.concat(
        chunks,
        Math.min(bytes, MAX_BUILD_LOG_BYTES),
      );
      if (input.abortSignal?.aborted) {
        reject(new NativeReactBuildError("NATIVE_BUILD_ABORTED"));
      } else if (timedOut) {
        reject(new NativeReactBuildError("NATIVE_BUILD_TIMEOUT"));
      } else if (overflow) {
        reject(new NativeReactBuildError("NATIVE_BUILD_LOG_LIMIT_EXCEEDED"));
      } else if (code !== 0) {
        reject(
          new NativeReactBuildError(
            "NATIVE_BUILD_COMPILE_FAILED",
            parseBuildDiagnostics(output),
          ),
        );
      } else {
        resolve(
          jsonBuffer({
            schemaVersion: 1,
            renderer: "twenty_first_native_react_v1",
            sourceFileCount: input.source.fileCount,
            buildLogBytes: output.length,
          }),
        );
      }
    });
  });
}

/** Compiles a previously validated archive with the same host-owned Vite
 * configuration used by preview and production. Provider package scripts and
 * provider build configuration are never executed; compilation runs in a
 * bounded child process with a minimal environment and no network grant. */
export async function compileValidatedNativeReactSource(input: {
  root: string;
  source: ValidatedNativeReactSource;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}) {
  assertNotAborted(input.abortSignal);
  await writeValidatedSource(input.root, input.source);
  const dependencies = archiveDependencies(input.source.packageJson);
  await linkHostDependencies(input.root, dependencies);
  const buildLog = await runControlledViteBuild({
    root: input.root,
    source: input.source,
    dependencies,
    timeoutMs: boundedTimeout(input.timeoutMs),
    abortSignal: input.abortSignal,
  });
  return {
    buildLog,
    dependencies,
    files: await readDistFiles(path.join(input.root, "dist")),
  };
}

function safeOutputPath(relative: string) {
  const normalized = relative.split(path.sep).join("/").normalize("NFKC");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    Buffer.byteLength(normalized, "utf8") > 300
  ) {
    throw new NativeReactBuildError("NATIVE_BUILD_DIST_INVALID");
  }
  return normalized;
}

async function readDistFiles(root: string) {
  const files: OutputFile[] = [];
  let totalBytes = 0;
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new NativeReactBuildError("NATIVE_BUILD_DIST_INVALID");
      }
      if (metadata.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!metadata.isFile()) {
        throw new NativeReactBuildError("NATIVE_BUILD_DIST_INVALID");
      }
      const relative = safeOutputPath(path.relative(root, absolute));
      if (metadata.size > MAX_DIST_FILE_BYTES) {
        throw new NativeReactBuildError("NATIVE_BUILD_DIST_LIMIT_EXCEEDED");
      }
      const content = await readFile(absolute);
      totalBytes += content.length;
      files.push({ path: relative, bytes: content });
      if (files.length > MAX_DIST_FILES || totalBytes > MAX_DIST_BYTES) {
        throw new NativeReactBuildError("NATIVE_BUILD_DIST_LIMIT_EXCEEDED");
      }
    }
  };
  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function upsertHeadMarkup(html: string, markup: string) {
  if (/<head\b[^>]*>/iu.test(html)) {
    return html.replace(/<head\b([^>]*)>/iu, `<head$1>${markup}`);
  }
  return html.replace(/<html\b([^>]*)>/iu, `<html$1><head>${markup}</head>`);
}

function normalizeRoutePages(input: {
  files: OutputFile[];
  routes: string[];
  mode: "preview" | "production";
  canonicalOrigin: string | null;
}) {
  const fileMap = new Map(input.files.map((file) => [file.path, file.bytes]));
  const root = fileMap.get("index.html");
  if (!root) throw new NativeReactBuildError("NATIVE_BUILD_ROUTE_MISSING");
  const rootHtml = root.toString("utf8");
  const routeOutputs = new Set(input.routes.map(routeOutput));
  routeOutputs.add("404.html");
  for (const output of routeOutputs) {
    const route =
      output === "404.html"
        ? null
        : input.routes.find((value) => routeOutput(value) === output)!;
    let html = rootHtml
      .replace(/<meta\s+name=["']robots["'][^>]*>/giu, "")
      .replace(/<link\s+rel=["']canonical["'][^>]*>/giu, "")
      .replace(
        /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/giu,
        "",
      );
    html = upsertHeadMarkup(
      html,
      `<meta http-equiv="Content-Security-Policy" content="${NATIVE_DOCUMENT_CSP}">`,
    );
    if (input.mode === "preview" || output === "404.html") {
      html = upsertHeadMarkup(
        html,
        '<meta name="robots" content="noindex,nofollow">',
      );
    } else {
      const canonical = new URL(route!, input.canonicalOrigin!).toString();
      html = upsertHeadMarkup(
        html,
        `<link rel="canonical" href="${canonical}">`,
      );
    }
    fileMap.set(output, Buffer.from(html, "utf8"));
  }
  if (input.mode === "preview") {
    fileMap.set(
      "robots.txt",
      Buffer.from("User-agent: *\nDisallow: /\n", "utf8"),
    );
    fileMap.delete("sitemap.xml");
  } else {
    const urls = input.routes
      .map(
        (route) =>
          `  <url><loc>${new URL(route, input.canonicalOrigin!).toString()}</loc></url>`,
      )
      .join("\n");
    fileMap.set(
      "sitemap.xml",
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
        "utf8",
      ),
    );
    fileMap.set(
      "robots.txt",
      Buffer.from(
        `User-agent: *\nAllow: /\nSitemap: ${input.canonicalOrigin}/sitemap.xml\n`,
        "utf8",
      ),
    );
  }
  return [...fileMap.entries()]
    .map(([filename, bytes]) => ({ path: filename, bytes }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

const DIST_SENSITIVE_TEXT =
  /(?:-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bLTAI[A-Za-z0-9]{12,}\b|\bsk-(?:live|proj)?-?[A-Za-z0-9_-]{20,}\b|(?:access[_-]?key[_-]?secret|api[_-]?key|app[_-]?secret|client[_-]?secret|private[_-]?key)\s*["']?\s*[:=]\s*["'][^"'\r\n]{12,}["'])/iu;

const SAFE_COMPILED_ABSOLUTE_URLS = new Set([
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/2000/xmlns/",
  "http://www.w3.org/2001/XMLSchema-instance",
  "http://www.w3.org/XML/1998/namespace",
  "http://www.sitemaps.org/schemas/sitemap/0.9",
]);

function compiledTextHasForbiddenExternalUrl(input: {
  text: string;
  mode: "preview" | "production";
  canonicalOrigin: string | null;
}) {
  const absoluteUrls = input.text.match(/https?:\/\/[^\s"'`<>{}\\]+/giu) ?? [];
  for (const raw of absoluteUrls) {
    if (
      SAFE_COMPILED_ABSOLUTE_URLS.has(raw) ||
      raw === "https://tailwindcss.com" ||
      raw.startsWith("https://react.dev/errors/")
    ) {
      continue;
    }
    if (input.mode === "production" && input.canonicalOrigin) {
      try {
        if (new URL(raw).origin === new URL(input.canonicalOrigin).origin) {
          continue;
        }
      } catch {
        return true;
      }
    }
    return true;
  }
  return /["'`]\/\/[A-Za-z0-9\[]/u.test(input.text);
}

function localReferencePath(raw: string, from: string) {
  const clean = raw.split(/[?#]/u, 1)[0]!;
  if (
    !clean ||
    clean.startsWith("#") ||
    /^(?:data:|blob:|mailto:|tel:)/iu.test(clean)
  ) {
    return null;
  }
  if (/^(?:https?:)?\/\//iu.test(clean)) return "__external__";
  const resolved = clean.startsWith("/")
    ? clean.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
  if (!resolved || resolved.startsWith("../") || resolved.includes("\\")) {
    return "__invalid__";
  }
  return resolved;
}

function assertStaticHardSafety(input: {
  files: OutputFile[];
  routes: string[];
  mode: "preview" | "production";
  canonicalOrigin: string | null;
  forbiddenTokens: string[];
}) {
  const fileMap = new Map(input.files.map((file) => [file.path, file.bytes]));
  const checks: NativeReactQaReportV1["checks"] = [];
  const requireCheck = (
    id: string,
    condition: boolean,
    detail: string,
    code: NativeReactBuildErrorCode,
  ) => {
    if (!condition) throw new NativeReactBuildError(code);
    checks.push({ id, passed: true, detail });
  };
  requireCheck(
    "route-manifest",
    input.routes.every((route) => fileMap.has(routeOutput(route))) &&
      fileMap.has("404.html"),
    `${input.routes.length} routes and 404 are present`,
    "NATIVE_BUILD_ROUTE_MISSING",
  );
  const textFiles = input.files.filter((file) =>
    /\.(?:css|html|js|json|mjs|svg|txt|xml)$/iu.test(file.path),
  );
  requireCheck(
    "secret-scan",
    input.files.every(
      (file) =>
        !DIST_SENSITIVE_TEXT.test(file.bytes.toString("latin1")) &&
        input.forbiddenTokens.every(
          (token) =>
            token.length === 0 || !file.bytes.includes(Buffer.from(token)),
        ),
    ),
    "compiled output contains no credential-shaped material",
    "NATIVE_BUILD_SECRET_FORBIDDEN",
  );
  for (const file of textFiles) {
    const text = file.bytes.toString("utf8");
    requireCheck(
      `external-url-literals:${file.path}`,
      !compiledTextHasForbiddenExternalUrl({
        text,
        mode: input.mode,
        canonicalOrigin: input.canonicalOrigin,
      }),
      "compiled text contains no untrusted external URL literal",
      "NATIVE_BUILD_NETWORK_FORBIDDEN",
    );
    if (/\.html$/iu.test(file.path)) {
      requireCheck(
        `no-frame:${file.path}`,
        !/<(?:iframe|object|embed)\b/iu.test(text),
        "embedded browsing contexts are absent",
        "NATIVE_BUILD_NETWORK_FORBIDDEN",
      );
      const resourceReferences = [
        ...text.matchAll(
          /<(?:script|img|source|video|audio)\b[^>]*\bsrc=["']([^"']+)["']/giu,
        ),
        ...text.matchAll(
          /<link\b(?=[^>]*\brel=["'](?:stylesheet|icon|preload|modulepreload)["'])[^>]*\bhref=["']([^"']+)["']/giu,
        ),
      ].map((match) => match[1]!);
      for (const reference of resourceReferences) {
        const local = localReferencePath(reference, file.path);
        requireCheck(
          `resource-origin:${file.path}`,
          local !== "__external__" && local !== "__invalid__",
          "resource URLs stay on the generated origin",
          "NATIVE_BUILD_NETWORK_FORBIDDEN",
        );
        if (local) {
          requireCheck(
            `local-asset:${file.path}:${local}`,
            fileMap.has(local),
            "referenced local asset exists",
            "NATIVE_BUILD_LOCAL_ASSET_MISSING",
          );
        }
      }
    }
    if (/\.css$/iu.test(file.path)) {
      for (const match of text.matchAll(
        /url\(\s*["']?([^"')]+)["']?\s*\)/giu,
      )) {
        const local = localReferencePath(match[1]!, file.path);
        requireCheck(
          `css-resource-origin:${file.path}`,
          local !== "__external__" && local !== "__invalid__",
          "CSS resources stay on the generated origin",
          "NATIVE_BUILD_NETWORK_FORBIDDEN",
        );
        if (local) {
          requireCheck(
            `css-local-asset:${file.path}:${local}`,
            fileMap.has(local),
            "CSS local asset exists",
            "NATIVE_BUILD_LOCAL_ASSET_MISSING",
          );
        }
      }
    }
    if (/\.(?:js|mjs)$/iu.test(file.path)) {
      requireCheck(
        `compiled-network:${file.path}`,
        !/(?:src|poster)\s*:\s*["'](?:https?:)?\/\//iu.test(text),
        "compiled code contains no external resource binding",
        "NATIVE_BUILD_NETWORK_FORBIDDEN",
      );
      for (const match of text.matchAll(
        /(?:src|poster)\s*:\s*["'](\/[a-zA-Z0-9_./-]+)["']/gu,
      )) {
        const local = match[1]!.slice(1);
        requireCheck(
          `compiled-local-asset:${file.path}:${local}`,
          fileMap.has(local),
          "compiled local media asset exists",
          "NATIVE_BUILD_LOCAL_ASSET_MISSING",
        );
      }
    }
  }
  if (input.mode === "preview") {
    requireCheck(
      "preview-noindex",
      input.routes.every((route) =>
        fileMap
          .get(routeOutput(route))!
          .toString("utf8")
          .includes('name="robots" content="noindex,nofollow"'),
      ),
      "all preview routes are noindex",
      "NATIVE_BUILD_DIST_INVALID",
    );
  } else {
    requireCheck(
      "production-canonical",
      input.routes.every((route) =>
        fileMap
          .get(routeOutput(route))!
          .toString("utf8")
          .includes(
            `href="${new URL(route, input.canonicalOrigin!).toString()}"`,
          ),
      ),
      "all production routes bind the requested canonical origin",
      "NATIVE_BUILD_DIST_INVALID",
    );
  }
  return checks;
}

function servedMime(filename: string) {
  const extension = path.posix.extname(filename).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if ([".js", ".mjs"].includes(extension))
    return "text/javascript; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".woff2") return "font/woff2";
  if (extension === ".json") return "application/json";
  return "application/octet-stream";
}

type NativeBrowserRuntimeFailureCode =
  | "NATIVE_BROWSER_PAGE_ERROR"
  | "NATIVE_BROWSER_CONSOLE_ERROR";

async function assertNativeBrowserRouteRendered(
  page: Page,
  runtimeFailureCodes: ReadonlySet<NativeBrowserRuntimeFailureCode>,
) {
  await page.waitForTimeout(250);
  if (runtimeFailureCodes.size > 0) {
    throw new NativeReactBuildError("NATIVE_BUILD_RENDER_FAILED");
  }
  const rootState = await page.evaluate(() => {
    const root = document.querySelector("#root");
    if (!root) {
      return {
        exists: false,
        hasContent: false,
        hasLayout: false,
        hasVisibleContent: false,
      };
    }
    const visible = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      let current: Element | null = element;
      while (current) {
        const style = window.getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.contentVisibility === "hidden" ||
          Number.parseFloat(style.opacity) === 0
        ) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    };
    const rootBounds = root.getBoundingClientRect();
    const hasDirectText = [...root.childNodes].some(
      (node) =>
        node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
    );
    return {
      exists: true,
      hasContent: hasDirectText || root.children.length > 0,
      hasLayout: rootBounds.width > 0 && rootBounds.height > 0,
      hasVisibleContent:
        (hasDirectText && visible(root)) ||
        [...root.querySelectorAll("*")].some(visible),
    };
  });
  if (
    runtimeFailureCodes.size > 0 ||
    !rootState.exists ||
    !rootState.hasContent ||
    !rootState.hasLayout ||
    !rootState.hasVisibleContent
  ) {
    throw new NativeReactBuildError("NATIVE_BUILD_RENDER_FAILED");
  }
}

async function runBrowserQaStrict(input: {
  files: OutputFile[];
  routes: string[];
  mode: "preview" | "production";
  workRoot: string;
  runLighthouse: boolean;
  abortSignal?: AbortSignal;
}) {
  const fileMap = new Map(input.files.map((file) => [file.path, file.bytes]));
  const warnings: NativeReactBuildWarning[] = [];
  const screenshots: OutputFile[] = [];
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      if (
        decoded.includes("\\") ||
        decoded.includes("\0") ||
        decoded.split("/").some((part) => part === "." || part === "..")
      ) {
        response.writeHead(400).end();
        return;
      }
      const clean = decoded.replace(/^\/+|\/+$/gu, "");
      const candidates = clean
        ? path.posix.extname(clean)
          ? [clean]
          : [`${clean}/index.html`, clean]
        : ["index.html"];
      const filename = candidates.find((candidate) => fileMap.has(candidate));
      const bytes = filename ? fileMap.get(filename) : fileMap.get("404.html");
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(filename ? 200 : 404, {
        "Cache-Control": "no-store",
        "Content-Type": servedMime(filename ?? "404.html"),
        "Content-Length": bytes.length,
        "Content-Security-Policy": NATIVE_DOCUMENT_CSP,
        ...(input.mode === "preview"
          ? { "X-Robots-Tag": "noindex, nofollow, noarchive" }
          : {}),
      });
      response.end(bytes);
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("NATIVE_BROWSER_SERVER_UNAVAILABLE");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const closeServer = async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  let axeViolationCount = 0;
  const axeViolationIds = new Set<string>();
  let browserAvailable = false;
  try {
    assertNotAborted(input.abortSignal);
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: false,
      args: ["--disable-background-networking", "--disable-sync"],
      env: {
        HOME: input.workRoot,
        LANG: "C.UTF-8",
        TZ: "UTC",
        PATH: path.dirname(process.execPath),
      },
    });
    try {
      browserAvailable = true;
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      const runtimeFailureCodes = new Set<NativeBrowserRuntimeFailureCode>();
      let externalRequestDetected = false;
      let cspViolationDetected = false;
      page.on("pageerror", () => {
        runtimeFailureCodes.add("NATIVE_BROWSER_PAGE_ERROR");
      });
      await page.exposeBinding("__frontmindNativeConsoleError", () => {
        runtimeFailureCodes.add("NATIVE_BROWSER_CONSOLE_ERROR");
      });
      await page.exposeBinding("__frontmindNativePolicyViolation", () => {
        cspViolationDetected = true;
      });
      await page.addInitScript(() => {
        const scope = globalThis as typeof globalThis & {
          __frontmindNativeConsoleError: () => Promise<void>;
          __frontmindNativePolicyViolation: () => Promise<void>;
        };
        const originalConsoleError = console.error.bind(console);
        console.error = (...args: unknown[]) => {
          void scope.__frontmindNativeConsoleError();
          originalConsoleError(...args);
        };
        document.addEventListener("securitypolicyviolation", (event) => {
          const blocked = event.blockedURI;
          if (
            /^(?:https?:)?\/\//iu.test(blocked) &&
            new URL(blocked, window.location.href).origin !==
              window.location.origin
          ) {
            void scope.__frontmindNativePolicyViolation();
          }
        });
      });
      await page.route("**/*", async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin !== origin) {
          externalRequestDetected = true;
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });
      const navigateAndAssertRendered = async (route: string) => {
        runtimeFailureCodes.clear();
        const response = await page.goto(`${origin}${route}`, {
          waitUntil: "networkidle",
          timeout: 15_000,
        });
        if (!response?.ok()) {
          throw new NativeReactBuildError("NATIVE_BUILD_RENDER_FAILED");
        }
        if (externalRequestDetected || cspViolationDetected) {
          throw new NativeReactBuildError("NATIVE_BUILD_NETWORK_FORBIDDEN");
        }
        await assertNativeBrowserRouteRendered(page, runtimeFailureCodes);
        if (externalRequestDetected || cspViolationDetected) {
          throw new NativeReactBuildError("NATIVE_BUILD_NETWORK_FORBIDDEN");
        }
      };
      for (const [routeIndex, route] of input.routes.entries()) {
        await navigateAndAssertRendered(route);
        if (routeIndex >= 3) continue;
        const axe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        for (const violation of axe.violations.filter((value) =>
          ["critical", "serious"].includes(value.impact ?? ""),
        )) {
          axeViolationCount += 1;
          axeViolationIds.add(violation.id);
        }
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await navigateAndAssertRendered("/");
      screenshots.push({
        path: "screenshots/home-1440.png",
        bytes: Buffer.from(
          await page.screenshot({ fullPage: true, type: "png" }),
        ),
      });
      await page.setViewportSize({ width: 390, height: 844 });
      screenshots.push({
        path: "screenshots/home-390.png",
        bytes: Buffer.from(
          await page.screenshot({ fullPage: true, type: "png" }),
        ),
      });
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (error) {
    if (input.abortSignal?.aborted) {
      await closeServer();
      throw new NativeReactBuildError("NATIVE_BUILD_ABORTED");
    }
    if (error instanceof NativeReactBuildError) {
      await closeServer();
      throw error;
    }
    warnings.push({
      phase: "browser_qa",
      code: "NATIVE_BROWSER_QA_UNAVAILABLE",
      checkId: "browser:runtime",
    });
  }
  for (const violationId of [...axeViolationIds].sort()) {
    warnings.push({
      phase: "browser_qa",
      code: "NATIVE_AXE_WARNING",
      checkId: `axe:${violationId}`,
    });
  }
  const lighthouseScores = {
    performance: null as number | null,
    accessibility: null as number | null,
    bestPractices: null as number | null,
    seo: null as number | null,
    cls: null as number | null,
  };
  if (input.runLighthouse && browserAvailable) {
    const chromeRoot = path.join(input.workRoot, "lighthouse");
    try {
      await mkdir(chromeRoot, { recursive: true, mode: 0o700 });
      const launched = await launchChrome({
        chromePath: chromium.executablePath(),
        chromeFlags: [
          "--headless=new",
          "--disable-background-networking",
          "--disable-extensions",
          "--disable-sync",
          "--no-first-run",
          "--no-sandbox",
        ],
        userDataDir: path.join(chromeRoot, "profile"),
        handleSIGINT: false,
        logLevel: "silent",
        envVars: {
          HOME: chromeRoot,
          LANG: "C.UTF-8",
          TZ: "UTC",
          PATH: path.dirname(process.execPath),
        },
      });
      try {
        const result = await lighthouse(`${origin}/`, {
          port: launched.port,
          output: "json",
          logLevel: "silent",
          onlyCategories: [
            "performance",
            "accessibility",
            "best-practices",
            "seo",
          ],
          skipAudits: input.mode === "preview" ? ["is-crawlable"] : undefined,
        });
        if (!result?.lhr) throw new Error("NATIVE_LIGHTHOUSE_NO_RESULT");
        const score = (name: string) =>
          Math.round((result.lhr.categories[name]?.score ?? 0) * 100);
        lighthouseScores.performance = score("performance");
        lighthouseScores.accessibility = score("accessibility");
        lighthouseScores.bestPractices = score("best-practices");
        lighthouseScores.seo = score("seo");
        lighthouseScores.cls = Number(
          result.lhr.audits["cumulative-layout-shift"]?.numericValue ?? 1,
        );
        if (
          lighthouseScores.performance < 85 ||
          lighthouseScores.accessibility < 95 ||
          lighthouseScores.bestPractices < 90 ||
          lighthouseScores.seo < 95 ||
          lighthouseScores.cls >= 0.1
        ) {
          warnings.push({
            phase: "lighthouse",
            code: "NATIVE_LIGHTHOUSE_WARNING",
            checkId: "lighthouse:threshold",
          });
        }
      } finally {
        try {
          launched.kill();
        } catch {
          // Lighthouse/Chromium failures are reported as non-blocking QA.
        }
      }
    } catch {
      warnings.push({
        phase: "lighthouse",
        code: "NATIVE_LIGHTHOUSE_UNAVAILABLE",
        checkId: "lighthouse:runtime",
      });
    }
  } else if (!input.runLighthouse) {
    warnings.push({
      phase: "lighthouse",
      code: "NATIVE_LIGHTHOUSE_SKIPPED",
      checkId: "lighthouse:skipped",
    });
  }
  await closeServer();
  return {
    summary: {
      available: browserAvailable,
      lighthouse: lighthouseScores,
      axeViolationCount,
      axeViolationIds: [...axeViolationIds].sort(),
      screenshotFiles: screenshots.map((file) => file.path),
    },
    warnings,
    screenshots,
  };
}

async function runBrowserQa(input: Parameters<typeof runBrowserQaStrict>[0]) {
  try {
    return await runBrowserQaStrict(input);
  } catch (error) {
    if (
      input.abortSignal?.aborted ||
      (error instanceof NativeReactBuildError &&
        error.code === "NATIVE_BUILD_ABORTED")
    ) {
      throw new NativeReactBuildError("NATIVE_BUILD_ABORTED");
    }
    if (error instanceof NativeReactBuildError) throw error;
    return {
      summary: {
        available: false,
        lighthouse: {
          performance: null,
          accessibility: null,
          bestPractices: null,
          seo: null,
          cls: null,
        },
        axeViolationCount: 0,
        axeViolationIds: [] as string[],
        screenshotFiles: [] as string[],
      },
      warnings: [
        {
          phase: "browser_qa" as const,
          code: "NATIVE_BROWSER_QA_UNAVAILABLE",
          checkId: "browser:runtime",
        },
      ],
      screenshots: [] as OutputFile[],
    };
  }
}

async function deterministicZip(
  files: readonly OutputFile[],
  maxBytes: number,
) {
  const archive = new JSZip();
  let total = 0;
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    total += file.bytes.length;
    if (total > maxBytes)
      throw new NativeReactBuildError("NATIVE_BUILD_DIST_LIMIT_EXCEEDED");
    archive.file(file.path, file.bytes, {
      date: FIXED_ZIP_DATE,
      createFolders: false,
      unixPermissions: 0o100644,
    });
  }
  const output = await archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (output.length > maxBytes)
    throw new NativeReactBuildError("NATIVE_BUILD_DIST_LIMIT_EXCEEDED");
  return output;
}

function validateSourceBinding(input: NativeReactBuildInput) {
  const sourceHash = sha256(input.sourceZip);
  if (
    sourceHash !== input.validatedSource.sourceSha256 ||
    sourceHash !== input.validatedSource.archiveSha256 ||
    !input.sourceZip.equals(input.validatedSource.sourceZip) ||
    !input.validatedSource.files.has(input.validatedSource.htmlEntrypoint) ||
    !input.validatedSource.files.has(input.validatedSource.entrypoint)
  ) {
    throw new NativeReactBuildError("NATIVE_BUILD_SOURCE_MISMATCH");
  }
  return sourceHash;
}

export async function materializeNativeReactSource(
  input: NativeReactBuildInput,
): Promise<MaterializedNativeReactSite> {
  assertNotAborted(input.abortSignal);
  const parsedBuild = buildCoordinatesSchema.safeParse(input.build);
  const parsedBrief = siteBriefSchema.safeParse(input.brief);
  if (!parsedBuild.success || !parsedBrief.success) {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  const build = parsedBuild.data;
  const brief = parsedBrief.data;
  const routes = brief.routes.map((route) => routePath(route.slug));
  if (new Set(routes).size !== routes.length) {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  const canonicalOrigin = validateCanonicalOrigin(
    input.mode,
    input.canonicalOrigin,
  );
  const target =
    input.mode === "production"
      ? input.target === "global_excluding_cn" || input.target === "mainland_cn"
        ? input.target
        : null
      : null;
  if (input.mode === "production" && target === null) {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  const sourceSha256 = validateSourceBinding(input);
  const dependencies = archiveDependencies(input.validatedSource.packageJson);
  const root = await mkdtemp(path.join(tmpdir(), "frontmind-native-react-"));
  try {
    const compiled = await compileValidatedNativeReactSource({
      root,
      source: input.validatedSource,
      timeoutMs: input.timeoutMs,
      abortSignal: input.abortSignal,
    });
    const buildLog = compiled.buildLog;
    let files = compiled.files;
    files = normalizeRoutePages({
      files,
      routes,
      mode: input.mode,
      canonicalOrigin,
    });
    const checks = assertStaticHardSafety({
      files,
      routes,
      mode: input.mode,
      canonicalOrigin,
      forbiddenTokens: [input.validatedSource.receipt.operationToken],
    });
    const browserQa =
      input.browserQa === false
        ? {
            summary: {
              available: false,
              lighthouse: {
                performance: null,
                accessibility: null,
                bestPractices: null,
                seo: null,
                cls: null,
              },
              axeViolationCount: 0,
              axeViolationIds: [] as string[],
              screenshotFiles: [] as string[],
            },
            warnings: [
              {
                phase: "browser_qa" as const,
                code: "NATIVE_BROWSER_QA_SKIPPED",
                checkId: "browser:skipped",
              },
            ],
            screenshots: [] as OutputFile[],
          }
        : await runBrowserQa({
            files,
            routes,
            mode: input.mode,
            workRoot: root,
            runLighthouse: input.lighthouseQa !== false,
            abortSignal: input.abortSignal,
          });
    const screenshotBytes = browserQa.screenshots.reduce(
      (total, file) => total + file.bytes.length,
      0,
    );
    const visualScreenshots =
      screenshotBytes <= 20 * 1024 * 1024 ? browserQa.screenshots : [];
    if (visualScreenshots.length !== browserQa.screenshots.length) {
      browserQa.warnings.push({
        phase: "browser_qa",
        code: "NATIVE_BROWSER_SCREENSHOT_LIMIT",
        checkId: "browser:screenshot-limit",
      });
      browserQa.summary.screenshotFiles = [];
    }
    const warningCodes = [
      ...new Set(browserQa.warnings.map((warning) => warning.code)),
    ].sort();
    const buildDelivery: NativeReactBuildDelivery = {
      renderMode: NATIVE_RENDERER,
      qaStatus: warningCodes.length > 0 ? "passed_with_warnings" : "passed",
      warningCodes,
    };
    const distZip = await deterministicZip(files, MAX_DIST_BYTES);
    const distSha256 = sha256(distZip);
    const contract: NativeReactBuildContractV1 = {
      schemaVersion: 1,
      contractKind: "twenty_first_native_build_contract",
      renderer: "twenty_first_native_react_v1",
      buildId: build.id,
      projectId: build.projectId,
      mode: input.mode,
      canonicalOrigin,
      target,
      routes,
      sourceSha256,
      distSha256,
    };
    const contractJson = jsonBuffer(contract);
    const qa: NativeReactQaReportV1 = {
      schemaVersion: 1,
      policyVersion: NATIVE_QA_POLICY,
      passed: true,
      mode: input.mode,
      routes,
      checks,
      browser: browserQa.summary,
      buildDelivery,
      warnings: browserQa.warnings,
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.bytes.length, 0),
    };
    const qaJson = jsonBuffer(qa);
    const visualQaZip = await deterministicZip(
      [{ path: "visual-qa/report.json", bytes: qaJson }, ...visualScreenshots],
      MAX_DIST_BYTES,
    );
    const provenance = {
      schemaVersion: 1,
      renderer: "twenty_first_native_react_v1",
      buildId: build.id,
      projectId: build.projectId,
      knowledgeSnapshotId: build.knowledgeSnapshotId ?? null,
      workflowVersion: build.workflowVersion ?? null,
      selectionHash: build.selectionHash ?? null,
      sourceSha256,
      distSha256,
      providerCodeReused: true,
      providerPromptPersisted: false,
      providerPackageScriptsExecuted: false,
      providerViteConfigExecuted: false,
      runtimeInstallPerformed: false,
      linkedHostDependencies: dependencies,
      buildDelivery,
    };
    const provenanceJson = jsonBuffer(provenance);
    return {
      contract,
      contractJson,
      contractSha256: sha256(contractJson),
      sourceZip: Buffer.from(input.sourceZip),
      sourceSha256,
      distZip,
      distSha256,
      qaJson,
      qaSha256: sha256(qaJson),
      visualQaZip,
      visualQaSha256: sha256(visualQaZip),
      provenanceJson,
      provenanceSha256: sha256(provenanceJson),
      buildLog,
      files: new Map(files.map((file) => [file.path, file.bytes])),
      buildDelivery,
    };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Production promotion rebuilds the exact stored source archive under a new
 * trusted canonical origin. It never re-runs Manus or package scripts. */
export function rebuildNativeReactProductionFromSource(
  input: Omit<NativeReactBuildInput, "mode" | "canonicalOrigin" | "target"> & {
    canonicalOrigin: string;
    target: "global_excluding_cn" | "mainland_cn";
  },
) {
  return materializeNativeReactSource({
    ...input,
    mode: "production",
    canonicalOrigin: input.canonicalOrigin,
    target: input.target,
  });
}
