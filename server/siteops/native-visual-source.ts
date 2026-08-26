import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { chromium, type Page } from "playwright";
import { z } from "zod";

import {
  visualSelectionBundleV5Schema,
  type VisualSelectionBundleV5,
} from "../../shared/siteops";
import {
  canonicalJson,
  canonicalSha256,
  providerItemKey,
  type NormalizedTwentyFirstCandidate,
} from "../../shared/siteops-workflow";
import {
  installedNativeSourceDependencyVersion,
  validateNativeReactSourceArchive,
} from "./native-react-source";
import { compileValidatedNativeReactSource } from "./native-react-build-runtime";

export const SITEOPS_NATIVE_VISUAL_WORKFLOW_VERSION = "2.5.0" as const;
export const VISUAL_SELECTION_BUNDLE_V5_MIME_TYPE = "application/zip" as const;
export const VISUAL_SELECTION_BUNDLE_V5_MAX_BYTES = 25 * 1024 * 1024;
export const NATIVE_VISUAL_SOURCE_ARCHIVE_MAX_BYTES = 2_500_000;

const NATIVE_SOURCE_DIRECTORY = "source";
const NATIVE_SOURCE_MANIFEST_PATH = "frontmind-native-source-v1.json";
const NATIVE_SOURCE_MANIFEST_ARCHIVE_PATH = `${NATIVE_SOURCE_DIRECTORY}/${NATIVE_SOURCE_MANIFEST_PATH}`;
const V5_SELECTION_MANIFEST_PATH = "visual-selection-v5.json";
const MAX_SOURCE_FILES = 160;
const MAX_SOURCE_FILE_BYTES = 512_000;
const MAX_SOURCE_TOTAL_BYTES = 2_000_000;
const MAX_DEPENDENCIES = 80;
const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");
const CONTROLLED_HTML_ENTRYPOINT = "index.html";
const CONTROLLED_APP_ENTRYPOINT = "src/main.tsx";
const CONTROLLED_TAILWIND_STYLESHEET = "src/frontmind-tailwind.css";
const CONTROLLED_PACKAGE_MANIFEST = "package.json";
const CONTROLLED_SOURCE_PATHS = new Set([
  CONTROLLED_HTML_ENTRYPOINT,
  CONTROLLED_APP_ENTRYPOINT,
  CONTROLLED_TAILWIND_STYLESHEET,
  CONTROLLED_PACKAGE_MANIFEST,
  NATIVE_SOURCE_MANIFEST_PATH,
]);
const CONTROLLED_COMPILER_DEPENDENCIES = [
  "@tailwindcss/vite",
  "@vitejs/plugin-react",
  "tailwindcss",
  "vite",
] as const;

const sourcePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(
    /^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.(?:[cm]?[jt]sx?|css|html|json|svg|png|jpe?g|webp|gif|woff2)$/u,
  );

const nativeSourceManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    renderer: z.literal("twenty_first_native_react_v1"),
    providerItemKey: z.string().trim().min(3).max(514),
    providerVersion: z.string().trim().min(1).max(191).nullable(),
    entrypoint: sourcePathSchema,
    demoEntrypoint: sourcePathSchema,
    dependencies: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(191),
            installedVersion: z
              .string()
              .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
          })
          .strict(),
      )
      .max(MAX_DEPENDENCIES),
    htmlEntrypoint: z.literal(CONTROLLED_HTML_ENTRYPOINT),
    appEntrypoint: z.literal(CONTROLLED_APP_ENTRYPOINT),
    files: z
      .array(
        z
          .object({
            path: sourcePathSchema,
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            bytes: z.number().int().positive().max(MAX_SOURCE_FILE_BYTES),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_SOURCE_FILES),
    sourceTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type NativeSourceManifestV1 = z.infer<
  typeof nativeSourceManifestV1Schema
>;

export type NativeSourceFile = {
  path: string;
  bytes: Buffer;
};

export type NativeSourceDependency = {
  name: string;
  installedVersion: string;
};

export type NormalizedTwentyFirstNativeSource = {
  providerItemKey: string;
  providerVersion: string | null;
  entrypoint: string;
  demoEntrypoint: string;
  dependencies: NativeSourceDependency[];
  htmlEntrypoint: typeof CONTROLLED_HTML_ENTRYPOINT;
  appEntrypoint: typeof CONTROLLED_APP_ENTRYPOINT;
  files: NativeSourceFile[];
  sourceTreeSha256: string;
};

export type PreparedNativeVisualCandidate =
  NormalizedTwentyFirstNativeSource & {
    sourceArchive: Buffer;
    sourceArchiveSha256: string;
    preview: Buffer;
    previewSha256: string;
  };

type PayloadRecord = Record<string, unknown>;

type BoundedZipEntry = JSZip.JSZipObject & {
  unsafeOriginalName?: string;
  _data?: { uncompressedSize?: number };
};

class NativeVisualSourceError extends Error {
  constructor(
    public readonly code: string,
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "NativeVisualSourceError";
  }
}

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function zipEntryIsSymlink(entry: BoundedZipEntry) {
  const permissions = entry.unixPermissions;
  const mode =
    typeof permissions === "number"
      ? permissions
      : typeof permissions === "string" && /^[0-7]+$/u.test(permissions)
        ? Number.parseInt(permissions, 8)
        : 0;
  return Boolean(mode && (mode & 0o170000) === 0o120000);
}

function cleanVersion(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim();
  return normalized && normalized.length <= 191 ? normalized : null;
}

function normalizedSourcePath(value: unknown) {
  if (typeof value !== "string") return null;
  const candidate = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    candidate.startsWith("/") ||
    candidate.includes("\0") ||
    candidate
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  const parsed = sourcePathSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function collectRecords(
  value: unknown,
  depth = 0,
  records: PayloadRecord[] = [],
) {
  if (depth > 6 || !value || typeof value !== "object") return records;
  if (Array.isArray(value)) {
    value
      .slice(0, 160)
      .forEach((item) => collectRecords(item, depth + 1, records));
    return records;
  }
  const record = value as PayloadRecord;
  records.push(record);
  for (const key of [
    "data",
    "result",
    "payload",
    "component",
    "detail",
    "source",
    "demo",
    "structuredContent",
  ]) {
    collectRecords(record[key], depth + 1, records);
  }
  return records;
}

function firstString(
  records: readonly PayloadRecord[],
  keys: readonly string[],
) {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}

function parseDependencyName(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 191 || /[\s\\]/u.test(trimmed)) return null;
  if (trimmed.startsWith("@")) {
    const slash = trimmed.indexOf("/");
    if (slash < 2) return null;
    const versionAt = trimmed.indexOf("@", slash);
    return versionAt > slash ? trimmed.slice(0, versionAt) : trimmed;
  }
  const versionAt = trimmed.indexOf("@");
  return versionAt > 0 ? trimmed.slice(0, versionAt) : trimmed;
}

const ALLOWED_NATIVE_DEPENDENCIES = new Set([
  "@tailwindcss/vite",
  "@vitejs/plugin-react",
  "@radix-ui/react-accordion",
  "@radix-ui/react-aspect-ratio",
  "@radix-ui/react-avatar",
  "@radix-ui/react-checkbox",
  "@radix-ui/react-collapsible",
  "@radix-ui/react-context-menu",
  "@radix-ui/react-dialog",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-hover-card",
  "@radix-ui/react-label",
  "@radix-ui/react-menubar",
  "@radix-ui/react-navigation-menu",
  "@radix-ui/react-popover",
  "@radix-ui/react-progress",
  "@radix-ui/react-radio-group",
  "@radix-ui/react-scroll-area",
  "@radix-ui/react-select",
  "@radix-ui/react-separator",
  "@radix-ui/react-slider",
  "@radix-ui/react-slot",
  "@radix-ui/react-switch",
  "@radix-ui/react-tabs",
  "@radix-ui/react-toggle",
  "@radix-ui/react-toggle-group",
  "@radix-ui/react-tooltip",
  "class-variance-authority",
  "clsx",
  "embla-carousel-react",
  "framer-motion",
  "lucide-react",
  "react",
  "react-dom",
  "tailwind-merge",
  "tailwindcss",
  "vite",
]);

function collectDependencies(records: readonly PayloadRecord[]) {
  const names = new Set<string>([
    "react",
    "react-dom",
    ...CONTROLLED_COMPILER_DEPENDENCIES,
  ]);
  for (const record of records) {
    for (const key of [
      "dependencies",
      "dependency",
      "registryDependencies",
      "registry_dependencies",
      "npmDependencies",
    ]) {
      const value = record[key];
      const candidates = Array.isArray(value)
        ? value
        : value && typeof value === "object"
          ? Object.keys(value as Record<string, unknown>)
          : typeof value === "string"
            ? value.split(/[\s,]+/u)
            : [];
      for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        const name = parseDependencyName(candidate);
        if (name) names.add(name);
      }
    }
  }
  const dependencies = [...names].sort();
  if (
    dependencies.length > MAX_DEPENDENCIES ||
    dependencies.some(
      (dependency) => !ALLOWED_NATIVE_DEPENDENCIES.has(dependency),
    )
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_DEPENDENCY_UNSAFE");
  }
  return dependencies.map((name) => ({
    name,
    installedVersion: installedNativeSourceDependencyVersion(name),
  }));
}

function isTextSourcePath(filename: string) {
  return /\.(?:[cm]?[jt]sx?|css|json|svg)$/u.test(filename);
}

function bytesFromFileValue(value: unknown, filename: string) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (!value || typeof value !== "object") return null;
  const record = value as PayloadRecord;
  for (const key of ["content", "code", "source", "text"]) {
    if (typeof record[key] === "string")
      return Buffer.from(record[key], "utf8");
  }
  if (typeof record.base64 === "string" && !isTextSourcePath(filename)) {
    try {
      return Buffer.from(record.base64, "base64");
    } catch {
      return null;
    }
  }
  return null;
}

