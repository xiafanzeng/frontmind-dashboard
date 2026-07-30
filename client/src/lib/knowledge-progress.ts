import type {
  KnowledgeBaseInteractionDto,
  KnowledgeBaseProgressDto,
} from "@shared/knowledge-base-progress";

async function readErrorMessage(response: Response) {
  try {
    const payload = await response.json();
    return (
      payload?.error?.message ||
      payload?.error ||
      payload?.message ||
      `请求失败 (${response.status})`
    );
  } catch {
    return `请求失败 (${response.status})`;
  }
}

export async function fetchKnowledgeBaseProgress(
  conversationId: string,
): Promise<KnowledgeBaseProgressDto | null> {
  if (!conversationId) return null;
  const response = await fetch(
    `/api/knowledge-base/progress/${encodeURIComponent(conversationId)}`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload = await response.json();
  return (payload?.progress as KnowledgeBaseProgressDto | null) ?? null;
}

export async function fetchKnowledgeBaseInteraction(
  conversationId: string,
): Promise<KnowledgeBaseInteractionDto | null> {
  if (!conversationId) return null;
  const response = await fetch(
    `/api/knowledge-base/progress/${encodeURIComponent(conversationId)}`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload = await response.json();
  return (payload?.interaction as KnowledgeBaseInteractionDto | null) ?? null;
}

export async function reconcileKnowledgeBaseProgress(input: {
  conversationId: string;
  taskId?: string;
}): Promise<KnowledgeBaseInteractionDto> {
  const response = await fetch("/api/knowledge-base/progress/reconcile", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload = await response.json();
  window.dispatchEvent(
    new CustomEvent("frontmind:knowledge-progress-updated", {
      detail: payload.progress,
    }),
  );
  return payload.interaction as KnowledgeBaseInteractionDto;
}

/**
 * The user-facing message remains untouched. This reminder is appended only to
 * the upstream task prompt so the model receives the authoritative revision
 * and current leaf on every turn.
 */
export async function getKnowledgeBaseTurnProtocolReminder(
  conversationId: string,
) {
  try {
    const progress = await fetchKnowledgeBaseProgress(conversationId);
    if (!progress || progress.summary.total === 0) {
      return [
        "[知识库状态协议]",
        "知识树尚未通过服务端校验。不得假设进度或提前生成 ZIP；请重新输出完整 FRONTMIND_KB_MANIFEST 信封。",
      ].join("\n");
    }
    const current = progress.branches
      .flatMap((branch) => branch.leaves)
      .find((leaf) => leaf.id === progress.build.currentLeafId);
    if (!current) {
      const leafInventory = progress.branches
        .flatMap((branch) => branch.leaves)
        .map((leaf) => `${leaf.id}:${leaf.title}`)
        .join("；");
      return [
        "[知识库状态协议]",
        `当前知识库已完成，服务端 revision=${progress.build.revision}。本轮用户正在提出发布后的补充或修订，不得直接复用旧 ZIP，也不得创建新知识树。`,
        `请从现有叶子中选择且只选择一个最相关节点，更新该节点草稿并在回复末尾附一个 FRONTMIND_KB_REOPEN 信封：{"kind":"frontmind.knowledge-base.reopen","schemaVersion":1,"revision":${progress.build.revision},"leafId":"所选节点ID","reason":"本轮修订原因"}。`,
        "选中的节点会重新进入待核验；用户明确确认后才能再次生成新版 ZIP。",
        `现有叶子：${leafInventory}`,
      ].join("\n");
    }
    return [
      "[知识库状态协议]",
      `服务端权威状态：revision=${progress.build.revision}；currentLeafId=${current.id}；from=${current.status}。`,
      "本轮只能处理这个叶子。只有用户明确确认才输出 to=confirmed；明确跳过/直接预填才输出 to=direct_prefilled；任何补充、修订、提问或上传都必须输出 to=needs_verification 并停留在当前叶子。",
      "回复末尾只能附一个 FRONTMIND_KB_PROGRESS 信封；不得批量推进或提前生成 ZIP。",
    ].join("\n");
  } catch {
    return [
      "[知识库状态协议]",
      "无法读取服务端权威 revision。本轮不得推进节点或生成 ZIP；请继续呈现当前节点，并说明等待状态同步。",
    ].join("\n");
  }
}
