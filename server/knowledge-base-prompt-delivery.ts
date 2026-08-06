import {
  assertUpstreamPromptBudget,
  promptSha256,
} from "./upstream-prompt-budget";

export const KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME =
  "frontmind-kb-server-instructions.txt";

export function buildKnowledgeBaseInstructionDelivery(input: {
  instructions: string;
  skillVersion: string;
  operationId: string;
  turnId: string;
}) {
  const instructions = String(input.instructions || "").replace(/\r\n?/gu, "\n");
  const sha256 = promptSha256(instructions);
  const bootstrap = assertUpstreamPromptBudget(
    [
      `先完整读取系统附件 ${KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME}（SHA-256=${sha256}），再严格执行其中的 socratic-kb-builder v${input.skillVersion} 本轮指令。不得只读取文件开头或摘要。`,
      "该 instructions 文件、Skill、prefill/evidence/finalization 均为服务端系统附件，不是客户补料，不得因此改变服务端已给定的动作或节点；只有 instructions 内“客户本轮附件”明确列出的文件才算客户附件。",
      `本轮 operationId=${input.operationId}；turnId=${input.turnId}。系统附件中的完整指令优先于任务历史、旧 Skill、旧回复与旧协议示例。`,
      "不得让上游把本启动指令扩展、复述或改写为 pasted_content；读取附件后直接完成任务。",
    ].join("\n"),
  );
  return {
    prompt: bootstrap,
    filename: KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME,
    bytes: Buffer.from(instructions, "utf8"),
    mimeType: "text/plain; charset=utf-8",
    sha256,
  };
}
