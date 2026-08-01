/**
 * ChatInput Component - Message input with file upload and model selector
 * Design: Floating glass card input area with drag-and-drop support.
 * Features: Text input, file picker, drag & drop, upload progress,
 *           per-message model selection (FrontMind-Lite/Base/Pro).
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSendMessage } from "@/hooks/useSendMessage";
import {
  currentKnowledgeBasePresentationReady,
  useConversation,
} from "@/contexts/ConversationContext";
import {
  MODEL_OPTIONS,
  getConfig,
  saveConfig,
  type ResponseLogicTaskContext,
} from "@/lib/frontmind-api";
import { Progress } from "@/components/ui/progress";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send,
  Paperclip,
  X,
  FileText,
  Loader2,
  Upload,
  ChevronDown,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { KnowledgeBaseProgressDto } from "@shared/knowledge-base-progress";
import { consumePendingFrontMindBuildDraft } from "@/lib/build-version";

interface FilePreview {
  file: File;
  id: string;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const AMBIGUOUS_ADVANCE_PATTERN =
  /^(继续|下一步|下一个|继续吧|请继续|next)[。！!]*$/i;

export default function ChatInput({
  fixedAgentProfile,
  syncKnowledgeBaseSnapshot = false,
  composerPrefill,
  responseLogicContext,
  knowledgeBaseProgress,
}: {
  fixedAgentProfile?: string;
  syncKnowledgeBaseSnapshot?: boolean;
  composerPrefill?: string;
  responseLogicContext?: ResponseLogicTaskContext;
  knowledgeBaseProgress?: KnowledgeBaseProgressDto | null;
}) {
  const [text, setText] = useState(() => consumePendingFrontMindBuildDraft());
  const [files, setFiles] = useState<FilePreview[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  // Synchronous lock ref to prevent duplicate sends (React state updates are async)
  const sendLockRef = useRef(false);

  // Per-message model selection - default from config
  const [selectedModel, setSelectedModel] = useState(() => {
    if (fixedAgentProfile) return fixedAgentProfile;
    const config = getConfig();
    return config.agentProfile || "frontmind-pro";
  });

  useEffect(() => {
    if (fixedAgentProfile) setSelectedModel(fixedAgentProfile);
  }, [fixedAgentProfile]);

  useEffect(() => {
    if (composerPrefill) setText(composerPrefill);
  }, [composerPrefill]);

  const { sendMessage, uploadProgress: rawUploadProgress } = useSendMessage();
  const { activeConversation } = useConversation();

  // Only show upload progress if it belongs to the current active conversation
  const uploadProgress =
    rawUploadProgress &&
    rawUploadProgress.conversationId === activeConversation?.id
      ? rawUploadProgress
      : null;

  const isRunning =
    activeConversation?.status === "running" ||
    activeConversation?.status === "pending";
  const knowledgeBaseAttachmentResumeRequired =
    syncKnowledgeBaseSnapshot &&
    activeConversation?.knowledgeBase?.notice?.code ===
      "KNOWLEDGE_BASE_ATTACHMENTS_REQUIRED";
  const knowledgeBaseNotStarted =
    syncKnowledgeBaseSnapshot && !activeConversation?.taskId;
  const knowledgeInteractionLocked =
    syncKnowledgeBaseSnapshot &&
    Boolean(activeConversation?.taskId) &&
    activeConversation?.status !== "awaiting_input";
  const inputLocked =
    (isRunning || knowledgeInteractionLocked) &&
    !knowledgeBaseAttachmentResumeRequired;
  const currentKnowledgeLeaf = knowledgeBaseProgress?.branches
    .flatMap((branch) => branch.leaves)
    .find((leaf) => leaf.id === knowledgeBaseProgress.build.currentLeafId);
  const currentNodePresentationReady = currentKnowledgeBasePresentationReady(
    activeConversation,
    knowledgeBaseProgress?.build.revision,
    knowledgeBaseProgress?.build.currentLeafId,
  );
  const knowledgeBaseComplete =
    syncKnowledgeBaseSnapshot &&
    Boolean(knowledgeBaseProgress?.packageAllowed) &&
    !currentKnowledgeLeaf;

  const clearSelectedFiles = useCallback(() => {
    setFiles([]);
  }, []);

  // Close model menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        modelMenuRef.current &&
        !modelMenuRef.current.contains(e.target as Node)
      ) {
        setModelMenuOpen(false);
      }
    };
    if (modelMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [modelMenuOpen]);

  const addFiles = useCallback(async (newFiles: File[]) => {
    const previews: FilePreview[] = [];
    for (const file of newFiles) {
      const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      previews.push({ file, id });
    }
    setFiles((prev) => [...prev, ...previews]);
  }, []);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const submitContent = useCallback(
    async (message: string, selectedFiles: FilePreview[]) => {
      if (
        (!message.trim() && selectedFiles.length === 0) ||
        isSending ||
        inputLocked ||
        knowledgeBaseNotStarted
      ) {
        return;
      }
      if (
        syncKnowledgeBaseSnapshot &&
        selectedFiles.length === 0 &&
        AMBIGUOUS_ADVANCE_PATTERN.test(message.trim())
      ) {
        toast.info("“继续/下一步”不会推进知识节点", {
          description:
            "请点击“确认当前内容”；如需修改，请直接输入意见或上传资料。",
        });
        return;
      }

      // Synchronous lock: immediately block subsequent calls before async state updates.
      if (sendLockRef.current) return;
      sendLockRef.current = true;

      setIsSending(true);
      try {
        const sent = await sendMessage(
          message,
          selectedFiles.map((file) => file.file),
          {
            agentProfile: fixedAgentProfile || selectedModel,
            syncKnowledgeBaseSnapshot,
            knowledgeBaseExpectedGeneration:
              syncKnowledgeBaseSnapshot && activeConversation?.knowledgeBase
                ? activeConversation.knowledgeBase.generation
                : undefined,
            knowledgeBaseExpectedRevision:
              syncKnowledgeBaseSnapshot && knowledgeBaseProgress
                ? knowledgeBaseProgress.build.revision
                : undefined,
            knowledgeBaseExpectedLeafId:
              syncKnowledgeBaseSnapshot && currentKnowledgeLeaf
                ? currentKnowledgeLeaf.id
                : undefined,
            responseLogicContext,
          },
        );
        if (sent) {
          setText("");
          clearSelectedFiles();
          textareaRef.current?.focus();
        }
      } finally {
        setIsSending(false);
        sendLockRef.current = false;
      }
    },
    [
      clearSelectedFiles,
      fixedAgentProfile,
      inputLocked,
      isSending,
      knowledgeBaseNotStarted,
      knowledgeBaseProgress,
      currentKnowledgeLeaf,
      responseLogicContext,
      selectedModel,
      sendMessage,
      syncKnowledgeBaseSnapshot,
    ],
  );

  const handleSubmit = useCallback(
    async () => submitContent(text, files),
    [files, submitContent, text],
  );

  const confirmCurrentContent = useCallback(async () => {
    if (text.trim() || files.length > 0) return;
    await submitContent("确认", []);
  }, [files.length, submitContent, text]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const isUploading = uploadProgress !== null;

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (inputLocked || isSending || isUploading || knowledgeBaseNotStarted) {
        return;
      }
      const droppedFiles = Array.from(e.dataTransfer.files);
      if (droppedFiles.length > 0) {
        addFiles(droppedFiles);
      }
    },
    [addFiles, inputLocked, isSending, isUploading, knowledgeBaseNotStarted],
  );

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
    },
    [],
  );

  const quickActionsDisabled =
    Boolean(text.trim()) ||
    files.length > 0 ||
    isSending ||
    inputLocked ||
    isUploading ||
    knowledgeBaseNotStarted ||
    (syncKnowledgeBaseSnapshot &&
      Boolean(currentKnowledgeLeaf) &&
      !currentNodePresentationReady);

  // Get current model display info
  const currentModelInfo =
    MODEL_OPTIONS.find((m) => m.value === selectedModel) || MODEL_OPTIONS[2];

  return (
    <div
      className="relative px-3 pb-3 pt-3 bg-gradient-to-t from-background via-background/95 to-transparent sm:px-5 sm:pb-5"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-primary/5 border-2 border-dashed border-primary/30 rounded-2xl mx-4 mb-4"
          >
            <div className="text-center">
              <Paperclip className="w-8 h-8 text-primary/50 mx-auto mb-2" />
              <p className="text-sm text-primary/70 font-medium">
                拖放文件到此处
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="max-w-4xl mx-auto">
        {syncKnowledgeBaseSnapshot &&
          (currentKnowledgeLeaf || knowledgeBaseComplete) && (
            <div
              className={cn(
                "mb-3 rounded-2xl border px-4 py-3 shadow-sm",
                knowledgeBaseComplete
                  ? "border-emerald-200 bg-emerald-50/90"
                  : "border-violet-200 bg-violet-50/90",
              )}
              data-testid="knowledge-node-action-card"
            >
              {knowledgeBaseComplete ? (
                <div>
                  <p className="text-sm font-semibold text-emerald-900">
                    全部节点已完成
                  </p>
                  <p className="mt-1 text-xs leading-5 text-emerald-800">
                    请点击右上角“更新知识库”，同步最终知识库内容。
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold tracking-wide text-violet-700">
                        当前待确认
                      </p>
                      <p className="mt-1 truncate text-sm font-semibold text-violet-950">
                        {currentKnowledgeLeaf!.branchTitle} /{" "}
                        {currentKnowledgeLeaf!.title}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-violet-800/80">
                        {currentNodePresentationReady
                          ? "可直接确认，也可以输入修改意见或上传补充资料。"
                          : "正在恢复当前节点内容，显示完整后才可确认。"}
                      </p>
                    </div>
                    <div className="shrink-0">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void confirmCurrentContent()}
                        disabled={quickActionsDisabled}
                        className="rounded-xl"
                      >
                        <Check className="h-4 w-4" />
                        确认当前内容
                      </Button>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-violet-700/75">
                    如需修改，请在下方输入意见或上传资料；建议尽量上传与当前部分相关的补充图片，以丰富知识库内容。系统返回修订稿后，再确认当前内容。
                  </p>
                </>
              )}
            </div>
          )}

        {/* Upload progress indicator */}
        <AnimatePresence>
          {isUploading && uploadProgress && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-2 px-1"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <Upload className="w-3.5 h-3.5 text-primary animate-pulse" />
                <span className="text-xs text-muted-foreground">
                  上传文件 ({uploadProgress.currentFileIndex + 1}/
                  {uploadProgress.totalFiles})：
                  <span className="text-foreground font-medium ml-1">
                    {uploadProgress.currentFileName}
                  </span>
                </span>
                <span className="text-xs font-mono text-primary ml-auto">
                  {uploadProgress.overallPercent}%
                </span>
              </div>
              <Progress
                value={uploadProgress.overallPercent}
                className="h-1.5"
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* File previews */}
        <AnimatePresence>
          {files.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-2 flex flex-wrap gap-2"
            >
              {files.map((fp) => (
                <motion.div
                  key={fp.id}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="relative group"
                >
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border/40 bg-muted/30 shadow-sm max-w-[180px]">
                    <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <span className="min-w-0 text-xs text-muted-foreground">
                      <span className="block truncate">{fp.file.name}</span>
                      <span className="block text-[10px] opacity-70">
                        {formatFileSize(fp.file.size)}
                      </span>
                    </span>
                  </div>
                  <button
                    onClick={() => removeFile(fp.id)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Input card */}
        <div
          className={cn(
            "bg-card/90 border border-border/70 rounded-[1.5rem] transition-all duration-300 shadow-[0_18px_60px_rgba(15,23,42,0.08)] backdrop-blur-xl",
            isDragging && "ring-2 ring-primary/30",
            "focus-within:shadow-[0_24px_70px_rgba(15,23,42,0.11)] focus-within:border-primary/35",
          )}
        >
          <div className="flex min-h-[68px] items-center gap-1.5 p-2.5 sm:gap-2 sm:p-3.5">
            {/* File buttons */}
            <div className="flex items-center gap-1 pb-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-9 h-9 rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={
                      inputLocked ||
                      isSending ||
                      isUploading ||
                      knowledgeBaseNotStarted
                    }
                  >
                    <Paperclip className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>上传文件</TooltipContent>
              </Tooltip>
            </div>

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              placeholder={
                isUploading
                  ? `正在上传文件 ${uploadProgress!.overallPercent}%...`
                  : inputLocked
                    ? syncKnowledgeBaseSnapshot
                      ? "正在根据你的补充资料更新当前节点…"
                      : "FrontMind 正在编排内容制作流程..."
                    : knowledgeBaseNotStarted
                      ? "请先点击上方“构建企业知识库”完成资料采集设置"
                      : syncKnowledgeBaseSnapshot
                        ? "输入修改意见，或上传资料；提交后仍停留当前节点"
                        : "输入你的内容需求，按 Enter 开始编排..."
              }
              disabled={
                inputLocked ||
                isSending ||
                isUploading ||
                knowledgeBaseNotStarted
              }
              rows={2}
              className="h-11 flex-1 resize-none overflow-y-auto bg-transparent py-2 text-[15px] leading-6 text-foreground placeholder:text-muted-foreground/55 focus:outline-none"
            />

            {/* Model selector + Send button */}
            <div className="flex items-center gap-1 pb-0.5">
              {/* Model selector dropdown */}
              <div className="relative" ref={modelMenuRef}>
                {fixedAgentProfile ? null : (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => setModelMenuOpen(!modelMenuOpen)}
                          className={cn(
                            "flex items-center gap-1.5 px-2.5 py-2 rounded-xl text-xs font-medium transition-all",
                            "bg-secondary/80 text-muted-foreground hover:bg-primary/10 hover:text-primary",
                            modelMenuOpen && "bg-primary/10 text-primary",
                          )}
                        >
                          <span className="truncate max-w-[76px] sm:max-w-[148px]">
                            {currentModelInfo.label}
                          </span>
                          <ChevronDown
                            className={cn(
                              "w-3 h-3 transition-transform",
                              modelMenuOpen && "rotate-180",
                            )}
                          />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>选择模型</TooltipContent>
                    </Tooltip>

                    {/* Dropdown menu */}
                    <AnimatePresence>
                      {modelMenuOpen && (
                        <motion.div
                          initial={{ opacity: 0, y: 4, scale: 0.95 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 4, scale: 0.95 }}
                          transition={{ duration: 0.15 }}
                          className="absolute bottom-full mb-1 right-0 w-52 rounded-xl border border-border/40 bg-popover shadow-lg z-50 overflow-hidden"
                        >
                          {MODEL_OPTIONS.map((model) => (
                            <button
                              key={model.value}
                              onClick={() => {
                                setSelectedModel(model.value);
                                saveConfig({ agentProfile: model.value });
                                setModelMenuOpen(false);
                              }}
                              className={cn(
                                "w-full text-left px-3 py-2.5 flex items-center justify-between transition-colors",
                                selectedModel === model.value
                                  ? "bg-primary/10 text-primary"
                                  : "hover:bg-muted/60 text-foreground",
                              )}
                            >
                              <div>
                                <p className="text-sm font-medium">
                                  {model.label}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {model.description}
                                </p>
                              </div>
                              {selectedModel === model.value && (
                                <div className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                              )}
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </>
                )}
              </div>

              {/* Send button */}
              <Button
                onClick={handleSubmit}
                disabled={
                  (!text.trim() && files.length === 0) ||
                  isSending ||
                  inputLocked ||
                  isUploading ||
                  knowledgeBaseNotStarted
                }
                size="icon"
                className={cn(
                  "w-10 h-10 rounded-2xl transition-all flex-shrink-0",
                  text.trim() || files.length > 0
                    ? "bg-primary text-primary-foreground shadow-md glow-indigo"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {isSending || isRunning || isUploading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Hint text */}
          <div className="px-4 pb-2">
            <p className="text-xs text-muted-foreground/40">
              {syncKnowledgeBaseSnapshot
                ? "Enter 提交修订 · Shift+Enter 换行 · 支持多文件选择与拖拽上传"
                : "Enter 发送 · Shift+Enter 换行 · 支持资料、图片与交付文件上传"}
            </p>
          </div>
        </div>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        disabled={
          inputLocked || isSending || isUploading || knowledgeBaseNotStarted
        }
        className="hidden"
        onChange={(e) => {
          const selected = Array.from(e.target.files || []);
          if (selected.length > 0) addFiles(selected);
          e.target.value = "";
        }}
      />
    </div>
  );
}
