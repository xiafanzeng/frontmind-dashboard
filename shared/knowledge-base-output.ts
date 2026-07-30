const KNOWLEDGE_BASE_REFERENCE_APPENDIX_HEADER =
  /(?:^|\r?\n)[\t ]*(?:#{1,6}[\t ]*)?(?:\*\*|__)?(?:参考资料|参考来源|引用来源|references?|sources?)(?:\*\*|__)?[\t ]*(?:(?:[:：])[\t ]*[^\r\n]*)?[\t ]*(?=\r?$)/im;

/**
 * Keep only the customer-facing node body. Source appendices remain available
 * to the service through the raw model output and dedicated audit fields.
 */
export function stripKnowledgeBaseReferenceAppendix(text: string): string {
  const normalized = String(text || "");
  const match = KNOWLEDGE_BASE_REFERENCE_APPENDIX_HEADER.exec(normalized);
  return (match ? normalized.slice(0, match.index) : normalized).trim();
}