function collectProviderFiles(records: readonly PayloadRecord[]) {
  const files = new Map<string, Buffer>();
  for (const record of records) {
    const raw = record.files ?? record.sourceFiles ?? record.source_files;
    if (Array.isArray(raw)) {
      for (const item of raw.slice(0, MAX_SOURCE_FILES)) {
        if (!item || typeof item !== "object") continue;
        const row = item as PayloadRecord;
        const filename = normalizedSourcePath(
          row.path ?? row.filename ?? row.name,
        );
        if (!filename)
          throw new NativeVisualSourceError("NATIVE_SOURCE_PATH_UNSAFE");
        const bytes = bytesFromFileValue(row, filename);
        if (!bytes) continue;
        files.set(filename, bytes);
      }
    } else if (raw && typeof raw === "object") {
      for (const [rawPath, value] of Object.entries(raw as PayloadRecord).slice(
        0,
        MAX_SOURCE_FILES,
      )) {
        const filename = normalizedSourcePath(rawPath);
        if (!filename)
          throw new NativeVisualSourceError("NATIVE_SOURCE_PATH_UNSAFE");
        const bytes = bytesFromFileValue(value, filename);
        if (bytes) files.set(filename, bytes);
      }
    }
  }
  return files;
}

function inferCodePath(input: {
  records: readonly PayloadRecord[];
  keys: readonly string[];
  pathKeys: readonly string[];
  fallback: string;
}) {
  const source = firstString(input.records, input.keys);
  if (!source) return null;
  const advertisedPath = normalizedSourcePath(
    firstString(input.records, input.pathKeys),
  );
  return {
    path: advertisedPath ?? input.fallback,
    bytes: Buffer.from(source, "utf8"),
  };
}

function sourceImports(text: string) {
  return [
    ...text.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/gu,
    ),
  ].map((match) => match[1]!);
}

function packageNameForImport(specifier: string) {
  if (specifier.startsWith("@/")) return null;
  if (specifier.startsWith(".")) return null;
  if (specifier.startsWith("@"))
    return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0]!;
}

function assertHardSourceSafety(
  files: readonly NativeSourceFile[],
  dependencies: readonly NativeSourceDependency[],
) {
  const declared = new Set(dependencies.map((dependency) => dependency.name));
  const declaredVersions = new Map(
    dependencies.map((dependency) => [
      dependency.name,
      dependency.installedVersion,
    ]),
  );
  for (const file of files) {
    if (!isTextSourcePath(file.path)) continue;
    const text = file.bytes.toString("utf8");
    if (Buffer.from(text, "utf8").length !== file.bytes.length) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_TEXT_ENCODING_INVALID");
    }
    if (
      /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bLTAI[A-Za-z0-9]{12,}\b|\bsk-(?:live|proj)?-?[A-Za-z0-9_-]{20,}\b/u.test(
        text,
      ) ||
      /\b(?:eval|Function)\s*\(|\bnew\s+Function\b|\bimport\s*\(|\brequire\s*\([^"']/u.test(
        text,
      ) ||
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|navigator\.sendBeacon\s*\(/u.test(
        text,
      ) ||
      /dangerouslySetInnerHTML|\b(?:node:)?(?:fs|child_process|worker_threads|vm|net|tls|dgram|cluster)\b/u.test(
        text,
      ) ||
      /<\s*(?:script|iframe|object|embed)\b/iu.test(text) ||
      /(?:javascript|vbscript|data\s*:\s*text\/html)\s*:/iu.test(text) ||
      /https?:\/\//iu.test(text) ||
      /\bprocess\s*\.|\bglobalThis\s*\[|\bdocument\.cookie\b/u.test(text)
    ) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_EXECUTION_UNSAFE");
    }
    if (
      file.path.endsWith(".css") &&
      /(?:@import\s+|url\s*\()\s*["']?(?:\.\.\/|\/\/|https?:)/iu.test(text)
    ) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_IMPORT_UNSAFE");
    }
    if (path.posix.basename(file.path) === "package.json") {
      let manifest: unknown;
      try {
        manifest = JSON.parse(text);
      } catch {
        throw new NativeVisualSourceError("NATIVE_SOURCE_PACKAGE_INVALID");
      }
      if (
        !manifest ||
        typeof manifest !== "object" ||
        Array.isArray(manifest)
      ) {
        throw new NativeVisualSourceError("NATIVE_SOURCE_PACKAGE_INVALID");
      }
      const record = manifest as Record<string, unknown>;
      if (
        record.scripts !== undefined ||
        record.optionalDependencies !== undefined ||
        record.bundledDependencies !== undefined
      ) {
        throw new NativeVisualSourceError("NATIVE_SOURCE_LIFECYCLE_UNSAFE");
      }
      for (const key of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
      ] as const) {
        const value = record[key];
        if (value === undefined) continue;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new NativeVisualSourceError("NATIVE_SOURCE_PACKAGE_INVALID");
        }
        for (const [name, version] of Object.entries(
          value as Record<string, unknown>,
        )) {
          if (
            !ALLOWED_NATIVE_DEPENDENCIES.has(name) ||
            typeof version !== "string" ||
            /(?:file|git|github|https?|link|workspace):/iu.test(version) ||
            declaredVersions.get(name) !== version
          ) {
            throw new NativeVisualSourceError(
              "NATIVE_SOURCE_DEPENDENCY_UNSAFE",
            );
          }
        }
      }
      const packagedDependencies = new Set<string>();
      for (const key of ["dependencies", "devDependencies"] as const) {
        const value = record[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          Object.keys(value as Record<string, unknown>).forEach((name) =>
            packagedDependencies.add(name),
          );
        }
      }
      if (
        packagedDependencies.size !== declared.size ||
        [...declared].some((name) => !packagedDependencies.has(name))
      ) {
        throw new NativeVisualSourceError("NATIVE_SOURCE_PACKAGE_INVALID");
      }
    }
    for (const specifier of sourceImports(text)) {
      if (specifier.startsWith("@/")) {
        if (specifier.split("/").some((segment) => segment === "..")) {
          throw new NativeVisualSourceError("NATIVE_SOURCE_IMPORT_UNSAFE");
        }
        continue;
      }
      if (specifier.startsWith(".")) {
        if (
          specifier.includes("..") &&
          path.posix
            .normalize(
              path.posix.join(path.posix.dirname(file.path), specifier),
            )
            .startsWith("../")
        ) {
          throw new NativeVisualSourceError("NATIVE_SOURCE_IMPORT_UNSAFE");
        }
        continue;
      }
      const dependency = packageNameForImport(specifier);
      if (
        !dependency ||
        !declared.has(dependency) ||
        !ALLOWED_NATIVE_DEPENDENCIES.has(dependency)
      ) {
        throw new NativeVisualSourceError("NATIVE_SOURCE_DEPENDENCY_UNSAFE");
      }
    }
  }
}

export function nativeSourceTreeSha256(files: readonly NativeSourceFile[]) {
  return canonicalSha256(
    [...files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        path: file.path,
        bytes: file.bytes.length,
        sha256: sha256(file.bytes),
      })),
  );
}

