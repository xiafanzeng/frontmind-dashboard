import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

export const SITEOPS_UPSTREAM_SHA256 =
  "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a";
export const SITEOPS_RUNTIME_VERSION = "1.4.0";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot = path.join(projectRoot, "private-workflows");
const upstreamPath = path.join(
  sourceRoot,
  "astro-company-site-workflow-v1.0.0.zip",
);
const runtimeRoot = path.join(
  sourceRoot,
  `astro-company-site-workflow-v${SITEOPS_RUNTIME_VERSION}`,
);
const manifestPath = path.join(runtimeRoot, "MANIFEST.json");
const materializerPath = path.join(
  projectRoot,
  "server/siteops/build-runtime.ts",
);
const starterContractPath = path.join(
  runtimeRoot,
  "assets/host-starter-contract.json",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function listRegularFiles(root, prefix = "") {
  const names = await fs.readdir(path.join(root, prefix), {
    withFileTypes: true,
  });
  const files = [];
  for (const name of names.sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  )) {
    const relativePath = path.posix.join(prefix, name.name);
    if (name.isDirectory()) {
      files.push(...(await listRegularFiles(root, relativePath)));
      continue;
    }
    if (!name.isFile()) {
      throw new Error(`Workflow contains a non-regular entry: ${relativePath}`);
    }
    if (relativePath !== "MANIFEST.json") files.push(relativePath);
  }
  return files;
}

export async function verifyUpstreamSiteOpsWorkflow() {
  const archive = await fs.readFile(upstreamPath);
  const archiveHash = sha256(archive);
  if (archiveHash !== SITEOPS_UPSTREAM_SHA256) {
    throw new Error(
      `SiteOps upstream archive hash mismatch: expected ${SITEOPS_UPSTREAM_SHA256}, got ${archiveHash}`,
    );
  }
  const zip = await JSZip.loadAsync(archive, {
    checkCRC32: true,
    createFolders: false,
  });
  const manifestEntry = zip.file("astro-company-site-workflow/MANIFEST.json");
  if (!manifestEntry) throw new Error("SiteOps upstream manifest is missing");
  const manifest = JSON.parse(await manifestEntry.async("string"));
  if (manifest.version !== "1.0.0" || !Array.isArray(manifest.files)) {
    throw new Error("SiteOps upstream manifest contract is invalid");
  }
  for (const expected of manifest.files) {
    const entry = zip.file(`astro-company-site-workflow/${expected.path}`);
    if (!entry || entry.dir) {
      throw new Error(`SiteOps upstream file is missing: ${expected.path}`);
    }
    const bytes = await entry.async("nodebuffer");
    if (
      bytes.byteLength !== expected.bytes ||
      sha256(bytes) !== expected.sha256
    ) {
      throw new Error(`SiteOps upstream file hash mismatch: ${expected.path}`);
    }
  }
  return { archiveHash, files: manifest.files.length };
}

export async function createSiteOpsRuntimeManifest() {
  const files = await listRegularFiles(runtimeRoot);
  const entries = [];
  for (const relativePath of files) {
    const bytes = await fs.readFile(path.join(runtimeRoot, relativePath));
    entries.push({
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  const [starterContract, materializer] = await Promise.all([
    fs.readFile(starterContractPath),
    fs.readFile(materializerPath),
  ]);
  return {
    schema: "frontmind-runtime-workflow-manifest/v1",
    name: "frontmind-astro-company-site-workflow",
    version: SITEOPS_RUNTIME_VERSION,
    entrypoint: "SKILL.md",
    upstream: {
      version: "1.0.0",
      archiveSha256: SITEOPS_UPSTREAM_SHA256,
    },
    hashScope: "all regular files except MANIFEST.json",
    host: {
      starterSha256: sha256(starterContract),
      componentLibraryVersion: "1.0.0",
      materializerVersion: "1.0.0",
      materializerSha256: sha256(materializer),
    },
    files: entries,
  };
}

export async function verifySiteOpsRuntimeWorkflow() {
  const expected = await createSiteOpsRuntimeManifest();
  const actual = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "SiteOps runtime manifest is stale; run node scripts/package-siteops-workflow.mjs --write",
    );
  }
  const forbidden = /Northstar|example\.invalid|21st_sk_[A-Za-z0-9_-]{12,}/u;
  for (const entry of expected.files) {
    const text = await fs.readFile(path.join(runtimeRoot, entry.path), "utf8");
    if (forbidden.test(text)) {
      throw new Error(
        `SiteOps runtime contains forbidden demo/secret text: ${entry.path}`,
      );
    }
  }
  return expected;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const upstream = await verifyUpstreamSiteOpsWorkflow();
  if (process.argv.includes("--write")) {
    const manifest = await createSiteOpsRuntimeManifest();
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const runtime = await verifySiteOpsRuntimeWorkflow();
  console.log(
    `Verified SiteOps workflow ${runtime.version}: ${runtime.files.length} runtime files; ${upstream.files} upstream files.`,
  );
}
