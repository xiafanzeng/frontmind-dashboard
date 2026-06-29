import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BadgeCheck,
  Bot,
  BrainCircuit,
  BriefcaseBusiness,
  CheckCircle2,
  ClipboardCheck,
  Compass,
  DatabaseZap,
  FileArchive,
  FileText,
  Globe2,
  ImageIcon,
  ListChecks,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  Network,
  Palette,
  Play,
  RefreshCw,
  Route,
  SearchCheck,
  Send,
  ServerCog,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UploadCloud,
  User,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import type {
  WorkflowManifest,
  WorkflowStepLoadResponse,
  WorkflowStepPublic,
  WorkflowStepStatus,
  WorkflowUploadedFile,
  WorkflowUploadResponse,
} from "@shared/workflow";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  parseOutputMessages,
  useConversation,
  type Attachment,
} from "@/contexts/ConversationContext";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import { getConfig, retrieveTask, type TaskResponse } from "@/lib/frontmind-api";
import { cn } from "@/lib/utils";

const PROGRESS_KEY = "frontmind-workflow-completed-steps-v2";
const RUN_ID_KEY = "frontmind-workflow-run-id-v2";
const ACTIVITY_KEY_PREFIX = "frontmind-workflow-run-activity-v1:";
const CONVERSATION_KEY_PREFIX = "frontmind-workflow-conversation-v1:";

type ConversationStatus = "idle" | "running" | "pending" | "completed" | "error" | "failed";

interface WorkflowRunActivity {
  id: string;
  stepId: string;
  stepTitle: string;
  stepLabel: string;
  sequence: number;
  executedAt: string;
  fields: Array<{ name: string; value: string }>;
  notes: string;
  uploads: WorkflowUploadedFile[];
  messages: string[];
  artifacts: WorkflowStepLoadResponse["artifactPlaceholders"];
  taskId?: string;
  taskStatus?: string;
  taskUrl?: string;
  conversationId?: string;
}

const stepIcons: Record<string, LucideIcon> = {
  S0: Route,
  S1: DatabaseZap,
  SP1: ClipboardCheck,
  S2: Network,
  S3: TrendingUp,
  S4: Compass,
  SP2: ClipboardCheck,
  S4_5: FileText,
  SP3: UploadCloud,
  S5: SearchCheck,
  S5_5: BadgeCheck,
  S6: MessageSquareText,
  S7: Palette,
  S8: BrainCircuit,
  S9: BriefcaseBusiness,
  S10: Globe2,
  STRATEGY_PACK: FileArchive,
  E0: UploadCloud,
  E1: ListChecks,
  EP4: ClipboardCheck,
  E2: FileText,
  E3: ImageIcon,
  E4: ShieldCheck,
  E5: Send,
  EP5: ClipboardCheck,
  E6: SearchCheck,
  P1: Globe2,
};

const statusMeta: Record<
  WorkflowStepStatus,
  { label: string; className: string; icon: LucideIcon }
> = {
  locked: {
    label: "未解锁",
    className: "border-stone-200 bg-stone-100 text-stone-500",
    icon: LockKeyhole,
  },
  ready: {
    label: "可执行",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: Play,
  },
  running: {
    label: "执行中",
    className: "border-sky-200 bg-sky-50 text-sky-700",
    icon: Loader2,
  },
  done: {
    label: "已完成",
    className: "border-teal-200 bg-teal-50 text-teal-700",
    icon: CheckCircle2,
  },
  unavailable: {
    label: "资源缺失",
    className: "border-rose-200 bg-rose-50 text-rose-700",
    icon: LockKeyhole,
  },
};

function readCompletedSteps() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function readRunId() {
  const stored = localStorage.getItem(RUN_ID_KEY);
  if (stored) return stored;
  const fresh = `wf_browser_${Date.now()}`;
  localStorage.setItem(RUN_ID_KEY, fresh);
  return fresh;
}