function relativeSourceImport(
  from: string,
  target: string,
  stripCodeExtension = true,
) {
  let value = path.posix.relative(path.posix.dirname(from), target);
  if (!value.startsWith(".")) value = `./${value}`;
  return stripCodeExtension ? value.replace(/\.(?:tsx?|jsx?)$/u, "") : value;
}

function controlledSourceProject(input: {
  providerFiles: readonly NativeSourceFile[];
  demoEntrypoint: string;
  dependencies: readonly NativeSourceDependency[];
}) {
  if (
    input.providerFiles.some((file) => CONTROLLED_SOURCE_PATHS.has(file.path))
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_SHELL_COLLISION");
  }
  const cssImports = input.providerFiles
    .filter((file) => file.path.endsWith(".css"))
    .map(
      (file) =>
        `import ${JSON.stringify(
          relativeSourceImport(CONTROLLED_APP_ENTRYPOINT, file.path, false),
        )};`,
    );
  const sourceRoots = new Set<string>(["src"]);
  for (const file of input.providerFiles) {
    if (!/\.(?:[cm]?[jt]sx?|html)$/u.test(file.path)) continue;
    const firstSegment = file.path.split("/")[0]!;
    sourceRoots.add(file.path.includes("/") ? firstSegment : file.path);
  }
  const tailwindSourceLines = ["index.html", ...sourceRoots]
    .sort()
    .map((sourcePath) => `@source "../${sourcePath}";`);
  const packageDependencies = Object.fromEntries(
    input.dependencies.map((dependency) => [
      dependency.name,
      dependency.installedVersion,
    ]),
  );
  const controlledFiles: NativeSourceFile[] = [
    {
      path: CONTROLLED_PACKAGE_MANIFEST,
      bytes: Buffer.from(
        `${canonicalJson({
          name: "frontmind-twenty-first-native-source",
          private: true,
          version: "1.0.0",
          type: "module",
          dependencies: packageDependencies,
        })}\n`,
        "utf8",
      ),
    },
    {
      path: CONTROLLED_HTML_ENTRYPOINT,
      bytes: Buffer.from(
        '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FrontMind visual candidate</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
        "utf8",
      ),
    },
    {
      path: CONTROLLED_APP_ENTRYPOINT,
      bytes: Buffer.from(
        [
          'import React from "react";',
          'import { createRoot } from "react-dom/client";',
          'import "./frontmind-tailwind.css";',
          ...cssImports,
          `import NativePreview from ${JSON.stringify(
            relativeSourceImport(
              CONTROLLED_APP_ENTRYPOINT,
              input.demoEntrypoint,
            ),
          )};`,
          'createRoot(document.getElementById("root")!).render(<React.StrictMode><NativePreview /></React.StrictMode>);',
          "",
        ].join("\n"),
        "utf8",
      ),
    },
    {
      path: CONTROLLED_TAILWIND_STYLESHEET,
      bytes: Buffer.from(
        [
          '@import "tailwindcss";',
          ...tailwindSourceLines,
          "html,body,#root{min-height:100%;margin:0}",
          "",
        ].join("\n"),
        "utf8",
      ),
    },
  ];
  return [...input.providerFiles, ...controlledFiles].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

export function normalizeTwentyFirstNativeSource(input: {
  candidate: Pick<
    NormalizedTwentyFirstCandidate,
    "providerItemId" | "providerItemKey"
  >;
  payload: unknown;
}): NormalizedTwentyFirstNativeSource {
  const records = collectRecords(input.payload);
  const responseId = firstString(records, ["providerItemKey"]);
  if (responseId && responseId !== input.candidate.providerItemKey) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_PROVIDER_ID_MISMATCH");
  }
  for (const record of records) {
    for (const key of [
      "providerItemId",
      "componentId",
      "component_id",
      "itemId",
      "item_id",
      "id",
      "slug",
    ]) {
      const value = record[key];
      if (
        (typeof value === "string" || typeof value === "number") &&
        providerItemKey(value) !== input.candidate.providerItemKey
      ) {
        continue;
      }
      if (typeof value === "string" || typeof value === "number") {
        // A matching coordinate was found. Nested records may carry unrelated
        // IDs, so only an explicit top-level mismatch is rejected below.
        break;
      }
    }
  }
  const top =
    input.payload &&
    typeof input.payload === "object" &&
    !Array.isArray(input.payload)
      ? (input.payload as PayloadRecord)
      : null;
  const topId = top
    ? (top.providerItemId ??
      top.componentId ??
      top.component_id ??
      top.itemId ??
      top.item_id ??
      top.id ??
      top.slug)
    : null;
  if (
    (typeof topId === "string" || typeof topId === "number") &&
    providerItemKey(topId) !== input.candidate.providerItemKey
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_PROVIDER_ID_MISMATCH");
  }

  const files = collectProviderFiles(records);
  const component = inferCodePath({
    records,
    keys: ["componentCode", "component_code", "sourceCode", "source_code"],
    pathKeys: ["componentPath", "component_path", "entrypoint", "entryPoint"],
    fallback: "src/provider/component.tsx",
  });
  if (component && !files.has(component.path))
    files.set(component.path, component.bytes);
  const demo = inferCodePath({
    records,
    keys: ["demoCode", "demo_code", "previewCode", "preview_code"],
    pathKeys: ["demoPath", "demo_path", "demoEntrypoint", "demo_entrypoint"],
    fallback: "src/provider/demo.tsx",
  });
  if (demo && !files.has(demo.path)) files.set(demo.path, demo.bytes);
  const css = inferCodePath({
    records,
    keys: ["globalsCss", "globalCss", "global_css", "css", "styles"],
    pathKeys: ["cssPath", "stylePath", "stylesheet"],
    fallback: "src/provider/globals.css",
  });
  if (css && !files.has(css.path)) files.set(css.path, css.bytes);

  if (files.size < 1 || files.size > MAX_SOURCE_FILES) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_FILES_INCOMPLETE");
  }
  const providerFiles = [...files]
    .map(([filename, bytes]) => ({ path: filename, bytes: Buffer.from(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    new Set(
      providerFiles.map((file) =>
        file.path.normalize("NFKC").toLocaleLowerCase("en-US"),
      ),
    ).size !== providerFiles.length
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_PATH_COLLISION");
  }
  const advertisedEntrypoint = normalizedSourcePath(
    firstString(records, [
      "entrypoint",
      "entryPoint",
      "componentPath",
      "component_path",
    ]),
  );
  const advertisedDemo = normalizedSourcePath(
    firstString(records, [
      "demoEntrypoint",
      "demo_entrypoint",
      "demoPath",
      "demo_path",
    ]),
  );
  const entrypoint =
    advertisedEntrypoint ??
    component?.path ??
    providerFiles.find((file) => /\.[jt]sx$/u.test(file.path))?.path;
  const demoEntrypoint = advertisedDemo ?? demo?.path ?? entrypoint;
  if (
    !entrypoint ||
    !demoEntrypoint ||
    !files.has(entrypoint) ||
    !files.has(demoEntrypoint)
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_ENTRYPOINT_MISSING");
  }
  const dependencies = collectDependencies(records);
  const projectFiles = controlledSourceProject({
    providerFiles,
    demoEntrypoint,
    dependencies,
  });
  const totalBytes = projectFiles.reduce(
    (sum, file) => sum + file.bytes.length,
    0,
  );
  if (
    projectFiles.length > MAX_SOURCE_FILES ||
    totalBytes > MAX_SOURCE_TOTAL_BYTES ||
    projectFiles.some(
      (file) =>
        file.bytes.length < 1 || file.bytes.length > MAX_SOURCE_FILE_BYTES,
    )
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_SIZE_EXCEEDED");
  }
  assertHardSourceSafety(projectFiles, dependencies);
  return {
    providerItemKey: input.candidate.providerItemKey,
    providerVersion: cleanVersion(
      firstString(records, [
        "version",
        "componentVersion",
        "revision",
        "updatedAt",
      ]),
    ),
    entrypoint,
    demoEntrypoint,
    dependencies,
    htmlEntrypoint: CONTROLLED_HTML_ENTRYPOINT,
    appEntrypoint: CONTROLLED_APP_ENTRYPOINT,
    files: projectFiles,
    sourceTreeSha256: nativeSourceTreeSha256(projectFiles),
  };
}

function zipFileOptions() {
  return {
    date: FIXED_ZIP_DATE,
    createFolders: false,
    unixPermissions: 0o100600,
  } as const;
}

function sourceManifest(
  source: NormalizedTwentyFirstNativeSource,
): NativeSourceManifestV1 {
  return nativeSourceManifestV1Schema.parse({
    schemaVersion: 1,
    renderer: "twenty_first_native_react_v1",
    providerItemKey: source.providerItemKey,
    providerVersion: source.providerVersion,
    entrypoint: source.entrypoint,
    demoEntrypoint: source.demoEntrypoint,
    dependencies: source.dependencies,
    htmlEntrypoint: source.htmlEntrypoint,
    appEntrypoint: source.appEntrypoint,
    files: source.files.map((file) => ({
      path: file.path,
      sha256: sha256(file.bytes),
      bytes: file.bytes.length,
    })),
    sourceTreeSha256: source.sourceTreeSha256,
  });
}

export async function createNativeSourceArchive(
  source: NormalizedTwentyFirstNativeSource,
) {
  if (nativeSourceTreeSha256(source.files) !== source.sourceTreeSha256) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_TREE_HASH_MISMATCH");
  }
  const zip = new JSZip();
  zip.file(
    NATIVE_SOURCE_MANIFEST_ARCHIVE_PATH,
    canonicalJson(sourceManifest(source)),
    zipFileOptions(),
  );
  for (const file of source.files) {
    zip.file(
      `${NATIVE_SOURCE_DIRECTORY}/${file.path}`,
      file.bytes,
      zipFileOptions(),
    );
  }
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (bytes.length > NATIVE_VISUAL_SOURCE_ARCHIVE_MAX_BYTES) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_ARCHIVE_TOO_LARGE");
  }
  return bytes;
}

