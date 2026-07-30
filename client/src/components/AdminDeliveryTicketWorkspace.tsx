import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Download,
  ExternalLink,
  FileJson2,
  FileText,
  History,
  Inbox,
  Link2,
  Loader2,
  LockKeyhole,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Save,
  Search,
  Send,
  SlidersHorizontal,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { uploadFile } from "@/lib/frontmind-api";
import { trpc } from "@/lib/trpc";
import {
  DELIVERY_TICKET_STATUS_LABELS,
  type DeliveryTicketStatus,
} from "@shared/delivery-ticket";

import "./admin-delivery-ticket-workspace.css";

export type AdminDeliveryTicket = {
  id: string;
  userId?: number | null;
  enterpriseName?: string | null;
  assignedAdminId?: number | null;
  assignedAdminName?: string | null;
  type: "content_asset" | "website_operation";
  category?: string | null;
  title?: string | null;
  topic?: string | null;
  description?: string | null;
  targetUrl?: string | null;
  targetPage?: string | null;
  knowledgeSnapshotId?: string | null;
  status: DeliveryTicketStatus;
  publicStatus?: "pending" | "completed" | null;
  publicStatusLabel?: string | null;
  preferredMedia?: string | null;
  icpDeclarations?: {
    domainHolderInformation?: string | null;
    websiteInformation?: string | null;
    aliyunAppVerificationCompleted?: boolean;
  } | null;
  publicSummary?: string | null;
  deliveryLinks?: Array<{ label: string; url: string }>;
  quotaPool?: string | null;
  quotaState?: "reserved" | "consumed" | "released" | null;
  revision: number;
  createdAt?: number | string | Date | null;
  updatedAt?: number | string | Date | null;
  resultUrl?: string | null;
  resultSummary?: string | null;
};

type AdminDeliveryTicketEvent = {
  id: string;
  visibility: "customer" | "internal";
  eventType?: string | null;
  message?: string | null;
  statusFrom?: string | null;
  statusTo?: string | null;
  actorLabel?: string | null;
  createdAt?: number | string | Date | null;
  attachments?: Array<{
    id?: string;
    filename?: string | null;
    url?: string | null;
    fileId?: string | null;
  }>;
};

type TicketDetailPayload = {
  ticket: AdminDeliveryTicket;
  events: AdminDeliveryTicketEvent[];
  attachments?: AdminDeliveryTicketEvent["attachments"];
  deliveryRecords?: Array<{
    id: string;
    platform?: string | null;
    targetUrl?: string | null;
    executedAt?: number | string | Date | null;
    resultStatus?: "success" | "failed" | "pending_confirmation" | string;
    platformMessage?: string | null;
    attachments?: AdminDeliveryTicketEvent["attachments"];
  }>;
};

type WebsiteContentTemplatePreviewRow = {
  ticketId: string;
  revision: number;
  category: string;
  categoryLabel: string;
  topic: string;
  currentComplete: boolean;
  incomingComplete: boolean;
  currentPublicSummary: string;
  incomingPublicSummary: string;
  change: "unchanged" | "complete" | "summary";
};

type WebsiteContentTemplatePreview = {
  fileHash: string;
  workspaceUserId: number;
  totals: {
    records: number;
    changed: number;
    completing: number;
    summariesUpdated: number;
    unchanged: number;
  };
  changes: WebsiteContentTemplatePreviewRow[];
  preflightToken?: string;
  preflightExpiresAt?: string;
};

type PendingWebsiteContentTemplate = {
  file: File;
  preview: WebsiteContentTemplatePreview;
};

export type AdminDeliveryTicketPreviewFixtures = {
  tickets: AdminDeliveryTicket[];
  events: AdminDeliveryTicketEvent[];
  periodId: string;
  revision: number;
  contentAssetQuota: {
    used: number;
    reserved: number;
    consumed: number;
    limit: number;
  };
  websiteContentQuota: {
    used: number;
    reserved: number;
    consumed: number;
    limit: number;
  };
};

const STATUS_ORDER: DeliveryTicketStatus[] = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
  "completed",
  "rejected",
  "cancelled",
];

const OPEN_TICKET_STATUSES = new Set<DeliveryTicketStatus>([
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
]);

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object"
    ? (value as Record<string, any>)
    : {};
}