function readRunActivities(runId: string): WorkflowRunActivity[] {
  try {
    const raw = localStorage.getItem(`${ACTIVITY_KEY_PREFIX}${runId}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readWorkflowConversationId(runId: string) {
  return localStorage.getItem(`${CONVERSATION_KEY_PREFIX}${runId}`);
}

function normalizeConversationStatus(status?: string): ConversationStatus {
  if (status === "completed") return "completed";
  if (status === "pending") return "pending";
  if (status === "failed" || status === "error") return "error";
  if (status === "idle") return "idle";
  return "running";
}

function getArtifactIcon(kind: WorkflowStepLoadResponse["artifactPlaceholders"][number]["kind"]) {
  if (kind === "image") return ImageIcon;
  if (kind === "site") return Globe2;
  if (kind === "document" || kind === "markdown") return FileText;
  if (kind === "json") return DatabaseZap;
  return FileArchive;
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function isHiddenExecutionPrompt(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  return (
    normalized.includes("请执行 FrontMind Workflow") ||
    normalized.includes("请启动完整 FrontMind Workflow") ||
    normalized.startsWith("已创建真实 agent 任务") ||
    normalized.includes("workflow 执行包 ZIP") ||
    normalized.includes("完整 workflow 执行包 ZIP") ||
    normalized.includes("CURRENT_STEP_GATE.md") ||
    (normalized.includes("RUN_CONTEXT.md") && normalized.includes("执行要求")) ||
    (normalized.includes("预期产物") && normalized.includes("不要跳到其他环节")) ||
    (normalized.includes("当前环节完成后必须暂停") && normalized.includes("不要自动继续后续"))
  );
}

function getVisibleActivityMessages(messages: string[]) {
  return messages
    .map((message) => message.trim())
    .filter((message) => message.length > 0 && !isHiddenExecutionPrompt(message));
}

function outputContainsHiddenExecutionPrompt(output: NonNullable<TaskResponse["output"]>[number]) {
  if (output.role === "user") return true;
  if (output.summary?.some((summary) => summary.text && isHiddenExecutionPrompt(summary.text))) return true;
  if (output.content?.some((content) => content.text && isHiddenExecutionPrompt(content.text))) return true;
  return false;
}

function getVisibleTaskOutput(output: TaskResponse["output"]) {
  return (output ?? []).filter((item) => !outputContainsHiddenExecutionPrompt(item));
}

function extractTaskMessages(task: TaskResponse): string[] {
  const messages: string[] = [];

  if (task.error?.message) {
    messages.push(`任务错误：${task.error.message}`);
  }

  for (const output of getVisibleTaskOutput(task.output)) {
    for (const summary of output.summary ?? []) {
      if (summary.text) messages.push(summary.text);
    }

    for (const content of output.content ?? []) {
      if (content.text) messages.push(content.text);
      if (content.fileName) messages.push(`生成文件：${content.fileName}`);
    }

    if (output.name && output.type) {
      messages.push(`${output.type}: ${output.name}`);
    }
  }

  return messages
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !isHiddenExecutionPrompt(item))
    .slice(-6);
}

function buildConversationUserText(
  step: WorkflowStepPublic,
  fields: Record<string, string>,
  notes: string,
  uploads: WorkflowUploadedFile[]
) {
  const filledFields = step.inputs
    .map((input) => ({ name: input, value: fields[input]?.trim() ?? "" }))
    .filter((item) => item.value.length > 0);
  const fieldRows = filledFields.length
    ? filledFields.map((field) => `- ${field.name}: ${field.value}`)
    : ["- 无"];
  const uploadRows = uploads.length
    ? uploads.map((file) => `- ${file.name}`)
    : ["- 无"];

  return [
    `执行 Workflow 环节：${step.id} ${step.title}`,
    ``,
    `环节目标：${step.description}`,
    ``,
    `输入项：`,
    ...fieldRows,
    ``,
    `上传资料：`,
    ...uploadRows,
    ``,
    `操作者补充：${notes.trim() || "无"}`,
    ``,
    `预期产物：`,
    ...step.outputs.map((output) => `- ${output}`),
  ].join("\n");
}

function buildConversationAttachments(files: WorkflowUploadedFile[]): Attachment[] {
  return files.map((file) => ({
    id: file.id,
    type: file.type?.startsWith("image/") ? "image" : "file",
    name: file.name,
  }));
}

export default function WorkflowBoard() {
  const {
    state: conversationState,
    createConversation,
    setActive,
    addMessage,
    updateStatus,
    updateAssistantMessages,
    updateTitle,
  } = useConversation();
  const [manifest, setManifest] = useState<WorkflowManifest | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(() => readCompletedSteps());
  const [unavailableSteps, setUnavailableSteps] = useState<Set<string>>(() => new Set());
  const [runningStepId, setRunningStepId] = useState<string | null>(null);
  const [executingSteps, setExecutingSteps] = useState<Set<string>>(() => new Set());
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [runId, setRunId] = useState(() => readRunId());
  const [runActivities, setRunActivities] = useState<WorkflowRunActivity[]>(() =>
    readRunActivities(readRunId())
  );
  const [workflowConversationId, setWorkflowConversationId] = useState<string | null>(() =>
    readWorkflowConversationId(readRunId())
  );
  const [operatorNotes, setOperatorNotes] = useState<Record<string, string>>({});
  const [fieldValues, setFieldValues] = useState<Record<string, Record<string, string>>>({});
  const [loadResults, setLoadResults] = useState<Record<string, WorkflowStepLoadResponse>>({});
  const [uploadedFiles, setUploadedFiles] = useState<Record<string, WorkflowUploadedFile[]>>({});
  const [uploadingStepId, setUploadingStepId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/workflow/manifest")
      .then((res) => {
        if (!res.ok) throw new Error("manifest request failed");
        return res.json() as Promise<WorkflowManifest>;
      })
      .then((data) => {
        if (!cancelled) setManifest(data);
      })
      .catch(() => {
        toast.error("Workflow manifest 加载失败");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(Array.from(completedSteps)));
  }, [completedSteps]);

  useEffect(() => {
    setRunActivities(readRunActivities(runId));
    setWorkflowConversationId(readWorkflowConversationId(runId));
  }, [runId]);

  useEffect(() => {
    localStorage.setItem(`${ACTIVITY_KEY_PREFIX}${runId}`, JSON.stringify(runActivities));
  }, [runActivities, runId]);

  const stepsById = useMemo(() => {
    const map = new Map<string, WorkflowStepPublic>();
    manifest?.steps.forEach((item) => map.set(item.id, item));
    return map;
  }, [manifest]);

  const selectedStep = selectedStepId ? stepsById.get(selectedStepId) ?? null : null;

  const getStepStatus = (step: WorkflowStepPublic): WorkflowStepStatus => {
    if (runningStepId === step.id) return "running";
    if (executingSteps.has(step.id)) return "running";
    if (unavailableSteps.has(step.id)) return "unavailable";
    if (completedSteps.has(step.id)) return "done";
    const depsReady = step.dependencies.every((dependency) => completedSteps.has(dependency));
    return depsReady ? "ready" : "locked";
  };

  const progressSteps = manifest?.steps.filter((step) => step.kind !== "optional") ?? [];
  const completedCount = progressSteps.filter((step) => completedSteps.has(step.id)).length;

  const updateField = (stepId: string, field: string, value: string) => {
    setFieldValues((current) => ({
      ...current,
      [stepId]: {
        ...(current[stepId] ?? {}),
        [field]: value,
      },
    }));
  };

  const ensureWorkflowConversation = (step: WorkflowStepPublic) => {
    const storedConversationId = workflowConversationId ?? readWorkflowConversationId(runId);
    const storedConversationExists = storedConversationId
      ? conversationState.conversations.some((conversation) => conversation.id === storedConversationId)
      : false;

    if (storedConversationId && storedConversationExists) {
      setActive(storedConversationId);
      return storedConversationId;
    }

    const freshConversationId = createConversation();
    setWorkflowConversationId(freshConversationId);
    localStorage.setItem(`${CONVERSATION_KEY_PREFIX}${runId}`, freshConversationId);
    updateTitle(freshConversationId, `WF ${step.id}`);
    return freshConversationId;
  };

  const uploadFiles = async (step: WorkflowStepPublic, files: FileList | null) => {
    const selectedFiles = Array.from(files ?? []);
    if (selectedFiles.length === 0) return;

    const status = getStepStatus(step);
    if (status === "locked") {
      toast.warning("请先完成前置环节");
      return;
    }

    setUploadingStepId(step.id);
    const uploaded: WorkflowUploadedFile[] = [];

    try {
      for (let index = 0; index < selectedFiles.length; index += 1) {
        const file = selectedFiles[index];
        const response = await fetch(
          `/api/workflow/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step.id)}/uploads`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "x-file-name": encodeURIComponent(file.name),
              "x-file-type": file.type || "application/octet-stream",
            },
            body: file,
          }
        );

        if (!response.ok) {
          throw new Error(`upload failed: ${file.name}`);
        }

        const data = (await response.json()) as WorkflowUploadResponse;
        uploaded.push(data.file);
      }

      setUploadedFiles((current) => ({
        ...current,
        [step.id]: [...(current[step.id] ?? []), ...uploaded],
      }));
      toast.success(`已上传 ${uploaded.length} 个文件`);
    } catch {
      toast.error("文件上传失败");
    } finally {
      setUploadingStepId(null);
    }
  };

  const loadStep = async (step: WorkflowStepPublic, rerun = false) => {
    const status = getStepStatus(step);
    if (status === "locked") {
      toast.warning("请先完成前置环节");
      return;
    }

    const config = getConfig();
    if (!config.apiKey) {
      toast.error("请先在设置中填写 API Key");
      return;
    }

    setRunningStepId(step.id);
    setUnavailableSteps((current) => {
      const next = new Set(current);
      next.delete(step.id);
      return next;
    });

    try {
      const currentFields = fieldValues[step.id] ?? {};
      const currentNotes = operatorNotes[step.id] ?? "";
      const responseStartedAt = Date.now();
      const response = await fetch(`/api/workflow/steps/${encodeURIComponent(step.id)}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-FrontMind-API-Key": config.apiKey,
          "X-FrontMind-Base-URL": config.baseUrl,
        },
        body: JSON.stringify({
          runId,
          operatorNotes: currentNotes,
          fields: currentFields,
          agentProfile: config.agentProfile,
        }),
      });

      if (!response.ok) {
        throw new Error("step load failed");
      }

      const data = (await response.json()) as WorkflowStepLoadResponse;
      const activityId = `${step.id}-${Date.now()}`;
      const conversationId = ensureWorkflowConversation(step);
      const conversationUserText = buildConversationUserText(
        step,
        currentFields,
        currentNotes,
        data.contextUploads
      );
      const activity: WorkflowRunActivity = {
        id: activityId,
        stepId: step.id,
        stepTitle: step.title,
        stepLabel: step.buttonLabel,
        sequence: step.sequence,
        executedAt: data.loadedAt,
        fields: step.inputs
          .map((input) => ({ name: input, value: currentFields[input]?.trim() ?? "" }))
          .filter((item) => item.value.length > 0),
        notes: currentNotes.trim(),
        uploads: data.contextUploads,
        messages: data.operatorMessages,
        artifacts: data.artifactPlaceholders,
        taskId: data.task?.id,
        taskStatus: data.task?.status,
        taskUrl: data.task?.taskUrl,
        conversationId,
      };

      addMessage(conversationId, {
        id: `workflow-user-${activityId}`,
        role: "user",
        content: conversationUserText,
        attachments:
          data.contextUploads.length > 0
            ? buildConversationAttachments(data.contextUploads)
            : undefined,
        timestamp: Date.now(),
      });
      updateTitle(conversationId, `${step.id} ${step.buttonLabel}`);
      if (data.task?.id) {
        updateStatus(conversationId, normalizeConversationStatus(data.task.status), {
          taskId: data.task.id,
          taskUrl: data.task.taskUrl,
          previousResponseId: data.task.id,
          startedAt: responseStartedAt,
        });
      }

      setRunId(data.runId);
      localStorage.setItem(RUN_ID_KEY, data.runId);
      setLoadResults((current) => ({ ...current, [step.id]: data }));
      setRunActivities((current) => {
        const withoutCurrentStep = current.filter((item) => item.stepId !== step.id);
        return [...withoutCurrentStep, activity].sort((left, right) => left.sequence - right.sequence);
      });

      if (data.task?.id) {
        if (data.task.status === "completed") {
          setCompletedSteps((current) => {
            const next = new Set(current);
            next.add(step.id);
            return next;
          });
          toast.success(rerun ? "已重新执行" : "已完成并解锁下一步");
        } else {
          setExecutingSteps((current) => {
            const next = new Set(current);
            next.add(step.id);
            return next;
          });
          toast.success("Agent 任务已创建");
          void pollWorkflowTask(
            activityId,
            data.task.id,
            step.id,
            conversationId,
            config.agentProfile,
            responseStartedAt
          );
        }
      } else if (data.nextStatus === "done") {
        setCompletedSteps((current) => {
          const next = new Set(current);
          next.add(step.id);
          return next;
        });
        toast.success(rerun ? "已重新执行" : "已完成并解锁下一步");
      } else {
        setUnavailableSteps((current) => {
          const next = new Set(current);
          next.add(step.id);
          return next;
        });
        toast.error("执行资源未找到");
      }
    } catch {
      toast.error("执行失败");
    } finally {
      setRunningStepId(null);
    }
  };

  const pollWorkflowTask = async (
    activityId: string,
    taskId: string,
    stepId: string,
    conversationId: string,
    modelName: string,
    responseStartedAt: number
  ) => {
    const maxPolls = 900;
    for (let pollCount = 0; pollCount < maxPolls; pollCount += 1) {
      await new Promise((resolve) => setTimeout(resolve, pollCount === 0 ? 1200 : 4000));

      try {
        const task = await retrieveTask(taskId);
        const taskMessages = extractTaskMessages(task);
        const normalizedStatus = task.status === "failed" ? "error" : task.status;
        const visibleTaskOutput = getVisibleTaskOutput(task.output);
        const taskOutputLength = visibleTaskOutput.length;

        setRunActivities((current) =>
          current.map((activity) => {
            if (activity.id !== activityId) return activity;
            return {
              ...activity,
              taskStatus: normalizedStatus,
              taskUrl: task.metadata?.task_url || activity.taskUrl,
              messages: taskMessages.length > 0
                ? [`任务状态：${normalizedStatus}`, ...taskMessages]
                : [`任务状态：${normalizedStatus}`, ...activity.messages.slice(0, 4)],
            };
          })
        );

        if (visibleTaskOutput.length > 0) {
          const assistantMessages = parseOutputMessages(visibleTaskOutput, responseStartedAt, modelName);
          if (assistantMessages.length > 0) {
            updateAssistantMessages(conversationId, assistantMessages);
          }
        }

        updateStatus(conversationId, normalizeConversationStatus(normalizedStatus), {
          taskId,
          taskUrl: task.metadata?.task_url,
          previousResponseId: taskId,
          lastKnownOutputLength: taskOutputLength,
          completedAt: normalizedStatus === "completed" ? Date.now() : undefined,
        });

        if (normalizedStatus === "completed") {
          setExecutingSteps((current) => {
            const next = new Set(current);
            next.delete(stepId);
            return next;
          });
          setCompletedSteps((current) => {
            const next = new Set(current);
            next.add(stepId);
            return next;
          });
          toast.success("Workflow 环节执行完成");
          return;
        }

        if (normalizedStatus === "error") {
          setExecutingSteps((current) => {
            const next = new Set(current);
            next.delete(stepId);
            return next;
          });
          updateStatus(conversationId, "error", {
            taskId,
            taskUrl: task.metadata?.task_url,
            previousResponseId: taskId,
            lastKnownOutputLength: taskOutputLength,
          });
          toast.error("Workflow 环节执行失败");
          return;
        }
      } catch (error: any) {
        setRunActivities((current) =>
          current.map((activity) =>
            activity.id === activityId
              ? {
                  ...activity,
                  messages: [`轮询任务失败：${error.message || "未知错误"}`, ...activity.messages],
                }
              : activity
          )
        );
        setExecutingSteps((current) => {
          const next = new Set(current);
          next.delete(stepId);
            return next;
          });
        updateStatus(conversationId, "error", {
          taskId,
          previousResponseId: taskId,
        });
        return;
      }
    }

    setExecutingSteps((current) => {
      const next = new Set(current);
      next.delete(stepId);
      return next;
    });
    updateStatus(conversationId, "pending", {
      taskId,
      previousResponseId: taskId,
    });
    toast.warning("Agent 任务仍在运行，可回到首页对话继续查看");
  };

  const resetRunPool = () => {
    void fetch(`/api/workflow/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
    localStorage.removeItem(`${ACTIVITY_KEY_PREFIX}${runId}`);
    localStorage.removeItem(`${CONVERSATION_KEY_PREFIX}${runId}`);
    const freshRunId = `wf_browser_${Date.now()}`;
    setRunId(freshRunId);
    setWorkflowConversationId(null);
    setCompletedSteps(new Set());
    setUnavailableSteps(new Set());
    setExecutingSteps(new Set());
    setLoadResults({});
    setOperatorNotes({});
    setFieldValues({});
    setUploadedFiles({});
    setRunActivities([]);
    localStorage.setItem(RUN_ID_KEY, freshRunId);
    localStorage.removeItem(PROGRESS_KEY);
    toast.success("当前任务已重置");
  };

  if (!manifest) {
    return (
      <div className="flex h-[100dvh] w-screen items-center justify-center bg-background text-foreground">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          加载 FrontMind Workflow
        </div>
      </div>
    );
  }

  const renderStepNavButton = (step: WorkflowStepPublic) => {
    const status = getStepStatus(step);
    const StatusIcon = statusMeta[status].icon;
    const StepIcon = stepIcons[step.id] ?? Sparkles;
    const missingDeps = step.dependencies
      .filter((dependency) => !completedSteps.has(dependency))
      .map((dependency) => stepsById.get(dependency)?.buttonLabel ?? dependency);

    return (
      <button
        key={step.id}
        type="button"
        onClick={() => setSelectedStepId(step.id)}
        className={cn(
          "group flex w-full items-center gap-3 rounded-[8px] border bg-background px-3 py-2.5 text-left shadow-sm transition-colors hover:border-primary/35 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
          status === "locked" && "bg-stone-50/70 text-muted-foreground hover:border-border hover:bg-stone-50",
          status === "done" && "border-teal-200 bg-teal-50/55",
          status === "running" && "border-sky-200 bg-sky-50/70",
          status === "unavailable" && "border-rose-200 bg-rose-50/70"
        )}
      >
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-[8px] border bg-card text-primary",
            step.kind === "pause" && "text-amber-700",
            step.kind === "export" && "text-sky-700",
            step.kind === "optional" && "text-indigo-700",
            status === "locked" && "text-stone-400"
          )}
        >
          <StepIcon className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="w-9 shrink-0 text-xs font-semibold text-muted-foreground">{step.id}</span>
            <h3 className="truncate text-sm font-semibold leading-tight text-foreground">{step.buttonLabel}</h3>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {missingDeps.length ? `等待 ${missingDeps.join("、")}` : step.description}
          </p>
        </div>
        <Badge variant="outline" className={cn("shrink-0 gap-1 px-2 py-0.5 text-[11px]", statusMeta[status].className)}>
          <StatusIcon className={cn("size-3", status === "running" && "animate-spin")} />
          {statusMeta[status].label}
        </Badge>
      </button>
    );
  };

  return (
    <div className="h-[100dvh] w-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-full flex-col">
        <header className="border-b bg-background/95 px-4 py-3 sm:px-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <a
                href="/"
                className="inline-flex size-9 items-center justify-center rounded-[8px] border bg-card text-muted-foreground transition-colors hover:text-foreground"
                aria-label="返回"
              >
                <ArrowLeft className="size-4" />
              </a>
              <div>
                <h1 className="text-xl font-semibold tracking-normal sm:text-2xl">{manifest.title}</h1>
              </div>
            </div>
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col bg-muted/20 lg:flex-row">
          <aside className="flex max-h-[44vh] w-full shrink-0 flex-col border-b bg-card/45 lg:max-h-none lg:w-[360px] lg:border-b-0 lg:border-r">
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
              {(["strategy", "execution"] as const).map((layer) => {
                const layerSteps = manifest.steps.filter((step) => step.layer === layer);
                const layerCompleted = layerSteps.filter((step) => completedSteps.has(step.id)).length;

                return (
                  <section key={layer} className="space-y-2">
                    <div className="flex items-center justify-between px-1">
                      <h2 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                        {layer === "strategy" ? "策略层" : "执行层"}
                      </h2>
                      <span className="text-xs text-muted-foreground">
                        {layerCompleted}/{layerSteps.length}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {layerSteps.map(renderStepNavButton)}
                    </div>
                  </section>
                );
              })}
            </div>
          </aside>

          <section className="min-h-0 flex-1 overflow-hidden p-4 sm:p-5">
            <RunPoolPanel
              completedCount={completedCount}
              totalCount={progressSteps.length}
              activities={runActivities}
              onReset={resetRunPool}
            />
          </section>
        </main>
      </div>

      <Sheet open={Boolean(selectedStep)} onOpenChange={(open) => !open && setSelectedStepId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-[560px]">
          {selectedStep ? (
            <StepDetail
              step={selectedStep}
              status={getStepStatus(selectedStep)}
              result={loadResults[selectedStep.id]}
              missingDependencies={selectedStep.dependencies
                .filter((dependency) => !completedSteps.has(dependency))
                .map((dependency) => stepsById.get(dependency)?.buttonLabel ?? dependency)}
              notes={operatorNotes[selectedStep.id] ?? ""}
              fields={fieldValues[selectedStep.id] ?? {}}
              uploads={uploadedFiles[selectedStep.id] ?? []}
              isUploading={uploadingStepId === selectedStep.id}
              onNotesChange={(value) =>
                setOperatorNotes((current) => ({ ...current, [selectedStep.id]: value }))
              }
              onFieldChange={(field, value) => updateField(selectedStep.id, field, value)}
              onUpload={(files) => uploadFiles(selectedStep, files)}
              onRun={() => loadStep(selectedStep)}
              onRerun={() => loadStep(selectedStep, true)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function RunPoolPanel({
  completedCount,
  totalCount,
  activities,
  onReset,
}: {
  completedCount: number;
  totalCount: number;
  activities: WorkflowRunActivity[];
  onReset: () => void;
}) {
  const orderedActivities = [...activities].sort((left, right) => {
    const leftRunning = left.taskStatus === "running" || left.taskStatus === "pending";
    const rightRunning = right.taskStatus === "running" || right.taskStatus === "pending";
    if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
    return right.sequence - left.sequence;
  });
  const hasRunningActivity = activities.some(
    (activity) => activity.taskStatus === "running" || activity.taskStatus === "pending"
  );

  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <div className="rounded-[8px] border bg-background p-4 shadow-sm">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              <ServerCog className="size-4 text-primary" />
              运行面板
              <Badge
                variant="outline"
                className={cn(
                  "bg-card",
                  hasRunningActivity && "border-sky-200 bg-sky-50 text-sky-700"
                )}
              >
                {hasRunningActivity ? "运行中" : activities.length > 0 ? "待继续" : "待开始"}
              </Badge>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              左侧选择环节，补充输入和文件后执行；这里显示每一步的输入、状态和输出。
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-2 text-sm sm:grid-cols-[96px_96px_96px_160px]">
            <div className="rounded-[8px] border bg-card p-3">
              <div className="text-xs text-muted-foreground">已运行</div>
              <div className="mt-1 text-lg font-semibold">{activities.length}</div>
            </div>
            <div className="rounded-[8px] border bg-card p-3">
              <div className="text-xs text-muted-foreground">已完成</div>
              <div className="mt-1 text-lg font-semibold">{completedCount}</div>
            </div>
            <div className="rounded-[8px] border bg-card p-3">
              <div className="text-xs text-muted-foreground">环节数</div>
              <div className="mt-1 text-lg font-semibold">{totalCount}</div>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="col-span-2 h-full min-h-14 sm:col-span-1">
                  <RefreshCw className="size-4" />
                  重置任务
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认重置当前任务？</AlertDialogTitle>
                  <AlertDialogDescription>
                    这会新建任务上下文，并清空当前运行记录、输入缓存和已上传文件上下文。已完成的环节状态也会重置。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={onReset}>确认重置</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded-[8px] border bg-background p-4 shadow-sm">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b pb-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ListChecks className="size-4 text-primary" />
            运行输出
          </div>
          <Badge variant="outline" className="bg-card">{activities.length}</Badge>
        </div>

        {activities.length === 0 ? (
          <div className="mt-4 flex min-h-0 flex-1 items-center justify-center rounded-[8px] border bg-card px-6 py-10 text-center text-sm leading-6 text-muted-foreground">
            还没有运行记录。左侧选择环节，上传资料并开始执行后，这里会显示输入文件、任务状态、输出内容和生成文件。
          </div>
        ) : (
          <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {orderedActivities.map((activity) => (
              <RunActivityCard key={activity.id} activity={activity} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function RunActivityCard({ activity }: { activity: WorkflowRunActivity }) {
  const visibleMessages = getVisibleActivityMessages(activity.messages);
  const userLines = [
    ...activity.fields.map((field) => `${field.name}：${field.value}`),
    ...(activity.notes ? [`操作者补充：${activity.notes}`] : []),
  ];
  const outputContent = visibleMessages.join("\n\n").trim();

  return (
    <article className="space-y-4 rounded-[8px] border bg-background p-4 text-sm shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="outline" className="bg-card">{activity.stepId}</Badge>
          <div className="truncate font-semibold">{activity.stepLabel}</div>
          {activity.taskStatus ? (
            <Badge
              variant="outline"
              className={cn(
                "bg-card",
                (activity.taskStatus === "running" || activity.taskStatus === "pending") &&
                  "border-sky-200 bg-sky-50 text-sky-700",
                activity.taskStatus === "completed" && "border-teal-200 bg-teal-50 text-teal-700",
                activity.taskStatus === "error" && "border-rose-200 bg-rose-50 text-rose-700"
              )}
            >
              {activity.taskStatus}
            </Badge>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground">
          {new Date(activity.executedAt).toLocaleString()}
        </div>
      </div>

      <div className="space-y-5">
        <div className="flex items-start justify-end gap-3">
          <div className="max-w-[82%] space-y-2">
            <div className="rounded-3xl rounded-tr-md bg-primary px-4 py-3 text-primary-foreground shadow-sm">
              {userLines.length > 0 ? (
                <div className="space-y-1.5 whitespace-pre-wrap break-words leading-6">
                  {userLines.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </div>
              ) : (
                <div>已启动本环节。</div>
              )}
            </div>
            {activity.uploads.length > 0 ? (
              <div className="flex flex-wrap justify-end gap-2">
                {activity.uploads.map((file) => (
                  <div
                    key={file.id}
                    className="flex max-w-[260px] items-center gap-2 rounded-2xl border bg-card/80 px-3 py-2 text-xs shadow-sm"
                  >
                    <FileText className="size-3.5 shrink-0 text-primary" />
                    <span className="truncate">{file.name}</span>
                    <span className="shrink-0 text-muted-foreground">{formatFileSize(file.size)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
            <User className="size-4" />
          </div>
        </div>

        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Bot className="size-4" />
          </div>
          <div className="max-w-[86%] space-y-2">
            <div className="rounded-3xl rounded-tl-md border bg-card/80 px-4 py-3 text-foreground shadow-sm">
              {outputContent ? (
                <MarkdownRenderer
                  content={outputContent}
                  className="prose prose-sm max-w-none prose-p:my-1.5 prose-headings:my-2 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1"
                />
              ) : (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  等待 Agent 输出内容
                </div>
              )}
            </div>
            {activity.artifacts.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {activity.artifacts.map((artifact) => {
                  const ArtifactIcon = getArtifactIcon(artifact.kind);
                  return (
                    <Badge key={artifact.name} variant="outline" className="gap-1 bg-background">
                      <ArtifactIcon className="size-3" />
                      {artifact.name}
                    </Badge>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

function StepDetail({
  step,
  status,
  result,
  missingDependencies,
  notes,
  fields,
  uploads,
  isUploading,
  onNotesChange,
  onFieldChange,
  onUpload,
  onRun,
  onRerun,
}: {
  step: WorkflowStepPublic;
  status: WorkflowStepStatus;
  result?: WorkflowStepLoadResponse;
  missingDependencies: string[];
  notes: string;
  fields: Record<string, string>;
  uploads: WorkflowUploadedFile[];
  isUploading: boolean;
  onNotesChange: (value: string) => void;
  onFieldChange: (field: string, value: string) => void;
  onUpload: (files: FileList | null) => void;
  onRun: () => void;
  onRerun: () => void;
}) {
  const StatusIcon = statusMeta[status].icon;
  const StepIcon = stepIcons[step.id] ?? Sparkles;
  const isLocked = status === "locked";
  const isBusy = status === "running";
  const isDone = status === "done";
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const uploadDisabled = isLocked || isBusy || isUploading;

  return (
    <>
      <SheetHeader className="border-b px-5 py-5">
        <div className="space-y-4 pr-8">
          <div className="flex items-center justify-between gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-[8px] border bg-card text-primary">
              <StepIcon className="size-5" />
            </span>
            <div className="flex flex-wrap justify-end gap-2">
              <Badge variant="outline">{step.id}</Badge>
              <Badge variant="outline" className={cn("gap-1", statusMeta[status].className)}>
                <StatusIcon className={cn("size-3", isBusy && "animate-spin")} />
                {statusMeta[status].label}
              </Badge>
            </div>
          </div>
          <div className="space-y-1.5">
            <SheetTitle className="text-2xl leading-tight">{step.title}</SheetTitle>
            <SheetDescription className="text-sm leading-5">{step.owner}</SheetDescription>
          </div>
        </div>
      </SheetHeader>

      <div className="space-y-5 px-5 py-5">
        <section className="rounded-[8px] border bg-card px-3 py-3">
          <div className="text-sm font-semibold">环节目标</div>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.description}</p>
        </section>

        {isLocked ? (
          <section className="rounded-[8px] border border-stone-200 bg-stone-50 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-stone-700">
              <LockKeyhole className="size-4" />
              前置环节
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {missingDependencies.map((dependency) => (
                <Badge key={dependency} variant="outline" className="bg-background text-stone-600">
                  {dependency}
                </Badge>
              ))}
            </div>
          </section>
        ) : null}

        <section className="space-y-3">
          <div className="text-sm font-semibold">输入项</div>
          <div className="space-y-2">
            {step.inputs.map((input) => (
              <label key={input} className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{input}</span>
                <Input
                  value={fields[input] ?? ""}
                  onChange={(event) => onFieldChange(input, event.target.value)}
                  placeholder={`填写${input}`}
                  disabled={isLocked || isBusy}
                />
              </label>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <div className="text-sm font-semibold">上传资料</div>
          <label
            className={cn(
              "flex min-h-24 flex-col items-center justify-center gap-2 rounded-[8px] border border-dashed bg-card px-4 py-4 text-center transition-colors",
              uploadDisabled ? "opacity-60" : "hover:border-primary/40 hover:bg-primary/5",
              isDraggingFiles && !uploadDisabled && "border-primary/60 bg-primary/10"
            )}
            onDragOver={(event) => {
              if (uploadDisabled) return;
              event.preventDefault();
              setIsDraggingFiles(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setIsDraggingFiles(false);
              }
            }}
            onDrop={(event) => {
              if (uploadDisabled) return;
              event.preventDefault();
              setIsDraggingFiles(false);
              onUpload(event.dataTransfer.files);
            }}
          >
            <UploadCloud className="size-5 text-primary" />
            <span className="text-sm font-medium text-foreground">
              {isUploading ? "上传中" : isDraggingFiles ? "松开即可上传" : "拖拽文件到这里，或点击上传"}
            </span>
            <span className="text-xs text-muted-foreground">支持画册、PDF、Word、PPT、图片、JSON、Excel、ZIP</span>
            <input
              type="file"
              multiple
              className="sr-only"
              disabled={uploadDisabled}
              accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.gif,.json,.md,.txt,.csv,.zip,application/pdf,image/*"
              onChange={(event) => {
                onUpload(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
          </label>

          {uploads.length > 0 ? (
            <div className="space-y-2">
              {uploads.map((file) => (
                <div
                  key={file.id}
                  className="flex items-center justify-between gap-3 rounded-[8px] border bg-background px-3 py-2 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <FileText className="size-4 shrink-0 text-primary" />
                    <span className="truncate">{file.name}</span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatFileSize(file.size)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="space-y-2">
          <div className="text-sm font-semibold">操作者补充</div>
          <Textarea
            value={notes}
            onChange={(event) => onNotesChange(event.target.value)}
            disabled={isLocked || isBusy}
            className="min-h-28 resize-none"
            placeholder="补充本环节需要考虑的事实、偏好、限制或审批意见"
          />
        </section>

        <section className="space-y-2">
          <div className="text-sm font-semibold">预期产物</div>
          <div className="flex flex-wrap gap-2">
            {step.outputs.map((output) => (
              <Badge key={output} variant="outline" className="bg-card">
                {output}
              </Badge>
            ))}
          </div>
        </section>

        <section className="rounded-[8px] border bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ServerCog className="size-4 text-primary" />
            运行状态
          </div>
          {result ? (
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-[8px] border bg-background p-2">
                  <div className="text-xs text-muted-foreground">任务状态</div>
                  <div className="mt-1 truncate font-medium">{result.task?.status ?? result.status}</div>
                </div>
                <div className="rounded-[8px] border bg-background p-2">
                  <div className="text-xs text-muted-foreground">上传文件</div>
                  <div className="mt-1 font-medium">{result.contextUploads.length}</div>
                </div>
              </div>
              <div className="space-y-2">
                {getVisibleActivityMessages(result.operatorMessages).map((message) => (
                  <div key={message} className="rounded-[8px] border bg-background px-3 py-2 text-sm leading-5 text-muted-foreground">
                    {message}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {result.artifactPlaceholders.map((artifact) => {
                  const ArtifactIcon = getArtifactIcon(artifact.kind);
                  return (
                    <Badge key={artifact.name} variant="outline" className="gap-1 bg-background">
                      <ArtifactIcon className="size-3" />
                      {artifact.name}
                    </Badge>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="mt-3 rounded-[8px] border bg-background px-3 py-2 text-sm text-muted-foreground">
              等待开始执行。
            </div>
          )}
        </section>
      </div>

      <SheetFooter className="border-t px-5 py-4">
        <Button onClick={onRun} disabled={isLocked || isBusy} className="w-full">
          {isBusy ? <Loader2 className="size-4 animate-spin" /> : step.kind === "pause" ? <ClipboardCheck className="size-4" /> : <Play className="size-4" />}
          {step.kind === "pause" ? "确认并解锁" : "开始执行"}
        </Button>
        <Button variant="outline" onClick={onRerun} disabled={!isDone || isBusy} className="w-full">
          <RefreshCw className="size-4" />
          重新执行
        </Button>
      </SheetFooter>
    </>
  );
}
