import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot = path.join(
  projectRoot,
  "private-workflows",
  "socratic-kb-builder",
);
const outputPath = path.join(
  projectRoot,
  "private-workflows",
  "socratic-kb-builder-v3.skill",
);
const fixedDate = new Date("2000-01-01T00:00:00.000Z");

export const socraticKnowledgeBaseSkillEntries = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/knowledge-tree.md",
  "references/output-format.md",
  "references/questioning-strategy.md",
  "scripts/validate_archive.py",
];

async function readRequiredSource(relativePath) {
  const content = await fs.readFile(path.join(sourceRoot, relativePath));
  if (content.length === 0) {
    throw new Error(`Skill source is empty: ${relativePath}`);
  }
  return content;
}

async function skillInstructionHash(archive) {
  const zip = await JSZip.loadAsync(archive);
  const skill = await zip.file("SKILL.md")?.async("string");
  if (!skill) {
    throw new Error("Existing v3 Skill archive is missing SKILL.md");
  }
  return createHash("sha256")
    .update(`# Skill\n\n${skill.trim()}`)
    .digest("hex");
}

export async function packageSocraticKnowledgeBaseSkill() {
  const zip = new JSZip();
  for (const relativePath of [...socraticKnowledgeBaseSkillEntries].sort()) {
    zip.file(relativePath, await readRequiredSource(relativePath), {
      binary: true,
      createFolders: false,
      date: fixedDate,
      unixPermissions: relativePath.endsWith(".py") ? 0o100755 : 0o100644,
    });
  }
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
  });
  let existing = null;
  try {
    existing = await fs.readFile(outputPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!existing?.equals(archive)) {
    if (existing) {
      const previousHash = await skillInstructionHash(existing);
      await fs.writeFile(
        path.join(
          path.dirname(outputPath),
          `socratic-kb-builder-v3-${previousHash}.skill`,
        ),
        existing,
      );
    }
    await fs.writeFile(outputPath, archive);
  }
  return {
    outputPath,
    bytes: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await packageSocraticKnowledgeBaseSkill();
  console.log(
    `Packaged deterministic Skill: ${path.relative(projectRoot, result.outputPath)} ` +
      `(${result.bytes} bytes, sha256=${result.sha256})`,
  );
}
