import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import JSZip from "jszip";

const projectRoot = resolve(import.meta.dirname, "..");
const buildRoot = resolve(projectRoot, process.argv[2] || "dist");
const textExtensions = new Set([
  ".csv",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const forbiddenFileNames = new Set([
  "citation-distribution-20260723-171030.b64",
  "citation-distribution-20260727-101630.b64",
]);
const approvedBrandAssetNames = new Set(["cuhksz-emblem.png"]);
const approvedBrandText = [
  "/assets/cuhksz-emblem.png",
  "cuhksz-emblem.png",
  "香港中文大学（深圳）校徽",
  "香港中文大学（深圳）AI智能决策实验室",
];
const forbiddenFileNamePatterns = [
  {
    label: "encoded customer monitoring fixture",
    pattern: /\.b64$/i,
  },
  {
    label: "customer or acceptance fixture asset",
    pattern:
      /citation-distribution|cuhksz-emblem|hongxu-monitoring-fixture|acceptance-monitoring-fixture/i,
  },
  {
    label: "development-only response logic preview chunk",
    pattern: /ResponseLogicPreview/i,
  },
];

const legacyCustomerFixturePattern =
  /海天精工|taixinyimei|港中深|香港中文大学(?:（深圳）|\(深圳\))|CUHK(?:-Shenzhen)?|cuhksz|广东省录取分数线排名|北京市录取分数线及位次|宏旭|hongxu\.demo|摩托车骑行装备品牌推荐/i;
const retiredDashboardPortPattern = new RegExp(["30", "04"].join(""));
const forbiddenPatterns = [
  {
    label: "retired Dashboard port",
    pattern: retiredDashboardPortPattern,
  },
  {
    label: "preview route",
    pattern: /\/preview\/(?:admin|user)(?:\/|["'`])/,
  },
  {
    label: "preview component",
    pattern: /\bPreviewPages\b|\bPreviewAdmin(?:Users|Accounts|Presales)\b/,
  },
  {
    label: "fixed advanced/luxury price",
    pattern:
      /(?:¥|￥)?\s*(?:29,?800|89,?400)\s*(?:元)?\s*(?:\/|每)?\s*(?:季度|季)|\b(?:29800|89400|2_?980_?000|8_?940_?000)\b/,
  },
  {
    label: "fixed service price map",
    pattern: /\bWEBSITE_SERVICE_PRICE_FEN\b/,
  },
  {
    label: "example contract/order",
    pattern: /preview-luxury-(?:order|contract)/,
  },
  {
    label: "legacy tenant demo data",
    pattern: legacyCustomerFixturePattern,
  },
  {
    label: "legacy GEO demo bundle",
    pattern:
      /\bgeoAnswerBooks\b|\bglobalKeywordBank\b|\bhongxuGeoAnswerBooks\b|\bhongxuMonitoringFixtureCounts\b/,
  },
  {
    label: "development response-logic adapter",
    pattern: /\bresponseLogicPreviewAdapter\b/,
  },
  {
    label: "hardcoded response-logic preview answer",
    pattern:
      /我已载入当前问题的知识库预填内容|先给出可核验的判断，再解释判断依据与适配条件|企业知识库中已确认的品牌事实与方法依据|确认本轮补充信息的公开范围与对应权威来源/,
  },
  {
    label: "fixed response-logic preview timestamp",
    pattern: /2026-07-24T08:00:00\.000Z/,
  },
  {
    label: "hardcoded monitoring fixture URL",
    pattern: /citation-distribution-\d{8}-\d{6}\.b64/i,
  },
  {
    label: "example administrator/customer",
    pattern:
      /FrontMind 示例管理员|示例企业(?:\s*C)?|汉腾激光|preview-(?:ticket|admin|customer)/,
  },
  {
    label: "API key",
    pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/,
  },
  {
    label: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
];

function withoutApprovedBranding(content) {
  return approvedBrandText.reduce(
    (result, allowedText) => result.replaceAll(allowedText, ""),
    content,
  );
}

const requiredSkillFiles = [
  "private-workflows/socratic-kb-builder.skill",
  "private-workflows/brand-question-portfolio.skill/SKILL.md",
  "private-workflows/brand-question-portfolio.skill/references/output-contract.md",
  "private-workflows/response-logic-builder.skill/SKILL.md",
  "private-workflows/response-logic-builder.skill/references/output-contract.md",
];
const runtimeSkillRoots = [
  "private-workflows/socratic-kb-builder.skill",
  "private-workflows/brand-question-portfolio.skill",
  "private-workflows/response-logic-builder.skill",
];
const requiredKnowledgeBaseEntries = [
  "SKILL.md",
  "references/knowledge-tree.md",
  "references/questioning-strategy.md",
  "references/output-format.md",
];
const allowedKnowledgeBaseArchiveEntries = new Set([
  ...requiredKnowledgeBaseEntries,
  "references/",
]);

async function collectTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTextFiles(path)));
    } else if (entry.isFile() && textExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

async function collectFiles(path) {
  const pathStat = await stat(path);
  if (pathStat.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function collectTestSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTestSourceFiles(path)));
    } else if (
      entry.isFile() &&
      /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

try {
  const buildStat = await stat(buildRoot);
  if (!buildStat.isDirectory()) {
    throw new Error("dist is not a directory");
  }
} catch {
  console.error("Production bundle is missing. Run `pnpm build` first.");
  process.exit(1);
}

const violations = [];
for (const sourceRoot of ["client", "server"]) {
  for (const file of await collectTestSourceFiles(
    join(projectRoot, sourceRoot),
  )) {
    const content = withoutApprovedBranding(await readFile(file, "utf8"));
    if (legacyCustomerFixturePattern.test(content)) {
      violations.push({
        file: relative(projectRoot, file),
        label: "legacy customer data in test source",
      });
    }
  }
}

for (const relativePath of requiredSkillFiles) {
  try {
    const artifact = await stat(join(buildRoot, relativePath));
    if (!artifact.isFile() || artifact.size === 0) {
      throw new Error("not a non-empty file");
    }
  } catch {
    violations.push({
      file: relativePath,
      label: "missing runtime Skill artifact",
    });
  }
}

for (const relativeRoot of runtimeSkillRoots) {
  const sourceRoot = join(projectRoot, relativeRoot);
  const builtRoot = join(buildRoot, relativeRoot);
  try {
    const [sourceStat, builtStat] = await Promise.all([
      stat(sourceRoot),
      stat(builtRoot),
    ]);
    if (sourceStat.isFile() !== builtStat.isFile()) {
      throw new Error("runtime Skill artifact type differs from source");
    }
    const [sourceFiles, builtFiles] = await Promise.all([
      collectFiles(sourceRoot),
      collectFiles(builtRoot),
    ]);
    const relativeFilePath = (root, file) =>
      stat(root).then((rootStat) =>
        rootStat.isFile() ? "." : relative(root, file),
      );
    const [sourceRelativeFiles, builtRelativeFiles] = await Promise.all([
      Promise.all(
        sourceFiles.map((file) => relativeFilePath(sourceRoot, file)),
      ),
      Promise.all(builtFiles.map((file) => relativeFilePath(builtRoot, file))),
    ]);
    sourceRelativeFiles.sort();
    builtRelativeFiles.sort();
    if (
      JSON.stringify(sourceRelativeFiles) !== JSON.stringify(builtRelativeFiles)
    ) {
      violations.push({
        file: relativeRoot,
        label: "runtime Skill file list differs from source",
      });
      continue;
    }
    for (const relativeFile of sourceRelativeFiles) {
      const sourceFile =
        relativeFile === "." ? sourceRoot : join(sourceRoot, relativeFile);
      const builtFile =
        relativeFile === "." ? builtRoot : join(builtRoot, relativeFile);
      const [sourceContent, builtContent] = await Promise.all([
        readFile(sourceFile),
        readFile(builtFile),
      ]);
      if (!sourceContent.equals(builtContent)) {
        violations.push({
          file:
            relativeFile === "."
              ? relativeRoot
              : `${relativeRoot}/${relativeFile}`,
          label: "runtime Skill content differs from source",
        });
      }
    }
  } catch {
    violations.push({
      file: relativeRoot,
      label: "runtime Skill artifact cannot be compared with source",
    });
  }
}

try {
  const archivePath = join(
    buildRoot,
    "private-workflows",
    "socratic-kb-builder.skill",
  );
  const archive = await JSZip.loadAsync(await readFile(archivePath));
  for (const [entryName, entry] of Object.entries(archive.files)) {
    const originalName = entry.unsafeOriginalName || entryName;
    const unsafePath =
      originalName.startsWith("/") ||
      /^[A-Za-z]:/.test(originalName) ||
      originalName.includes("\\") ||
      originalName.split("/").includes("..");
    if (unsafePath) {
      violations.push({
        file: `${relative(projectRoot, archivePath)}:${entryName}`,
        label: "unsafe Skill archive entry path",
      });
      continue;
    }
    if (!allowedKnowledgeBaseArchiveEntries.has(entryName)) {
      violations.push({
        file: `${relative(projectRoot, archivePath)}:${entryName}`,
        label: "unexpected Skill archive entry",
      });
      continue;
    }
    if (entry.dir) continue;
    const content = await entry.async("string");
    for (const rule of forbiddenPatterns) {
      if (rule.pattern.test(content)) {
        violations.push({
          file: `${relative(projectRoot, archivePath)}:${entryName}`,
          label: rule.label,
        });
      }
    }
  }
  for (const entryName of requiredKnowledgeBaseEntries) {
    const entry = archive.file(entryName);
    if (!entry) {
      violations.push({
        file: relative(projectRoot, archivePath),
        label: `missing Skill entry ${entryName}`,
      });
      continue;
    }
  }
} catch {
  violations.push({
    file: "private-workflows/socratic-kb-builder.skill",
    label: "invalid runtime Skill archive",
  });
}

const allEntries = await readdir(buildRoot, {
  recursive: true,
  withFileTypes: true,
});
for (const entry of allEntries) {
  if (entry.isFile() && forbiddenFileNames.has(entry.name)) {
    violations.push({
      file: entry.name,
      label: "development-only monitoring data",
    });
  }
  if (entry.isFile()) {
    if (approvedBrandAssetNames.has(entry.name)) continue;
    for (const rule of forbiddenFileNamePatterns) {
      if (rule.pattern.test(entry.name)) {
        violations.push({
          file: entry.name,
          label: rule.label,
        });
      }
    }
  }
}
for (const file of await collectTextFiles(buildRoot)) {
  const content = withoutApprovedBranding(await readFile(file, "utf8"));
  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(content)) {
      violations.push({
        file: relative(projectRoot, file),
        label: rule.label,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("Production bundle audit failed:");
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.label}`);
  }
  process.exit(1);
}

console.log("Production bundle audit passed.");