export function websiteContentTemplatePreflightUsable(
  preview: Pick<
    WebsiteContentTemplatePreview,
    "preflightToken" | "preflightExpiresAt"
  >,
  now = Date.now(),
) {
  if (!preview.preflightToken?.trim()) return false;
  if (!preview.preflightExpiresAt) return true;
  const expiresAt = Date.parse(preview.preflightExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt - now > 5_000;
}

function normalizeWebsiteContentTemplatePreview(
  value: unknown,
): WebsiteContentTemplatePreview {
  const payload = asRecord(asRecord(value).preview || value);
  const totals = asRecord(payload.totals);
  if (
    !/^[a-f0-9]{64}$/i.test(String(payload.fileHash || "")) ||
    !Number.isInteger(Number(payload.workspaceUserId)) ||
    !Array.isArray(payload.changes)
  ) {
    throw new Error("服务端返回的官网内容预检结果无效");
  }
  const changes = payload.changes.map((item: unknown) => {
    const row = asRecord(item);
    const change = String(row.change || "");
    if (
      !["unchanged", "complete", "summary"].includes(change) ||
      !String(row.ticketId || "")
    ) {
      throw new Error("官网内容预检差异记录无效");
    }
    return {
      ticketId: String(row.ticketId),
      revision: Number(row.revision || 0),
      category: String(row.category || ""),
      categoryLabel: String(row.categoryLabel || row.category || ""),
      topic: String(row.topic || ""),
      currentComplete: Boolean(row.currentComplete),
      incomingComplete: Boolean(row.incomingComplete),
      currentPublicSummary: String(row.currentPublicSummary || ""),
      incomingPublicSummary: String(row.incomingPublicSummary || ""),
      change: change as WebsiteContentTemplatePreviewRow["change"],
    };
  });
  return {
    fileHash: String(payload.fileHash).toLowerCase(),
    workspaceUserId: Number(payload.workspaceUserId),
    totals: {
      records: Number(totals.records || 0),
      changed: Number(totals.changed || 0),
      completing: Number(totals.completing || 0),
      summariesUpdated: Number(totals.summariesUpdated || 0),
      unchanged: Number(totals.unchanged || 0),
    },
    changes,
    ...(payload.preflightToken
      ? { preflightToken: String(payload.preflightToken) }
      : {}),
    ...(payload.preflightExpiresAt
      ? { preflightExpiresAt: String(payload.preflightExpiresAt) }
      : {}),
  };
}

async function readWebsiteContentTemplateError(response: Response) {
  try {
    const payload = await response.json();
    return (
      payload?.error?.message ||
      payload?.message ||
      `官网内容模板处理失败 (${response.status})`
    );
  } catch {
    return `官网内容模板处理失败 (${response.status})`;
  }
}

export function safeAdminDeliveryUrl(
  value: string | null | undefined,
  origin = typeof window === "undefined"
    ? "http://localhost"
    : window.location.origin,
) {
  if (!value) return null;
  try {
    const url = new URL(value, origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return value.startsWith("/")
      ? `${url.pathname}${url.search}${url.hash}`
      : url.toString();
  } catch {
    return null;
  }
}

export function normalizeAdminTicketList(
  value: unknown,
): AdminDeliveryTicket[] {
  const payload = asRecord(value);
  const source = Array.isArray(value)
    ? value
    : Array.isArray(payload.tickets)
      ? payload.tickets
      : Array.isArray(payload.items)
        ? payload.items
        : [];
  return source
    .map((entry: unknown) => {
      const ticket = asRecord(entry);
      const status = STATUS_ORDER.includes(ticket.status)
        ? ticket.status
        : "submitted";
      const type =
        ticket.type === "website_operation"
          ? "website_operation"
          : "content_asset";
      return {
        ...ticket,
        id: String(ticket.id || ""),
        type,
        status,
        publicStatus:
          ticket.publicStatus === "completed" ||
          ticket.publicStatus === "pending"
            ? ticket.publicStatus
            : undefined,
        revision: Number(ticket.revision || 1),
        targetUrl: ticket.targetUrl ?? ticket.targetPage ?? null,
        preferredMedia: ticket.preferredMedia ?? null,
        publicSummary: ticket.publicSummary ?? ticket.resultSummary ?? null,
        deliveryLinks: Array.isArray(ticket.deliveryLinks)
          ? ticket.deliveryLinks
          : [],
      } as AdminDeliveryTicket;
    })
    .filter((ticket: AdminDeliveryTicket) => Boolean(ticket.id));
}

export function flattenAdminTicketPages(
  pages: readonly unknown[] | null | undefined,
) {
  const seen = new Set<string>();
  return (pages || [])
    .flatMap((page) => normalizeAdminTicketList(page))
    .filter((ticket) => {
      if (seen.has(ticket.id)) return false;
      seen.add(ticket.id);
      return true;
    });
}

export function mergeAdminTicketPages(
  pages: readonly unknown[] | null | undefined,
) {
  const firstPage = asRecord(pages?.[0]);
  return {
    ...firstPage,
    tickets: flattenAdminTicketPages(pages),
  };
}

export function buildAdminTicketListInput(input: {
  userId?: number | null;
  assignedAdminId?: number | string | null;
  query?: string | null;
  type?: string | null;
  status?: string | null;
  publicStatus?: string | null;
  limit?: number;
  order?: "updated_desc" | "created_asc";
}) {
  const result: {
    userId?: number;
    assignedAdminId?: number;
    query?: string;
    type?: AdminDeliveryTicket["type"];
    status?: DeliveryTicketStatus;
    publicStatus?: "pending" | "completed";
    limit: number;
    order?: "updated_desc" | "created_asc";
  } = {
    limit: Math.min(100, Math.max(1, input.limit ?? 20)),
  };
  if (Number.isInteger(input.userId) && Number(input.userId) > 0) {
    result.userId = Number(input.userId);
  }
  const assignedAdminId = Number(input.assignedAdminId);
  if (Number.isInteger(assignedAdminId) && assignedAdminId > 0) {
    result.assignedAdminId = assignedAdminId;
  }
  const query = input.query?.trim();
  if (query) result.query = query.slice(0, 100);
  if (input.type === "content_asset" || input.type === "website_operation") {
    result.type = input.type;
  }
  if (
    input.status &&
    STATUS_ORDER.includes(input.status as DeliveryTicketStatus)
  ) {
    result.status = input.status as DeliveryTicketStatus;
  }
  if (input.publicStatus === "pending" || input.publicStatus === "completed") {
    result.publicStatus = input.publicStatus;
  }
  if (input.order) result.order = input.order;
  return result;
}

export function deliveryTicketPublicStatus(
  ticket:
    | Pick<AdminDeliveryTicket, "status" | "publicStatus">
    | null
    | undefined,
): "pending" | "completed" {
  if (
    ticket?.publicStatus === "pending" ||
    ticket?.publicStatus === "completed"
  ) {
    return ticket.publicStatus;
  }
  return OPEN_TICKET_STATUSES.has(ticket?.status || "submitted")
    ? "pending"
    : "completed";
}

export function normalizeTicketDetail(
  value: unknown,
  fallback?: AdminDeliveryTicket,
): TicketDetailPayload | null {
  const payload = asRecord(value);
  const ticketCandidate = payload.ticket ?? payload.item ?? fallback;
  if (!ticketCandidate) return null;
  const [ticket] = normalizeAdminTicketList([ticketCandidate]);
  if (!ticket) return null;
  const events = Array.isArray(payload.events)
    ? payload.events.map((event: unknown, index: number) => {
        const record = asRecord(event);
        return {
          ...record,
          id: String(record.id || `event-${index}`),
          visibility:
            record.visibility === "internal" ? "internal" : "customer",
          statusFrom: record.statusFrom ?? record.fromStatus ?? null,
          statusTo: record.statusTo ?? record.toStatus ?? null,
        } as AdminDeliveryTicketEvent;
      })
    : [];
  return {
    ticket,
    events,
    attachments: Array.isArray(payload.attachments)
      ? payload.attachments.map((attachment: unknown) => {
          const record = asRecord(attachment);
          return {
            ...record,
            url: record.url ?? record.downloadUrl ?? null,
          };
        })
      : [],
    deliveryRecords: Array.isArray(payload.deliveryRecords)
      ? payload.deliveryRecords
      : Array.isArray(payload.deliveries)
        ? payload.deliveries
        : Array.isArray(payload.operationRecords)
          ? payload.operationRecords
          : events
              .filter((event) => asRecord(event).operationResult)
              .map((event) => ({
                id: event.id,
                ...asRecord(asRecord(event).operationResult),
                executedAt:
                  asRecord(asRecord(event).operationResult).executedAt ??
                  event.createdAt,
              })),
  };
}

export function isCustomerVisibleEvent(event: AdminDeliveryTicketEvent) {
  return event.visibility !== "internal";
}

export function formatAdminTicketDate(
  value: number | string | Date | null | undefined,
) {
  if (!value) return "时间未记录";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未记录";
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function ticketTitle(ticket: AdminDeliveryTicket) {
  return ticket.title || ticket.topic || "未命名工单";
}

function ticketTypeLabel(type: AdminDeliveryTicket["type"]) {
  return type === "website_operation" ? "官网运营" : "内容资产";
}

function StatusPill({
  ticket,
}: {
  ticket: Pick<AdminDeliveryTicket, "status" | "publicStatus">;
}) {
  const status = deliveryTicketPublicStatus(ticket);
  return (
    <span className={`admin-ticket-status is-${status}`}>
      {status === "completed" ? "已完成" : "待受理"}
    </span>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="admin-ticket-empty">
      <Inbox className="h-6 w-6" />
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function Timeline({
  title,
  description,
  events,
  internal = false,
}: {
  title: string;
  description: string;
  events: AdminDeliveryTicketEvent[];
  internal?: boolean;
}) {
  return (
    <section
      className={`admin-ticket-timeline ${internal ? "is-internal" : ""}`}
    >
      <header>
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
        {internal ? (
          <LockKeyhole className="h-4 w-4" />
        ) : (
          <MessageSquare className="h-4 w-4" />
        )}
      </header>
      {events.length ? (
        <div className="admin-ticket-timeline-list">
          {events.map((event) => (
            <article key={event.id}>
              <div>
                <strong>{event.actorLabel || "管理员"}</strong>
                <time>{formatAdminTicketDate(event.createdAt)}</time>
              </div>
              {event.statusTo && (
                <span className="admin-ticket-event-label">
                  状态更新为{" "}
                  {DELIVERY_TICKET_STATUS_LABELS[
                    event.statusTo as DeliveryTicketStatus
                  ] || event.statusTo}
                </span>
              )}
              {event.message && <p>{event.message}</p>}
              {event.attachments?.length ? (
                <div className="admin-ticket-attachment-list">
                  {event.attachments.map((attachment, index) => (
                    <a
                      key={attachment.id || attachment.fileId || index}
                      href={safeAdminDeliveryUrl(attachment.url) || undefined}
                      target={
                        safeAdminDeliveryUrl(attachment.url)
                          ? "_blank"
                          : undefined
                      }
                      rel={
                        safeAdminDeliveryUrl(attachment.url)
                          ? "noopener noreferrer"
                          : undefined
                      }
                      aria-disabled={!safeAdminDeliveryUrl(attachment.url)}
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                      {attachment.filename || "交付文件"}
                    </a>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="admin-ticket-timeline-empty">
          {internal ? "暂无内部备注。" : "暂无客户可见交流记录。"}
        </p>
      )}
    </section>
  );
}

export default function AdminDeliveryTicketWorkspace({
  userId,
  enterpriseName,
  servicePlanCode,
  serviceStatus,
  canAdjustQuota = false,
  preview = false,
  previewFixtures,
}: {
  userId: number;
  enterpriseName?: string | null;
  servicePlanCode?: string | null;
  serviceStatus?: string | null;
  canAdjustQuota?: boolean;
  preview?: boolean;
  previewFixtures?: AdminDeliveryTicketPreviewFixtures;
}) {
  const previewMode = import.meta.env.DEV && preview;
  const [, setLocation] = useLocation();
  const api = (trpc.admin as any).deliveryTickets;
  const quotaAdmin = canAdjustQuota;
  const [previewQuotaLimits, setPreviewQuotaLimits] = useState({
    contentAssetPublishLimit: previewFixtures?.contentAssetQuota.limit ?? 0,
    websiteContentPublishLimit: previewFixtures?.websiteContentQuota.limit ?? 0,
    revision: previewFixtures?.revision ?? 0,
  });
  const initialTicketId = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("ticketId") || "";
  }, []);
  const [selectedTicketId, setSelectedTicketId] = useState(initialTicketId);
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedKeyword(keyword.trim()),
      250,
    );
    return () => window.clearTimeout(timeout);
  }, [keyword]);

  const listInput = useMemo(
    () =>
      buildAdminTicketListInput({
        userId,
        query: debouncedKeyword,
        type: typeFilter,
        publicStatus: statusFilter,
        limit: 20,
      }),
    [debouncedKeyword, statusFilter, typeFilter, userId],
  );
  const listQuery = api.list.useInfiniteQuery(listInput, {
    enabled: !previewMode && userId > 0,
    retry: false,
    getNextPageParam: (lastPage: any) => lastPage?.nextCursor || undefined,
  });
  const adjustQuotaMutation = api.adjustQuota.useMutation();
  const previewListData = {
    tickets: previewFixtures?.tickets ?? [],
    quotas: {
      contentAssetPublish: {
        allowed: true,
        used: previewFixtures?.contentAssetQuota.used ?? 0,
        reserved: previewFixtures?.contentAssetQuota.reserved ?? 0,
        consumed: previewFixtures?.contentAssetQuota.consumed ?? 0,
        limit: previewQuotaLimits.contentAssetPublishLimit,
        periodId: previewFixtures?.periodId ?? "",
        revision: previewQuotaLimits.revision,
      },
      websiteContentPublish: {
        allowed: true,
        used: previewFixtures?.websiteContentQuota.used ?? 0,
        reserved: previewFixtures?.websiteContentQuota.reserved ?? 0,
        consumed: previewFixtures?.websiteContentQuota.consumed ?? 0,
        limit: previewQuotaLimits.websiteContentPublishLimit,
        periodId: previewFixtures?.periodId ?? "",
        revision: previewQuotaLimits.revision,
      },
    },
  };
  const listPages = (listQuery.data?.pages || []) as unknown[];
  const listData = previewMode
    ? previewListData
    : mergeAdminTicketPages(listPages);
  const quotaPayload = asRecord(asRecord(listData).quotas);
  const contentQuota = asRecord(
    quotaPayload.contentAssetPublish ||
      quotaPayload.content_asset_publish ||
      quotaPayload.contentAsset,
  );
  const websiteQuota = asRecord(
    quotaPayload.websiteContentPublish ||
      quotaPayload.website_content_publish ||
      quotaPayload.websiteContent,
  );
  const quotaPeriodId = String(
    contentQuota.periodId || websiteQuota.periodId || "",
  );
  const quotaRevision = Number(
    contentQuota.revision ?? websiteQuota.revision ?? 0,
  );
  const quotaAdjustmentAvailable =
    quotaAdmin &&
    (previewMode ||
      (serviceStatus === "active" &&
        (servicePlanCode === "advanced" || servicePlanCode === "luxury")));
  const [quotaEditing, setQuotaEditing] = useState(false);
  const [contentQuotaLimit, setContentQuotaLimit] = useState(0);
  const [websiteQuotaLimit, setWebsiteQuotaLimit] = useState(0);
  const tickets = useMemo(
    () =>
      previewMode
        ? normalizeAdminTicketList(previewListData)
        : flattenAdminTicketPages(listPages),
    [listPages, previewMode],
  );

  useEffect(() => {
    if (
      selectedTicketId &&
      tickets.some((ticket) => ticket.id === selectedTicketId)
    ) {
      return;
    }
    setSelectedTicketId(tickets[0]?.id || "");
  }, [selectedTicketId, tickets]);

  useEffect(() => {
    if (quotaEditing) return;
    setContentQuotaLimit(Number(contentQuota.limit ?? 0));
    setWebsiteQuotaLimit(Number(websiteQuota.limit ?? 0));
  }, [contentQuota.limit, quotaEditing, websiteQuota.limit]);

  const selectedTicket =
    tickets.find((ticket) => ticket.id === selectedTicketId) || null;
  const detailQuery = api.detail.useQuery(
    {
      userId,
      ticketId: selectedTicketId || "00000000-0000-0000-0000-000000000000",
    },
    {
      enabled: !previewMode && Boolean(selectedTicketId),
      retry: false,
    },
  );
  const detail = previewMode
    ? selectedTicket
      ? {
          ticket: selectedTicket,
          events: previewFixtures?.events ?? [],
        }
      : null
    : normalizeTicketDetail(detailQuery.data, selectedTicket || undefined);
  const updateMutation = api.update.useMutation();
  const addMessageMutation = api.addMessage.useMutation();
  const recordDeliveryMutation = api.recordDelivery.useMutation();
  const [publicReply, setPublicReply] = useState("");
  const [publicSummary, setPublicSummary] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [publicFiles, setPublicFiles] = useState<File[]>([]);
  const [deliveryPlatform, setDeliveryPlatform] = useState("");
  const [deliveryTargetUrl, setDeliveryTargetUrl] = useState("");
  const [deliveryExecutedAt, setDeliveryExecutedAt] = useState("");
  const [deliveryResultStatus, setDeliveryResultStatus] = useState<
    "success" | "failed" | "pending_confirmation"
  >("pending_confirmation");
  const [deliveryPlatformMessage, setDeliveryPlatformMessage] = useState("");
  const [deliveryFiles, setDeliveryFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [maintenanceUploading, setMaintenanceUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deliveryFileInputRef = useRef<HTMLInputElement>(null);
  const maintenanceFileInputRef = useRef<HTMLInputElement>(null);
  const websiteTemplateFileInputRef = useRef<HTMLInputElement>(null);
  const [websiteTemplateBusy, setWebsiteTemplateBusy] = useState<
    "" | "download" | "preview" | "publish"
  >("");
  const [pendingWebsiteTemplate, setPendingWebsiteTemplate] =
    useState<PendingWebsiteContentTemplate | null>(null);

  useEffect(() => {
    setPublicReply("");
    setPublicSummary(detail?.ticket.publicSummary || "");
    setInternalNote("");
    setPublicFiles([]);
    setDeliveryPlatform(detail?.ticket.deliveryLinks?.[0]?.label || "");
    setDeliveryTargetUrl(detail?.ticket.deliveryLinks?.[0]?.url || "");
    setDeliveryExecutedAt("");
    setDeliveryResultStatus("pending_confirmation");
    setDeliveryPlatformMessage("");
    setDeliveryFiles([]);
  }, [
    detail?.ticket.deliveryLinks,
    detail?.ticket.id,
    detail?.ticket.publicSummary,
    detail?.ticket.status,
  ]);

  useEffect(() => {
    setPendingWebsiteTemplate(null);
    setWebsiteTemplateBusy("");
  }, [userId]);

  const filteredTickets = useMemo(() => {
    if (!previewMode) return tickets;
    return tickets.filter((ticket) => {
      if (typeFilter !== "all" && ticket.type !== typeFilter) return false;
      if (
        statusFilter !== "all" &&
        deliveryTicketPublicStatus(ticket) !== statusFilter
      )
        return false;
      const query = keyword.trim().toLocaleLowerCase("zh-CN");
      if (!query) return true;
      return [
        ticket.enterpriseName,
        ticket.title,
        ticket.topic,
        ticket.category,
      ].some((value) =>
        String(value || "")
          .toLocaleLowerCase("zh-CN")
          .includes(query),
      );
    });
  }, [keyword, previewMode, statusFilter, tickets, typeFilter]);

  const refresh = async () => {
    if (previewMode) return;
    await Promise.all([
      listQuery.refetch(),
      selectedTicketId ? detailQuery.refetch() : Promise.resolve(),
    ]);
  };

  const requestWebsiteContentTemplate = async (input: {
    file: File;
    preview?: boolean;
    expectedFileHash?: string;
    preflightToken?: string;
  }) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(input.file.name),
    };
    if (input.preview) headers["X-Import-Preview"] = "true";
    if (input.expectedFileHash) {
      headers["X-Import-File-Hash"] = input.expectedFileHash;
    }
    if (input.preflightToken) {
      headers["X-Import-Preflight-Token"] = input.preflightToken;
    }
    const response = await fetch(`/api/website-content-template/${userId}`, {
      method: "PUT",
      credentials: "include",
      headers,
      body: input.file,
    });
    if (!response.ok) {
      throw new Error(await readWebsiteContentTemplateError(response));
    }
    return response.json();
  };

  const downloadCurrentWebsiteContentTemplate = async () => {
    if (previewMode) {
      toast.info("验收预览不读取客户数据库", {
        description: "真实客户工作台会下载该客户当前工单及逐条修订号。",
      });
      return;
    }
    setWebsiteTemplateBusy("download");
    try {
      const response = await fetch(`/api/website-content-template/${userId}`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(await readWebsiteContentTemplateError(response));
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const filename =
        disposition.match(/filename="?([^";]+)"?/i)?.[1] ||
        `frontmind-website-content-current-${userId}.json`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success("当前官网内容模板已下载");
    } catch (error) {
      toast.error("模板下载失败", {
        description: error instanceof Error ? error.message : "请稍后重试。",
      });
    } finally {
      setWebsiteTemplateBusy("");
    }
  };

  const preflightWebsiteContentTemplate = async (file: File) => {
    if (previewMode) {
      toast.info("验收预览不上传工单模板", {
        description: "正式工作台会先逐条校验修订号并展示真实差异。",
      });
      return;
    }
    setWebsiteTemplateBusy("preview");
    setPendingWebsiteTemplate(null);
    try {
      const result = await requestWebsiteContentTemplate({
        file,
        preview: true,
      });
      const preview = normalizeWebsiteContentTemplatePreview(result);
      if (preview.workspaceUserId !== userId) {
        throw new Error("预检结果与当前客户不一致");
      }
      setPendingWebsiteTemplate({ file, preview });
      if (preview.totals.changed === 0) {
        toast.info("模板与当前官网内容一致");
      } else {
        toast.success("官网内容模板预检通过", {
          description: `发现 ${preview.totals.changed} 条待发布变更。`,
        });
      }
    } catch (error) {
      toast.error(
        /版本|revision|过期|当前内容模板/i.test(
          error instanceof Error ? error.message : "",
        )
          ? "官网内容模板已过期"
          : "官网内容模板预检失败",
        {
          description:
            error instanceof Error ? error.message : "请检查模板后重试。",
        },
      );
    } finally {
      setWebsiteTemplateBusy("");
    }
  };

  const publishWebsiteContentTemplate = async () => {
    if (!pendingWebsiteTemplate || previewMode) return;
    const { file } = pendingWebsiteTemplate;
    let preview = pendingWebsiteTemplate.preview;
    setWebsiteTemplateBusy("publish");
    try {
      if (!websiteContentTemplatePreflightUsable(preview)) {
        const refreshed = await requestWebsiteContentTemplate({
          file,
          preview: true,
        });
        preview = normalizeWebsiteContentTemplatePreview(refreshed);
        setPendingWebsiteTemplate({ file, preview });
      }
      if (
        preview.workspaceUserId !== userId ||
        preview.totals.changed === 0 ||
        !websiteContentTemplatePreflightUsable(preview)
      ) {
        throw new Error("模板没有可发布变更或预检凭证已失效");
      }
      const result = await requestWebsiteContentTemplate({
        file,
        expectedFileHash: preview.fileHash,
        preflightToken: preview.preflightToken,
      });
      const changed = Number(result?.result?.changed || preview.totals.changed);
      setPendingWebsiteTemplate(null);
      await refresh();
      toast.success("官网内容已发布", {
        description: `${changed} 条工单在同一事务中完成更新。`,
      });
    } catch (error) {
      toast.error(
        /版本|revision|过期|预检|凭证|文件内容/i.test(
          error instanceof Error ? error.message : "",
        )
          ? "请重新下载或预检官网内容模板"
          : "官网内容发布失败",
        {
          description: error instanceof Error ? error.message : "请稍后重试。",
        },
      );
    } finally {
      setWebsiteTemplateBusy("");
    }
  };

  const saveQuotaLimits = async () => {
    const contentUsed = Number(contentQuota.used ?? 0);
    const websiteUsed = Number(websiteQuota.used ?? 0);
    if (
      !Number.isInteger(contentQuotaLimit) ||
      !Number.isInteger(websiteQuotaLimit) ||
      contentQuotaLimit < 0 ||
      websiteQuotaLimit < 0
    ) {
      toast.error("额度必须填写为非负整数");
      return;
    }
    if (contentQuotaLimit < contentUsed || websiteQuotaLimit < websiteUsed) {
      toast.error("新额度不能低于当前已消耗与已预留数量");
      return;
    }
    if (previewMode) {
      setPreviewQuotaLimits((current) => ({
        contentAssetPublishLimit: contentQuotaLimit,
        websiteContentPublishLimit: websiteQuotaLimit,
        revision: current.revision + 1,
      }));
      setQuotaEditing(false);
      toast.success("服务周期额度已更新（预览）");
      return;
    }
    if (!quotaPeriodId || quotaRevision < 1) {
      toast.error("当前服务周期尚未同步，暂时不能调整额度");
      return;
    }
    try {
      await adjustQuotaMutation.mutateAsync({
        userId,
        quotaPeriodId,
        expectedRevision: quotaRevision,
        contentAssetPublishLimit: contentQuotaLimit,
        websiteContentPublishLimit: websiteQuotaLimit,
        reason: "系统管理员在客户交付工作台调整服务周期额度",
      });
      await refresh();
      setQuotaEditing(false);
      toast.success("服务周期额度已更新");
    } catch (error) {
      toast.error("额度调整失败", {
        description: error instanceof Error ? error.message : "请刷新后重试。",
      });
    }
  };

  const selectTicket = (ticketId: string) => {
    setSelectedTicketId(ticketId);
    if (!previewMode) {
      setLocation(
        `/admin/customers/${userId}/tickets?ticketId=${encodeURIComponent(ticketId)}`,
      );
    }
  };

  const updateStatus = async () => {
    if (!detail?.ticket) return;
    const summary = publicSummary.trim();
    const contentAssetTicket = detail.ticket.type === "content_asset";
    const platform = contentAssetTicket ? deliveryPlatform.trim() : "";
    const targetUrl = contentAssetTicket ? deliveryTargetUrl.trim() : "";
    if (!summary) {
      toast.error("完成工单前请填写公开内容总结");
      return;
    }
    if ((platform && !targetUrl) || (!platform && targetUrl)) {
      toast.error("发布媒体名称与媒体链接需要同时填写");
      return;
    }
    let deliveryLinks: Array<{ label: string; url: string }> | undefined;
    if (platform && targetUrl) {
      try {
        deliveryLinks = [
          { label: platform, url: new URL(targetUrl).toString() },
        ];
      } catch {
        toast.error("媒体链接格式不正确");
        return;
      }
    }
    if (previewMode) {
      toast.success("工单状态已更新（预览）");
      return;
    }
    const publicMessage = contentAssetTicket ? publicReply.trim() : "";
    try {
      await updateMutation.mutateAsync({
        userId,
        ticketId: detail.ticket.id,
        expectedRevision: detail.ticket.revision,
        status: "completed",
        publicMessage: publicMessage || undefined,
        publicSummary: summary || undefined,
        deliveryLinks: contentAssetTicket ? deliveryLinks : undefined,
        internalNote: internalNote.trim() || undefined,
      });
      await refresh();
      setPublicReply("");
      setPublicSummary("");
      setInternalNote("");
      toast.success("工单状态已更新");
    } catch (error) {
      toast.error("状态更新失败", {
        description: error instanceof Error ? error.message : "请刷新后重试。",
      });
    }
  };

  const uploadKnowledgeMaintenanceArchive = async (file: File) => {
    if (
      !detail?.ticket ||
      detail.ticket.category !== "knowledge_base_maintenance"
    ) {
      return;
    }
    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast.error("知识库维护只接受 ZIP 文件");
      return;
    }
    setMaintenanceUploading(true);
    try {
      const response = await fetch(`/api/dashboard/import/${userId}`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-import-mode": "knowledge",
          "x-maintenance-ticket-id": detail.ticket.id,
        },
        body: file,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          payload?.error?.message ||
            payload?.message ||
            `上传失败 (${response.status})`,
        );
      }
      await refresh();
      toast.success("新知识库版本已通过校验并发布", {
        description: "现在可以填写公开总结并完成维护工单。",
      });
    } catch (error) {
      toast.error("知识库维护版本上传失败", {
        description: error instanceof Error ? error.message : "请稍后重试。",
      });
    } finally {
      setMaintenanceUploading(false);
      if (maintenanceFileInputRef.current) {
        maintenanceFileInputRef.current.value = "";
      }
    }
  };

  const sendMessage = async (visibility: "customer" | "internal") => {
    if (!detail?.ticket) return;
    const message =
      visibility === "customer" ? publicReply.trim() : internalNote.trim();
    if (!message && !(visibility === "customer" && publicFiles.length)) {
      toast.error(
        visibility === "customer"
          ? "请填写公开回复或选择交付文件"
          : "请填写内部备注",
      );
      return;
    }
    if (previewMode) {
      visibility === "customer" ? setPublicReply("") : setInternalNote("");
      setPublicFiles([]);
      toast.success(
        visibility === "customer"
          ? "客户可见回复已发送（预览）"
          : "内部备注已保存（预览）",
      );
      return;
    }
    try {
      setUploading(true);
      const attachments =
        visibility === "customer"
          ? await Promise.all(
              publicFiles.map(async (file) => {
                const uploaded = await uploadFile(file);
                return {
                  ...uploaded,
                  mimeType: file.type || undefined,
                  sizeBytes: file.size,
                };
              }),
            )
          : [];
      await addMessageMutation.mutateAsync({
        userId,
        ticketId: detail.ticket.id,
        clientRequestId: crypto.randomUUID(),
        visibility,
        attachmentKind: "deliverable",
        message: message || "已上传交付文件。",
        attachments,
      });
      await refresh();
      visibility === "customer" ? setPublicReply("") : setInternalNote("");
      if (visibility === "customer") setPublicFiles([]);
      toast.success(
        visibility === "customer" ? "客户可见回复已发送" : "内部备注已保存",
      );
    } catch (error) {
      toast.error("消息保存失败", {
        description: error instanceof Error ? error.message : "请稍后重试。",
      });
    } finally {
      setUploading(false);
    }
  };

  const saveDeliveryRecord = async () => {
    if (!detail?.ticket) return;
    if (!deliveryPlatform.trim() || !deliveryTargetUrl.trim()) {
      toast.error("请填写操作平台和目标 URL");
      return;
    }
    let normalizedUrl = "";
    try {
      normalizedUrl = new URL(deliveryTargetUrl.trim()).toString();
    } catch {
      toast.error("目标 URL 格式不正确");
      return;
    }
    if (previewMode) {
      toast.info("预览环境不写入交付记录");
      return;
    }
    try {
      setUploading(true);
      const attachments = await Promise.all(
        deliveryFiles.map(async (file) => {
          const uploaded = await uploadFile(file);
          return {
            ...uploaded,
            mimeType: file.type || undefined,
            sizeBytes: file.size,
          };
        }),
      );
      await recordDeliveryMutation.mutateAsync({
        userId,
        ticketId: detail.ticket.id,
        expectedRevision: detail.ticket.revision,
        clientRequestId: crypto.randomUUID(),
        result: {
          platform: deliveryPlatform.trim(),
          targetUrl: normalizedUrl,
          executedAt: deliveryExecutedAt
            ? new Date(deliveryExecutedAt).getTime()
            : Date.now(),
          resultStatus: deliveryResultStatus,
          platformMessage: deliveryPlatformMessage.trim() || undefined,
          screenshotFileId: attachments[0]?.fileId,
        },
        attachments,
      });
      await refresh();
      setDeliveryPlatform("");
      setDeliveryTargetUrl("");
      setDeliveryExecutedAt("");
      setDeliveryResultStatus("pending_confirmation");
      setDeliveryPlatformMessage("");
      setDeliveryFiles([]);
      toast.success("交付执行记录已保存");
    } catch (error) {
      toast.error("交付记录保存失败", {
        description: error instanceof Error ? error.message : "请稍后重试。",
      });
    } finally {
      setUploading(false);
    }
  };

  const publicEvents = (detail?.events || []).filter(isCustomerVisibleEvent);
  const internalEvents = (detail?.events || []).filter(
    (event) => event.visibility === "internal",
  );

  return (
    <div className="admin-delivery-workspace">
      <div className="admin-delivery-toolbar">
        <div>
          <p>工单与官网</p>
          <h2>{enterpriseName || "客户"}交付协作</h2>
          <span>
            受理内容与官网需求，记录公开交流、内部判断和最终内容总结。
          </span>
        </div>
      </div>
      <section className="admin-website-template-card">
        <div className="admin-website-template-heading">
          <div className="admin-website-template-title">
            <FileJson2 className="h-5 w-5" />
            <div>
              <strong>官网内容当前模板</strong>
              <span>
                仅处理五类官网内容工单的内容总结与完成状态；域名申请、ICP
                备案和旧技术检查不会进入模板。
              </span>
            </div>
          </div>
          <div className="admin-website-template-actions">
            <Button
              type="button"
              variant="outline"
              disabled={Boolean(websiteTemplateBusy)}
              onClick={() => void downloadCurrentWebsiteContentTemplate()}
            >
              {websiteTemplateBusy === "download" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              下载当前内容模板
            </Button>
            <input
              ref={websiteTemplateFileInputRef}
              type="file"
              className="hidden"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void preflightWebsiteContentTemplate(file);
              }}
            />
            <Button
              type="button"
              className="bg-[#5b2a86] hover:bg-[#49216c]"
              disabled={Boolean(websiteTemplateBusy)}
              onClick={() => websiteTemplateFileInputRef.current?.click()}
            >
              {websiteTemplateBusy === "preview" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="h-4 w-4" />
              )}
              上传并预检
            </Button>
          </div>
        </div>

        {pendingWebsiteTemplate && (
          <div className="admin-website-template-preview">
            <div className="admin-website-template-preview-header">
              <div>
                <strong>发布前差异确认</strong>
                <span>{pendingWebsiteTemplate.file.name}</span>
              </div>
              <span>
                文件哈希 {pendingWebsiteTemplate.preview.fileHash.slice(0, 12)}…
              </span>
            </div>
            <div className="admin-website-template-metrics">
              <div>
                <span>模板记录</span>
                <strong>{pendingWebsiteTemplate.preview.totals.records}</strong>
              </div>
              <div>
                <span>待变更</span>
                <strong>{pendingWebsiteTemplate.preview.totals.changed}</strong>
              </div>
              <div>
                <span>将完成</span>
                <strong>
                  {pendingWebsiteTemplate.preview.totals.completing}
                </strong>
              </div>
              <div>
                <span>总结更新</span>
                <strong>
                  {pendingWebsiteTemplate.preview.totals.summariesUpdated}
                </strong>
              </div>
            </div>
            {pendingWebsiteTemplate.preview.totals.changed > 0 ? (
              <div className="admin-website-template-diff-list">
                {pendingWebsiteTemplate.preview.changes
                  .filter((change) => change.change !== "unchanged")
                  .map((change) => (
                    <article key={change.ticketId}>
                      <header>
                        <div>
                          <strong>{change.categoryLabel}</strong>
                          <span>{change.topic || "未填写话题"}</span>
                        </div>
                        <span className={`is-${change.change}`}>
                          {change.change === "complete"
                            ? "完成工单"
                            : "修正内容总结"}
                        </span>
                      </header>
                      <div>
                        <section>
                          <span>当前内容总结</span>
                          <p>
                            {change.currentPublicSummary ||
                              (change.currentComplete
                                ? "尚未填写"
                                : "待完成后发布")}
                          </p>
                        </section>
                        <section>
                          <span>发布后内容总结</span>
                          <p>{change.incomingPublicSummary}</p>
                        </section>
                      </div>
                      <footer>
                        工单 {change.ticketId} · 当前修订 R{change.revision}
                      </footer>
                    </article>
                  ))}
              </div>
            ) : (
              <p className="admin-website-template-no-change">
                模板与当前工单内容一致，没有需要发布的变更。
              </p>
            )}
            <div className="admin-website-template-confirm">
              <span>
                {pendingWebsiteTemplate.preview.totals.unchanged} 条保持不变；
                发布时会再次校验每条修订号，任一冲突都会整体回滚。
              </span>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={websiteTemplateBusy === "publish"}
                  onClick={() => setPendingWebsiteTemplate(null)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  className="bg-[#5b2a86] hover:bg-[#49216c]"
                  disabled={
                    websiteTemplateBusy === "publish" ||
                    pendingWebsiteTemplate.preview.totals.changed === 0
                  }
                  onClick={() => void publishWebsiteContentTemplate()}
                >
                  {websiteTemplateBusy === "publish" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  确认发布
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>
      {(Object.keys(contentQuota).length > 0 ||
        Object.keys(websiteQuota).length > 0) && (
        <div className="admin-delivery-quota-panel">
          <div className="admin-delivery-quota-heading">
            <div>
              <strong>当前服务周期发布额度</strong>
              <span>
                提交时预留，工单完成后正式消耗；普通所属管理员仅可查看。
              </span>
            </div>
            {quotaAdjustmentAvailable && !quotaEditing && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setQuotaEditing(true)}
              >
                <SlidersHorizontal className="h-4 w-4" />
                调整额度
              </Button>
            )}
          </div>
          <div className="admin-delivery-quota-summary">
            {[
              ["内容资产发布", contentQuota],
              ["官网内容发布", websiteQuota],
            ].map(([label, quota]) => {
              const values = quota as Record<string, any>;
              const reserved = Number(values.reserved ?? 0);
              const consumed = Number(values.consumed ?? 0);
              const used = Number(values.used ?? consumed + reserved);
              const limit = Number(values.limit ?? 0);
              return (
                <div key={String(label)}>
                  <span>{String(label)}</span>
                  <strong>
                    {used} / {limit}
                  </strong>
                  <small>
                    已消耗 {consumed}
                    {reserved > 0 ? ` · 已预留 ${reserved}` : ""}
                  </small>
                </div>
              );
            })}
          </div>
          {quotaAdjustmentAvailable && quotaEditing && (
            <div className="admin-delivery-quota-editor">
              <label>
                <span>内容资产发布上限</span>
                <Input
                  type="number"
                  min={Number(contentQuota.used ?? 0)}
                  step={1}
                  value={contentQuotaLimit}
                  onChange={(event) =>
                    setContentQuotaLimit(Number(event.target.value))
                  }
                />
              </label>
              <label>
                <span>官网内容发布上限</span>
                <Input
                  type="number"
                  min={Number(websiteQuota.used ?? 0)}
                  step={1}
                  value={websiteQuotaLimit}
                  onChange={(event) =>
                    setWebsiteQuotaLimit(Number(event.target.value))
                  }
                />
              </label>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={adjustQuotaMutation.isPending}
                  onClick={() => setQuotaEditing(false)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  className="bg-[#5b2a86] hover:bg-[#49216c]"
                  disabled={adjustQuotaMutation.isPending}
                  onClick={() => void saveQuotaLimits()}
                >
                  {adjustQuotaMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  保存额度
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="admin-ticket-master-detail">
        <aside className="admin-ticket-list-panel">
          <div className="admin-ticket-list-header">
            <div>
              <strong>客户工单</strong>
              <span>
                {listQuery.isLoading && !previewMode
                  ? "读取中…"
                  : listQuery.hasNextPage && !previewMode
                    ? `已加载 ${filteredTickets.length} 张`
                    : `${filteredTickets.length} 张`}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-label="刷新工单"
              disabled={listQuery.isFetching}
              onClick={() => void refresh()}
            >
              <RefreshCw
                className={`h-4 w-4 ${listQuery.isFetching ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
          <div className="admin-ticket-filters">
            <label>
              <Search className="h-4 w-4" />
              <Input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索话题或类别"
              />
            </label>
            <div>
              <select
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
                aria-label="筛选工单类型"
              >
                <option value="all">全部类型</option>
                <option value="content_asset">内容资产</option>
                <option value="website_operation">官网运营</option>
              </select>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                aria-label="筛选工单状态"
              >
                <option value="all">全部状态</option>
                <option value="pending">待受理</option>
                <option value="completed">已完成</option>
              </select>
            </div>
          </div>
          {listQuery.error && !previewMode ? (
            <div className="admin-ticket-list-error">
              <AlertCircle className="h-5 w-5" />
              <strong>工单暂时无法读取</strong>
              <span>{listQuery.error.message || "请刷新后重试。"}</span>
            </div>
          ) : filteredTickets.length ? (
            <div className="admin-ticket-list">
              {filteredTickets.map((ticket) => (
                <button
                  key={ticket.id}
                  type="button"
                  className={
                    ticket.id === selectedTicketId ? "is-selected" : ""
                  }
                  onClick={() => selectTicket(ticket.id)}
                >
                  <div>
                    <span>{ticketTypeLabel(ticket.type)}</span>
                    <StatusPill ticket={ticket} />
                  </div>
                  <strong>{ticketTitle(ticket)}</strong>
                  {ticket.topic && ticket.title !== ticket.topic && (
                    <p>{ticket.topic}</p>
                  )}
                  {ticket.type === "content_asset" && ticket.preferredMedia && (
                    <p>意向媒体：{ticket.preferredMedia}</p>
                  )}
                  <footer>
                    <time>{formatAdminTicketDate(ticket.updatedAt)}</time>
                    <ChevronRight className="h-4 w-4" />
                  </footer>
                </button>
              ))}
              {listQuery.hasNextPage && !previewMode && (
                <Button
                  type="button"
                  variant="outline"
                  className="admin-ticket-load-more"
                  disabled={listQuery.isFetchingNextPage}
                  onClick={() => void listQuery.fetchNextPage()}
                >
                  {listQuery.isFetchingNextPage ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ChevronRight className="h-4 w-4 rotate-90" />
                  )}
                  {listQuery.isFetchingNextPage ? "正在加载…" : "加载更多工单"}
                </Button>
              )}
            </div>
          ) : (
            <EmptyState
              title="没有符合条件的工单"
              description="调整筛选条件，或等待客户提交新的交付需求。"
            />
          )}
        </aside>

        <main className="admin-ticket-detail-panel">
          {!selectedTicket ? (
            <EmptyState
              title="请选择一张工单"
              description="右侧会展示需求、资料、公开交流、内部备注和处理动作。"
            />
          ) : detailQuery.isLoading && !previewMode ? (
            <div className="admin-ticket-loading">
              <Loader2 className="h-5 w-5 animate-spin" />
              正在读取工单详情…
            </div>
          ) : detailQuery.error && !previewMode ? (
            <div className="admin-ticket-detail-error">
              <AlertCircle className="h-5 w-5" />
              <strong>工单详情暂时无法读取</strong>
              <p>{detailQuery.error.message || "请刷新后重试。"}</p>
            </div>
          ) : detail ? (
            <>
              <header className="admin-ticket-detail-header">
                <div>
                  <div className="admin-ticket-detail-meta">
                    <span>{ticketTypeLabel(detail.ticket.type)}</span>
                    <StatusPill ticket={detail.ticket} />
                  </div>
                  <h3>{ticketTitle(detail.ticket)}</h3>
                  {detail.ticket.topic &&
                    detail.ticket.title !== detail.ticket.topic && (
                      <p>{detail.ticket.topic}</p>
                    )}
                </div>
                <div className="admin-ticket-detail-time">
                  <CalendarClock className="h-4 w-4" />
                  更新于 {formatAdminTicketDate(detail.ticket.updatedAt)}
                </div>
              </header>
              {!OPEN_TICKET_STATUSES.has(detail.ticket.status) && (
                <div className="admin-ticket-closed-notice">
                  <LockKeyhole className="h-4 w-4" />
                  <span>
                    该工单已结束，需求、交流、交付记录与附件仅供查看。
                  </span>
                </div>
              )}

              <section className="admin-ticket-request-card">
                <div className="admin-ticket-section-heading">
                  <div>
                    <span>客户需求</span>
                    <h3>需求正文与提交资料</h3>
                  </div>
                  <FileText className="h-5 w-5" />
                </div>
                {detail.ticket.description ? (
                  <p>{detail.ticket.description}</p>
                ) : (
                  <p className="is-empty">客户未填写补充说明。</p>
                )}
                {detail.ticket.type === "content_asset" && (
                  <p>
                    <strong>意向媒体：</strong>
                    {detail.ticket.preferredMedia || "暂不指定"}
                  </p>
                )}
                {detail.ticket.type === "website_operation" &&
                  detail.ticket.category === "icp_filing" &&
                  detail.ticket.icpDeclarations && (
                    <div className="admin-ticket-icp-declarations">
                      <p>
                        <strong>域名实名及持有人信息：</strong>
                        {detail.ticket.icpDeclarations
                          .domainHolderInformation || "未填写"}
                      </p>
                      <p>
                        <strong>网站名称、服务内容和联系方式：</strong>
                        {detail.ticket.icpDeclarations.websiteInformation ||
                          "未填写"}
                      </p>
                      <p>
                        <strong>阿里云 App 真实性 / 人脸核验：</strong>
                        {detail.ticket.icpDeclarations
                          .aliyunAppVerificationCompleted
                          ? "用户已确认完成"
                          : "尚未确认"}
                      </p>
                    </div>
                  )}
                {safeAdminDeliveryUrl(detail.ticket.targetUrl) && (
                  <a
                    href={safeAdminDeliveryUrl(detail.ticket.targetUrl)!}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Link2 className="h-4 w-4" />
                    {detail.ticket.targetUrl}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                {detail.attachments?.length ? (
                  <div className="admin-ticket-request-attachments">
                    {detail.attachments.map((attachment, index) => (
                      <a
                        key={attachment.id || attachment.fileId || index}
                        href={safeAdminDeliveryUrl(attachment.url) || undefined}
                        target={
                          safeAdminDeliveryUrl(attachment.url)
                            ? "_blank"
                            : undefined
                        }
                        rel={
                          safeAdminDeliveryUrl(attachment.url)
                            ? "noopener noreferrer"
                            : undefined
                        }
                      >
                        <Paperclip className="h-4 w-4" />
                        {attachment.filename || "客户资料"}
                      </a>
                    ))}
                  </div>
                ) : null}
              </section>

              <div className="admin-ticket-timelines">
                {detail.ticket.type === "content_asset" && (
                  <Timeline
                    title="客户可见交流"
                    description="此处内容与交付结果会同步给客户。"
                    events={publicEvents}
                  />
                )}
                <Timeline
                  title="管理员内部记录"
                  description="仅管理员可见，绝不返回用户端。"
                  events={internalEvents}
                  internal
                />
              </div>

              <div className="admin-ticket-compose-grid">
                {detail.ticket.type === "content_asset" && (
                  <section className="admin-ticket-compose">
                    <div>
                      <MessageSquare className="h-4 w-4" />
                      <strong>回复客户与回传成果</strong>
                    </div>
                    <Textarea
                      value={publicReply}
                      onChange={(event) => setPublicReply(event.target.value)}
                      placeholder="填写客户可见回复或交付说明"
                    />
                    <input
                      ref={fileInputRef}
                      className="hidden"
                      type="file"
                      multiple
                      onChange={(event) =>
                        setPublicFiles(Array.from(event.target.files || []))
                      }
                    />
                    <div className="admin-ticket-file-row">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <UploadCloud className="h-4 w-4" />
                        选择交付文件
                      </button>
                      <span>
                        {publicFiles.length
                          ? `已选择 ${publicFiles.length} 个文件`
                          : "可上传报告、截图或成果文件"}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      disabled={
                        uploading ||
                        addMessageMutation.isPending ||
                        !OPEN_TICKET_STATUSES.has(detail.ticket.status)
                      }
                      onClick={() => void sendMessage("customer")}
                    >
                      {uploading || addMessageMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      发送客户可见回复
                    </Button>
                  </section>
                )}

                <section className="admin-ticket-compose is-internal">
                  <div>
                    <LockKeyhole className="h-4 w-4" />
                    <strong>内部备注</strong>
                  </div>
                  <Textarea
                    value={internalNote}
                    onChange={(event) => setInternalNote(event.target.value)}
                    placeholder="记录内部判断、协作人或风险边界"
                  />
                  <div className="admin-ticket-notice">
                    <LockKeyhole className="h-4 w-4" />
                    <span>内部备注不会出现在用户看板或客户接口中。</span>
                  </div>
                  <Button
                    variant="outline"
                    disabled={
                      addMessageMutation.isPending ||
                      !OPEN_TICKET_STATUSES.has(detail.ticket.status)
                    }
                    onClick={() => void sendMessage("internal")}
                  >
                    <Save className="h-4 w-4" />
                    保存内部备注
                  </Button>
                </section>
              </div>

              {detail.ticket.type === "content_asset" && (
                <section className="admin-ticket-delivery-card">
                  <div className="admin-ticket-section-heading">
                    <div>
                      <span>结构化交付记录</span>
                      <h3>发布、推送与复检结果</h3>
                      <p>
                        平台提交成功只表示请求已发送，不等同于内容已收录或被 AI
                        引用。
                      </p>
                    </div>
                    <Send className="h-5 w-5" />
                  </div>
                  {detail.deliveryRecords?.length ? (
                    <div className="admin-delivery-record-list">
                      {detail.deliveryRecords.map((record) => (
                        <article key={record.id}>
                          <div>
                            <strong>{record.platform || "平台未记录"}</strong>
                            <span
                              className={`is-${record.resultStatus || "pending_confirmation"}`}
                            >
                              {record.resultStatus === "success"
                                ? "成功"
                                : record.resultStatus === "failed"
                                  ? "失败"
                                  : "待确认"}
                            </span>
                          </div>
                          {safeAdminDeliveryUrl(record.targetUrl) && (
                            <a
                              href={safeAdminDeliveryUrl(record.targetUrl)!}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {record.targetUrl}
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                          <p>
                            {record.platformMessage || "未记录平台返回信息。"}
                          </p>
                          <time>
                            {formatAdminTicketDate(record.executedAt)}
                          </time>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="admin-delivery-record-empty">
                      暂无结构化发布、推送或复检记录。
                    </p>
                  )}
                  <div className="admin-delivery-record-form">
                    <label>
                      <span>操作平台</span>
                      <Input
                        value={deliveryPlatform}
                        onChange={(event) =>
                          setDeliveryPlatform(event.target.value)
                        }
                        placeholder="行业媒体、百度站长平台等"
                      />
                    </label>
                    <label>
                      <span>目标 URL</span>
                      <Input
                        value={deliveryTargetUrl}
                        onChange={(event) =>
                          setDeliveryTargetUrl(event.target.value)
                        }
                        placeholder="https://..."
                      />
                    </label>
                    <label>
                      <span>执行时间</span>
                      <Input
                        type="datetime-local"
                        value={deliveryExecutedAt}
                        onChange={(event) =>
                          setDeliveryExecutedAt(event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>执行结果</span>
                      <select
                        value={deliveryResultStatus}
                        onChange={(event) =>
                          setDeliveryResultStatus(
                            event.target.value as typeof deliveryResultStatus,
                          )
                        }
                      >
                        <option value="pending_confirmation">待确认</option>
                        <option value="success">成功</option>
                        <option value="failed">失败</option>
                      </select>
                    </label>
                    <label className="is-wide">
                      <span>平台返回信息</span>
                      <Textarea
                        value={deliveryPlatformMessage}
                        onChange={(event) =>
                          setDeliveryPlatformMessage(event.target.value)
                        }
                        placeholder="记录平台响应、失败原因或复检结论"
                      />
                    </label>
                    <input
                      ref={deliveryFileInputRef}
                      className="hidden"
                      type="file"
                      multiple
                      onChange={(event) =>
                        setDeliveryFiles(Array.from(event.target.files || []))
                      }
                    />
                    <div className="admin-ticket-file-row is-wide">
                      <button
                        type="button"
                        onClick={() => deliveryFileInputRef.current?.click()}
                      >
                        <UploadCloud className="h-4 w-4" />
                        上传截图或复检材料
                      </button>
                      <span>
                        {deliveryFiles.length
                          ? `已选择 ${deliveryFiles.length} 个文件`
                          : "可选"}
                      </span>
                    </div>
                    <div className="admin-ticket-form-actions is-wide">
                      <Button
                        className="bg-[#5b2a86] hover:bg-[#49216c]"
                        disabled={
                          recordDeliveryMutation.isPending ||
                          uploading ||
                          !OPEN_TICKET_STATUSES.has(detail.ticket.status)
                        }
                        onClick={() => void saveDeliveryRecord()}
                      >
                        {recordDeliveryMutation.isPending || uploading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4" />
                        )}
                        保存交付记录
                      </Button>
                    </div>
                  </div>
                </section>
              )}

              {detail.ticket.category === "knowledge_base_maintenance" && (
                <section className="admin-ticket-delivery-card">
                  <div className="admin-ticket-section-heading">
                    <div>
                      <span>知识库替换版本</span>
                      <h3>上传并发布通过校验的新知识库 ZIP</h3>
                      <p>
                        新版本会直接替换客户当前展示知识库，并与本维护工单绑定；发布成功后才能完成工单。
                      </p>
                    </div>
                    <UploadCloud className="h-5 w-5" />
                  </div>
                  <input
                    ref={maintenanceFileInputRef}
                    className="hidden"
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadKnowledgeMaintenanceArchive(file);
                    }}
                  />
                  <div className="admin-ticket-status-action">
                    <Button
                      className="bg-[#5b2a86] hover:bg-[#49216c]"
                      disabled={
                        maintenanceUploading ||
                        !OPEN_TICKET_STATUSES.has(detail.ticket.status)
                      }
                      onClick={() => maintenanceFileInputRef.current?.click()}
                    >
                      {maintenanceUploading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <UploadCloud className="h-4 w-4" />
                      )}
                      {maintenanceUploading
                        ? "正在校验并发布"
                        : "上传知识库 ZIP"}
                    </Button>
                  </div>
                </section>
              )}

              <section className="admin-ticket-status-card">
                <div className="admin-ticket-section-heading">
                  <div>
                    <span>处理状态</span>
                    <h3>完成工单并发布内容总结</h3>
                    <p>
                      用户列表只显示待受理或已完成；完成摘要会进入用户历史记录。
                    </p>
                  </div>
                  <History className="h-5 w-5" />
                </div>
                <label className="mt-4 block">
                  <span className="text-sm font-semibold text-[#484057]">
                    公开内容总结
                  </span>
                  <Textarea
                    className="mt-2 min-h-28"
                    value={publicSummary}
                    onChange={(event) => setPublicSummary(event.target.value)}
                    placeholder="完成工单时必填，简要说明实际完成的内容与结果"
                  />
                </label>
                <div className="admin-ticket-status-action">
                  <Button
                    className="bg-[#5b2a86] hover:bg-[#49216c]"
                    disabled={
                      updateMutation.isPending ||
                      !publicSummary.trim() ||
                      !OPEN_TICKET_STATUSES.has(detail.ticket.status)
                    }
                    onClick={() => void updateStatus()}
                  >
                    {updateMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    完成工单
                  </Button>
                </div>
              </section>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
