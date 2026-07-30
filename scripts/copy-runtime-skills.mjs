import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageSocraticKnowledgeBaseSkill } from "./package-socratic-kb-skill.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot = path.join(projectRoot, "private-workflows");
const outputRoot = path.join(projectRoot, "dist", "private-workflows");
const skillArtifacts = [
  "socratic-kb-builder.skill",
  "socratic-kb-builder-v1.skill",
  "socratic-kb-builder-v3.skill",
  "brand-question-portfolio.skill",
  "response-logic-builder.skill",
];
const requiredFiles = [
  "socratic-kb-builder.skill",
  "socratic-kb-builder-v1.skill",
  "socratic-kb-builder-v3.skill",
  "brand-question-portfolio.skill/SKILL.md",
  "brand-question-portfolio.skill/references/output-contract.md",
  "response-logic-builder.skill/SKILL.md",
  "response-logic-builder.skill/references/output-contract.md",
];

await packageSocraticKnowledgeBaseSkill();
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
