import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageSocraticKnowledgeBaseSkill } from "./package-socratic-kb-skill.mjs";
import {
  verifySiteOpsRuntimeWorkflow,
  verifyUpstreamSiteOpsWorkflow,
} from "./package-siteops-workflow.mjs";
import { verifyAllSiteOpsSocialWorkflows } from "./package-siteops-social-workflows.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot = path.join(projectRoot, "private-workflows");
const outputRoot = path.join(projectRoot, "dist", "private-workflows");
const materializedSkill = await packageSocraticKnowledgeBaseSkill();
await verifyUpstreamSiteOpsWorkflow();
await verifySiteOpsRuntimeWorkflow();
await verifyAllSiteOpsSocialWorkflows();
const exactMaterializedSkill = `socratic-kb-builder-v5-${materializedSkill.contentHash}.skill`;
const skillArtifacts = [
  "socratic-kb-builder-v5.skill",
  exactMaterializedSkill,
  "brand-question-portfolio.skill",
  "response-logic-builder.skill",
  "astro-company-site-workflow-v1.0.0.zip",
  "astro-company-site-workflow-v1.0.0.sha256",
  "astro-company-site-workflow-v1.1.0",
  "siteops-wechat-package-v1.0.0",
  "siteops-xiaohongshu-package-v1.0.0",
];
const requiredFiles = [
  "socratic-kb-builder-v5.skill",
  exactMaterializedSkill,
  "brand-question-portfolio.skill/SKILL.md",
  "brand-question-portfolio.skill/references/output-contract.md",
  "response-logic-builder.skill/SKILL.md",
  "response-logic-builder.skill/references/output-contract.md",
  "astro-company-site-workflow-v1.0.0.zip",
  "astro-company-site-workflow-v1.0.0.sha256",
  "astro-company-site-workflow-v1.1.0/MANIFEST.json",
  "astro-company-site-workflow-v1.1.0/SKILL.md",
  "astro-company-site-workflow-v1.1.0/runtime-contract.json",
  "astro-company-site-workflow-v1.1.0/adapters/frontmind-dashboard.md",
  "astro-company-site-workflow-v1.1.0/schemas/frontmind-run-envelope.schema.json",
  "astro-company-site-workflow-v1.1.0/assets/astro-static-starter/package.json",
  "siteops-wechat-package-v1.0.0/MANIFEST.json",
  "siteops-wechat-package-v1.0.0/SKILL.md",
  "siteops-wechat-package-v1.0.0/runtime-contract.json",
  "siteops-xiaohongshu-package-v1.0.0/MANIFEST.json",
  "siteops-xiaohongshu-package-v1.0.0/SKILL.md",
  "siteops-xiaohongshu-package-v1.0.0/runtime-contract.json",
];

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(outputRoot, { recursive: true });

for (const artifact of skillArtifacts) {
  await fs.cp(
    path.join(sourceRoot, artifact),
    path.join(outputRoot, artifact),
    {
      recursive: true,
      force: true,
    },
  );
}

for (const relativePath of requiredFiles) {
  const artifact = await fs.stat(path.join(outputRoot, relativePath));
  if (!artifact.isFile() || artifact.size === 0) {
    throw new Error(
      `Runtime Skill artifact is missing or empty: ${relativePath}`,
    );
  }
}

console.log(
  `Copied ${skillArtifacts.length} runtime Skill artifacts into dist/private-workflows.`,
);
