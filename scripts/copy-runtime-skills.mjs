import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot = path.join(projectRoot, "private-workflows");
const outputRoot = path.join(projectRoot, "dist", "private-workflows");
const skillArtifacts = [
  "socratic-kb-builder.skill",
  "brand-question-portfolio.skill",
  "response-logic-builder.skill",
];
const requiredFiles = [
  "socratic-kb-builder.skill",
  "brand-question-portfolio.skill/SKILL.md",
  "brand-question-portfolio.skill/references/output-contract.md",
  "response-logic-builder.skill/SKILL.md",
  "response-logic-builder.skill/references/output-contract.md",
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
