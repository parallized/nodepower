export type JobStatus = "queued" | "running" | "finished" | "failed" | "expired";

export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";

export type StepId =
  | "bootstrap"
  | "system"
  | "yabs"
  | "bench"
  | "media"
  | "route"
  | "summary";

export interface StepState {
  id: StepId;
  label: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  message?: string;
}

export interface Artifact {
  id: string;
  step?: StepId;
  label: string;
  kind: "text" | "json";
  bytes: number;
  createdAt: string;
}

export interface AiScore {
  item: string;
  score: number;
  reason: string;
}

export interface AiReview {
  status: "pending" | "complete" | "failed" | "skipped";
  summary?: string;
  scores?: AiScore[];
  recommendations?: string[];
  model?: string;
  generatedAt?: string;
  error?: string;
}

export interface Job {
  id: string;
  token: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  hostname?: string;
  runnerIp?: string;
  publicBaseUrl: string;
  installCommand: string;
  reportUrl: string;
  steps: StepState[];
  artifacts: Artifact[];
  summary: Record<string, unknown>;
  aiReview?: AiReview;
  recentLog: string[];
  error?: string;
}

export interface PublicJob {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  hostname?: string;
  runnerIp?: string;
  reportUrl: string;
  steps: StepState[];
  artifacts: Artifact[];
  summary: Record<string, unknown>;
  aiReview?: AiReview;
  recentLog: string[];
  error?: string;
}

export interface ReviewArtifact {
  step?: StepId;
  label: string;
  kind: "text" | "json";
  bytes: number;
  content: string;
}

export interface ReviewJobInput {
  id: string;
  status: JobStatus;
  hostname?: string;
  runnerIp?: string;
  steps: StepState[];
  summary: Record<string, unknown>;
  artifacts: ReviewArtifact[];
  recentLog: string[];
}

export type AiReviewer = (input: ReviewJobInput) => Promise<AiReview>;

export type AgentEvent =
  | {
      type: "hello";
      hostname?: string;
      runnerIp?: string;
      agentVersion?: string;
    }
  | {
      type: "step";
      step: StepId;
      status: StepStatus;
      message?: string;
      exitCode?: number;
    }
  | {
      type: "log";
      step?: StepId;
      line: string;
    }
  | {
      type: "artifact";
      step: StepId;
      label: string;
      kind?: "text" | "json";
      content: string;
    }
  | {
      type: "summary";
      data: Record<string, unknown>;
    }
  | {
      type: "done";
      status?: "finished" | "failed";
      error?: string;
    };

export interface ServerEvent {
  type: string;
  at: string;
  job: PublicJob;
  payload?: unknown;
}