export async function readNativeSourceArchive(bytes: Buffer) {
  if (
    bytes.length < 1 ||
    bytes.length > NATIVE_VISUAL_SOURCE_ARCHIVE_MAX_BYTES
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_ARCHIVE_SIZE_INVALID");
  }
  const zip = await JSZip.loadAsync(bytes, {
    checkCRC32: true,
    createFolders: false,
  });
  const entries = Object.values(zip.files) as BoundedZipEntry[];
  if (
    entries.some(
      (entry) =>
        entry.dir ||
        zipEntryIsSymlink(entry) ||
        (entry.unsafeOriginalName ?? entry.name) !== entry.name,
    )
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_ARCHIVE_PATH_UNSAFE");
  }
  const manifestEntry = zip.file(NATIVE_SOURCE_MANIFEST_ARCHIVE_PATH);
  if (!manifestEntry)
    throw new NativeVisualSourceError("NATIVE_SOURCE_MANIFEST_MISSING");
  const manifestText = await manifestEntry.async("string");
  if (Buffer.byteLength(manifestText, "utf8") > 128_000) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_MANIFEST_TOO_LARGE");
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestText);
  } catch {
    throw new NativeVisualSourceError("NATIVE_SOURCE_MANIFEST_INVALID");
  }
  const manifest = nativeSourceManifestV1Schema.parse(manifestValue);
  const expectedEntryNames = new Set([
    NATIVE_SOURCE_MANIFEST_ARCHIVE_PATH,
    ...manifest.files.map((file) => `${NATIVE_SOURCE_DIRECTORY}/${file.path}`),
  ]);
  if (
    entries.length !== expectedEntryNames.size ||
    entries.some((entry) => !expectedEntryNames.has(entry.name))
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_ARCHIVE_UNEXPECTED_ENTRY");
  }
  const files: NativeSourceFile[] = [];
  for (const item of manifest.files) {
    const entry = zip.file(`${NATIVE_SOURCE_DIRECTORY}/${item.path}`);
    if (!entry) throw new NativeVisualSourceError("NATIVE_SOURCE_FILE_MISSING");
    const declared = Number(
      (entry as BoundedZipEntry)._data?.uncompressedSize ?? 0,
    );
    if (Number.isFinite(declared) && declared > item.bytes) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_FILE_SIZE_MISMATCH");
    }
    const fileBytes = await entry.async("nodebuffer");
    if (fileBytes.length !== item.bytes || sha256(fileBytes) !== item.sha256) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_FILE_HASH_MISMATCH");
    }
    files.push({ path: item.path, bytes: fileBytes });
  }
  if (nativeSourceTreeSha256(files) !== manifest.sourceTreeSha256) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_TREE_HASH_MISMATCH");
  }
  if (
    manifest.htmlEntrypoint !== CONTROLLED_HTML_ENTRYPOINT ||
    manifest.appEntrypoint !== CONTROLLED_APP_ENTRYPOINT ||
    !files.some((file) => file.path === manifest.htmlEntrypoint) ||
    !files.some((file) => file.path === manifest.appEntrypoint) ||
    !files.some((file) => file.path === CONTROLLED_TAILWIND_STYLESHEET) ||
    !files.some((file) => file.path === CONTROLLED_PACKAGE_MANIFEST)
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_SHELL_MISSING");
  }
  for (const dependency of manifest.dependencies) {
    if (
      dependency.installedVersion !==
      installedNativeSourceDependencyVersion(dependency.name)
    ) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_DEPENDENCY_DRIFT");
    }
  }
  assertHardSourceSafety(files, manifest.dependencies);
  return { manifest, files };
}

