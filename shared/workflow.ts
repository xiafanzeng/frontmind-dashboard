export type WorkflowLayer = "strategy" | "execution";

export type WorkflowStepKind = "agent" | "pause" | "export" | "optional";

export type WorkflowStepStatus =
  | "locked"
  | "ready"
  | "running"
  | "done"
  | "unavailable";

export interface WorkflowStepPublic {
  id: string;
  layer: WorkflowLayer;
  kind: WorkflowStepKind;
  sequence: number;
  title: string;
  buttonLabel: string;
  description: string;
  owner: string;
  inputs: string[];
  outputs: string[];
  dependencies: string[];
  phase: string;
}

export interface WorkflowManifest {
  workflowId: string;
  title: string;
  version: string;
  description: string;
  steps: WorkflowStepPublic[];
  securityRules: string[];
}

export interface WorkflowStepLoadRequest {
  runId?: string;
  operatorNotes?: string;
  fields?: Record<string, string>;
}

export interface WorkflowUploadedFile {
  id: string;
  name: string;
  type: string;
  size: number;
  stepId: string;
  uploadedAt: string;
}

export interface WorkflowUploadResponse {
  runId: string;
  stepId: string;
  file: WorkflowUploadedFile;
}

export interface WorkflowStepLoadResponse {
  runId: string;
  stepId: string;
  status: "loaded" | "missing_private_package";
  loadedAt: string;
  sessionId: string;
  task?: {
    id: string;
    status: string;
    taskUrl?: string;
    title?: string;
  };
  nextStatus: WorkflowStepStatus;
  serverLoad: {
    privatePackageLoaded: boolean;
    workflowRootConfigured: boolean;
    checkedSources: number;
    availableSources: number;
    loadedBytes: number;
    promptVisibleToClient: false;
    returnedPromptContent: false;
  };
  contextUploads: WorkflowUploadedFile[];
  operatorMessages: string[];
  artifactPlaceholders: Array<{
    name: string;
    kind: "json" | "markdown" | "document" | "image" | "site" | "package";
  }>;
  safety: {
    promptStoredServerSide: true;
    frontendReceivesPublicManifestOnly: true;
    rawSkillContentReturned: false;
  };
}