async function serveDirectory(root: string) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      if (
        decoded.includes("\\") ||
        decoded.includes("\0") ||
        decoded.split("/").some((part) => part === "..")
      ) {
        response.writeHead(400).end();
        return;
      }
      const relative = decoded.replace(/^\/+|\/+$/gu, "");
      const filename = path.join(root, relative || "index.html");
      const body = await readFile(filename).catch(() => null);
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      const extension = path.extname(filename);
      const mime =
        extension === ".html"
          ? "text/html; charset=utf-8"
          : extension === ".css"
            ? "text/css; charset=utf-8"
            : extension === ".js"
              ? "text/javascript; charset=utf-8"
              : extension === ".svg"
                ? "image/svg+xml"
                : extension === ".png"
                  ? "image/png"
                  : "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      });
      response.end(body);
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new NativeVisualSourceError("NATIVE_PREVIEW_SERVER_FAILED");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

type NativePreviewRuntimeFailureCode =
  | "NATIVE_PREVIEW_PAGE_ERROR"
  | "NATIVE_PREVIEW_CONSOLE_ERROR";

async function assertNativePreviewRendered(
  page: Page,
  runtimeFailureCodes: ReadonlySet<NativePreviewRuntimeFailureCode>,
) {
  await page.waitForTimeout(250);
  if (runtimeFailureCodes.size > 0) {
    throw new NativeVisualSourceError("NATIVE_PREVIEW_RENDER_FAILED");
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
    throw new NativeVisualSourceError("NATIVE_PREVIEW_RENDER_FAILED");
  }
}

export async function renderNativeReactSourcePreview(input: {
  sourceArchive: Buffer;
  signal: AbortSignal;
}) {
  if (input.signal.aborted) throw input.signal.reason;
  const archivedSource = await readNativeSourceArchive(input.sourceArchive);
  const archiveSha256 = sha256(input.sourceArchive);
  const validationToken = "frontmind-native-candidate-archive-validation";
  const validatedSource = await validateNativeReactSourceArchive({
    archive: input.sourceArchive,
    receipt: {
      operationToken: validationToken,
      baseSourceSha256: archiveSha256,
      archiveSha256,
      fileCount: archivedSource.files.length + 1,
    },
    expectedOperationToken: validationToken,
    expectedBaseSourceSha256: archiveSha256,
  });
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "frontmind-21st-native-")),
  );
  const outputRoot = path.join(root, "dist");
  let server: ReturnType<typeof createServer> | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    await compileValidatedNativeReactSource({
      root,
      source: validatedSource,
      timeoutMs: 60_000,
      abortSignal: input.signal,
    });
    if (input.signal.aborted) throw input.signal.reason;
    const served = await serveDirectory(outputRoot);
    server = served.server;
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: false,
      timeout: 15_000,
      args: ["--disable-background-networking", "--disable-sync"],
      env: {
        HOME: root,
        LANG: "C.UTF-8",
        TZ: "UTC",
        PATH: path.dirname(process.execPath),
      },
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "no-preference",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const runtimeFailureCodes = new Set<NativePreviewRuntimeFailureCode>();
    let networkViolationDetected = false;
    page.on("pageerror", () => {
      runtimeFailureCodes.add("NATIVE_PREVIEW_PAGE_ERROR");
    });
    await page.exposeBinding("__frontmindNativeConsoleError", () => {
      runtimeFailureCodes.add("NATIVE_PREVIEW_CONSOLE_ERROR");
    });
    await page.exposeBinding("__frontmindNativePolicyViolation", () => {
      networkViolationDetected = true;
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
      const url = new URL(route.request().url());
      if (url.origin === served.origin) await route.continue();
      else {
        networkViolationDetected = true;
        await route.abort("blockedbyclient");
      }
    });
    const response = await page.goto(served.origin, {
      waitUntil: "networkidle",
      timeout: 15_000,
    });
    if (!response?.ok())
      throw new NativeVisualSourceError("NATIVE_PREVIEW_ROUTE_FAILED");
    if (networkViolationDetected) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_EXECUTION_UNSAFE");
    }
    await assertNativePreviewRendered(page, runtimeFailureCodes);
    if (networkViolationDetected) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_EXECUTION_UNSAFE");
    }
    const screenshot = await page.screenshot({
      type: "png",
      fullPage: false,
      animations: "allow",
      timeout: 10_000,
    });
    await context.close();
    return Buffer.from(screenshot);
  } catch (error) {
    if (error instanceof NativeVisualSourceError) throw error;
    throw new NativeVisualSourceError("NATIVE_SOURCE_COMPILE_FAILED", error);
  } finally {
    await browser?.close().catch(() => undefined);
    if (server?.listening)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

export async function prepareNativeVisualCandidate(input: {
  candidate: NormalizedTwentyFirstCandidate;
  payload: unknown;
  signal: AbortSignal;
}): Promise<PreparedNativeVisualCandidate> {
  const source = normalizeTwentyFirstNativeSource({
    candidate: input.candidate,
    payload: input.payload,
  });
  const sourceArchive = await createNativeSourceArchive(source);
  const preview = await renderNativeReactSourcePreview({
    sourceArchive,
    signal: input.signal,
  });
  return {
    ...source,
    sourceArchive,
    sourceArchiveSha256: sha256(sourceArchive),
    preview,
    previewSha256: sha256(preview),
  };
}

export async function createVisualSelectionBundleV5Artifact(input: {
  bundle: VisualSelectionBundleV5;
  sourceArchives: ReadonlyMap<string, Buffer>;
}) {
  const bundle = visualSelectionBundleV5Schema.parse(input.bundle);
  const zip = new JSZip();
  zip.file(V5_SELECTION_MANIFEST_PATH, canonicalJson(bundle), zipFileOptions());
  for (const candidate of bundle.candidates) {
    const archive = input.sourceArchives.get(candidate.id);
    if (!archive || sha256(archive) !== candidate.sourceArchiveSha256) {
      throw new NativeVisualSourceError("V5_SOURCE_ARCHIVE_HASH_MISMATCH");
    }
    const inspected = await readNativeSourceArchive(archive);
    if (
      inspected.manifest.sourceTreeSha256 !== candidate.sourceTreeSha256 ||
      inspected.manifest.entrypoint !== candidate.entrypoint ||
      inspected.manifest.demoEntrypoint !== candidate.demoEntrypoint ||
      inspected.manifest.providerItemKey !== candidate.providerItemKey
    ) {
      throw new NativeVisualSourceError("V5_SOURCE_COORDINATE_MISMATCH");
    }
    zip.file(candidate.sourceArchivePath, archive, {
      ...zipFileOptions(),
      compression: "STORE",
    });
  }
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (bytes.length > VISUAL_SELECTION_BUNDLE_V5_MAX_BYTES) {
    throw new NativeVisualSourceError("V5_SELECTION_BUNDLE_TOO_LARGE");
  }
  return bytes;
}

export async function readVisualSelectionBundleArtifact(bytes: Buffer) {
  if (bytes.length < 1 || bytes.length > VISUAL_SELECTION_BUNDLE_V5_MAX_BYTES) {
    throw new NativeVisualSourceError("V5_SELECTION_BUNDLE_SIZE_INVALID");
  }
  const zip = await JSZip.loadAsync(bytes, {
    checkCRC32: true,
    createFolders: false,
  });
  const entries = Object.values(zip.files) as BoundedZipEntry[];
  if (
    entries.some(
      (entry) =>
        entry.dir ||
        zipEntryIsSymlink(entry) ||
        (entry.unsafeOriginalName ?? entry.name) !== entry.name,
    )
  ) {
    throw new NativeVisualSourceError("V5_SELECTION_BUNDLE_PATH_UNSAFE");
  }
  const manifestEntry = zip.file(V5_SELECTION_MANIFEST_PATH);
  if (!manifestEntry)
    throw new NativeVisualSourceError("V5_SELECTION_MANIFEST_MISSING");
  const manifestText = await manifestEntry.async("string");
  if (Buffer.byteLength(manifestText, "utf8") > 512_000) {
    throw new NativeVisualSourceError("V5_SELECTION_MANIFEST_TOO_LARGE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new NativeVisualSourceError("V5_SELECTION_MANIFEST_INVALID");
  }
  const bundle = visualSelectionBundleV5Schema.parse(parsed);
  const expected = new Set([
    V5_SELECTION_MANIFEST_PATH,
    ...bundle.candidates.map((candidate) => candidate.sourceArchivePath),
  ]);
  if (
    entries.length !== expected.size ||
    entries.some((entry) => !expected.has(entry.name))
  ) {
    throw new NativeVisualSourceError("V5_SELECTION_BUNDLE_UNEXPECTED_ENTRY");
  }
  const archives = new Map<string, Buffer>();
  for (const candidate of bundle.candidates) {
    const entry = zip.file(candidate.sourceArchivePath);
    if (!entry) throw new NativeVisualSourceError("V5_SOURCE_ARCHIVE_MISSING");
    const declared = Number(
      (entry as BoundedZipEntry)._data?.uncompressedSize ?? 0,
    );
    if (
      Number.isFinite(declared) &&
      declared > NATIVE_VISUAL_SOURCE_ARCHIVE_MAX_BYTES
    ) {
      throw new NativeVisualSourceError("V5_SOURCE_ARCHIVE_TOO_LARGE");
    }
    const archive = await entry.async("nodebuffer");
    if (sha256(archive) !== candidate.sourceArchiveSha256) {
      throw new NativeVisualSourceError("V5_SOURCE_ARCHIVE_HASH_MISMATCH");
    }
    const source = await readNativeSourceArchive(archive);
    if (
      source.manifest.sourceTreeSha256 !== candidate.sourceTreeSha256 ||
      source.manifest.entrypoint !== candidate.entrypoint ||
      source.manifest.demoEntrypoint !== candidate.demoEntrypoint ||
      source.manifest.providerItemKey !== candidate.providerItemKey
    ) {
      throw new NativeVisualSourceError("V5_SOURCE_COORDINATE_MISMATCH");
    }
    archives.set(candidate.id, archive);
  }
  return { bundle, archives };
}

export async function selectedNativeSourceArchive(input: {
  artifactBytes: Buffer;
  selectedCandidateId: string;
}) {
  const artifact = await readVisualSelectionBundleArtifact(input.artifactBytes);
  const candidate = artifact.bundle.candidates.find(
    (item) => item.id === input.selectedCandidateId,
  );
  if (!candidate)
    throw new NativeVisualSourceError("V5_SELECTED_CANDIDATE_MISSING");
  const archiveBytes = artifact.archives.get(candidate.id)!;
  const source = await readNativeSourceArchive(archiveBytes);
  return {
    bundle: artifact.bundle,
    candidate,
    archiveBytes,
    archiveSha256: candidate.sourceArchiveSha256,
    manifest: source.manifest,
    files: source.files,
  };
}
