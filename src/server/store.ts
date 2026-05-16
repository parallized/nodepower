import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type {
  AiReview,
  AiReviewer,
  AgentEvent,
  Artifact,
  Job,
  PublicJob,
  ReviewArtifact,
  ReviewJobInput,
  ServerEvent,
  StepId,
  StepStatus
} from "./types.js";

const STEP_LABELS: Record<StepId, string> = {
  bootstrap: "初始化环境",
  system: "系统信息",
  yabs: "YABS 综合跑分",
  bench: "bench.sh 基准",
  media: "流媒体解锁",
  route: "回程路由",
  summary: "报告汇总"
};

const STEP_ORDER = Object.keys(STEP_LABELS) as StepId[];

export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly clients = new Map<string, Set<(event: ServerEvent) => void>>();

  constructor(
    private readonly dataDir: string,
    private readonly publicBaseUrl: string,
    private readonly aiReviewer?: AiReviewer
  ) {
    mkdirSync(this.dataDir, { recursive: true });
    this.loadJobs();
  }

  createJob(): PublicJob & { token: string; installCommand: string } {
    const id = nanoid(10).replaceAll("_", "x").replaceAll("-", "z");
    const token = nanoid(32);
    const reportUrl = `${this.publicBaseUrl}/r/${id}`;
    const installCommand = `curl -fsSL ${this.publicBaseUrl}/agent.sh | bash -s -- ${this.publicBaseUrl} ${id} ${token}`;
    const now = new Date().toISOString();
    const job: Job = {
      id,
      token,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      publicBaseUrl: this.publicBaseUrl,
      installCommand,
      reportUrl,
      steps: STEP_ORDER.map((step) => ({
        id: step,
        label: STEP_LABELS[step],
        status: "pending"
      })),
      artifacts: [],
      summary: {},
      recentLog: []
    };

    this.jobs.set(id, job);
    this.persist(job);
    this.emit(id, "job.created", { id });

    return { ...this.toPublicJob(job), token, installCommand };
  }

  getPublicJob(id: string): PublicJob | undefined {
    const job = this.jobs.get(id);
    return job ? this.toPublicJob(job) : undefined;
  }

  getArtifact(jobId: string, artifactId: string): { artifact: Artifact; content: string } | undefined {
    const job = this.jobs.get(jobId);
    const artifact = job?.artifacts.find((item) => item.id === artifactId);
    if (!job || !artifact) {
      return undefined;
    }

    const path = join(this.jobDir(job.id), `${artifact.id}.${artifact.kind === "json" ? "json" : "txt"}`);
    if (!existsSync(path)) {
      return undefined;
    }

    return { artifact, content: readFileSync(path, "utf8") };
  }

  subscribe(jobId: string, send: (event: ServerEvent) => void): () => void {
    if (!this.clients.has(jobId)) {
      this.clients.set(jobId, new Set());
    }

    const list = this.clients.get(jobId);
    list?.add(send);

    const job = this.jobs.get(jobId);
    if (job) {
      send({
        type: "snapshot",
        at: new Date().toISOString(),
        job: this.toPublicJob(job)
      });
    }

    return () => {
      list?.delete(send);
      if (list?.size === 0) {
        this.clients.delete(jobId);
      }
    };
  }

  receiveAgentEvent(jobId: string, token: string, event: AgentEvent): PublicJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job || job.token !== token) {
      return undefined;
    }

    const now = new Date().toISOString();
    job.updatedAt = now;

    switch (event.type) {
      case "hello":
        job.status = "running";
        job.startedAt ??= now;
        job.hostname = event.hostname;
        job.runnerIp = event.runnerIp;
        this.appendLog(job, `agent connected${event.hostname ? ` from ${event.hostname}` : ""}`);
        break;
      case "step":
        this.updateStep(job, event.step, event.status, {
          message: event.message,
          exitCode: event.exitCode
        });
        if (event.status === "running") {
          job.status = "running";
          job.startedAt ??= now;
        }
        if (event.status === "failed") {
          job.error = event.message;
        }
        break;
      case "log":
        this.appendLog(job, event.step ? `[${event.step}] ${event.line}` : event.line);
        break;
      case "artifact":
        this.writeArtifact(job, event);
        break;
      case "summary":
        job.summary = { ...job.summary, ...event.data };
        break;
      case "done":
        job.status = event.status === "failed" ? "failed" : "finished";
        job.finishedAt = now;
        job.error = event.error || undefined;
        this.updateStep(job, "summary", job.status === "finished" ? "success" : "failed", {
          message: event.error || "报告已完成"
        });
        break;
    }

    this.persist(job);
    this.emit(jobId, `agent.${event.type}`, event);
    return this.toPublicJob(job);
  }

  private updateStep(
    job: Job,
    stepId: StepId,
    status: StepStatus,
    extra: { message?: string; exitCode?: number } = {}
  ): void {
    const now = new Date().toISOString();
    const step = job.steps.find((item) => item.id === stepId);
    if (!step) {
      return;
    }

    if (status === "running" && step.status !== "running") {
      step.startedAt = now;
    }
    if (["success", "failed", "skipped"].includes(status)) {
      step.finishedAt = now;
    }
    step.status = status;
    step.message = extra.message ?? step.message;
    step.exitCode = extra.exitCode ?? step.exitCode;
  }

  private writeArtifact(
    job: Job,
    event: Extract<AgentEvent, { type: "artifact" }>
  ): void {
    const kind = event.kind ?? "text";
    const safeLabel = event.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const id = `${event.step}-${safeLabel || "artifact"}-${nanoid(6)}`;
    const artifact: Artifact = {
      id,
      step: event.step,
      label: event.label,
      kind,
      bytes: Buffer.byteLength(event.content),
      createdAt: new Date().toISOString()
    };

    mkdirSync(this.jobDir(job.id), { recursive: true });
    writeFileSync(join(this.jobDir(job.id), `${id}.${kind === "json" ? "json" : "txt"}`), event.content);
    job.artifacts.push(artifact);
    this.appendLog(job, `[${event.step}] artifact uploaded: ${event.label}`);
  }

  private appendLog(job: Job, line: string): void {
    job.recentLog.push(this.sanitizeLogLine(line));
    if (job.recentLog.length > 250) {
      job.recentLog.splice(0, job.recentLog.length - 250);
    }
  }

  private sanitizeLogLine(line: string): string {
    return line
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .slice(0, 2000);
  }

  private emit(jobId: string, type: string, payload?: unknown): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    const event: ServerEvent = {
      type,
      at: new Date().toISOString(),
      job: this.toPublicJob(job),
      payload
    };

    this.clients.get(jobId)?.forEach((send) => send(event));
  }

  private toPublicJob(job: Job): PublicJob {
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      hostname: job.hostname,
      runnerIp: job.runnerIp,
      reportUrl: job.reportUrl,
      steps: job.steps,
      artifacts: job.artifacts,
      summary: job.summary,
      aiReview: job.aiReview,
      recentLog: job.recentLog,
      error: job.error
    };
  }

  requestAiReview(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    if (!this.aiReviewer) {
      job.aiReview = {
        status: "skipped",
        error: "MIMO_API_KEY is not configured"
      };
      this.persist(job);
      this.emit(jobId, "ai.skipped", { reason: "MIMO_API_KEY is not configured" });
      return;
    }

    if (job.aiReview?.status === "pending" || job.aiReview?.status === "complete") {
      return;
    }

    job.aiReview = { status: "pending" };
    this.appendLog(job, "[ai] MiMo review started");
    this.persist(job);
    this.emit(jobId, "ai.pending");

    void this.runAiReview(jobId);
  }

  private async runAiReview(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || !this.aiReviewer) {
      return;
    }

    try {
      const review = await this.aiReviewer(this.buildReviewInput(job));
      this.setAiReview(jobId, review);
    } catch (error) {
      this.setAiReview(jobId, {
        status: "failed",
        error: error instanceof Error ? error.message : "MiMo review failed",
        generatedAt: new Date().toISOString()
      });
    }
  }

  private setAiReview(jobId: string, review: AiReview): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    job.updatedAt = new Date().toISOString();
    job.aiReview = review;
    if (review.status === "complete") {
      this.appendLog(job, "[ai] MiMo review completed");
    }
    if (review.status === "failed") {
      this.appendLog(job, `[ai] MiMo review failed: ${review.error ?? "unknown error"}`);
    }
    this.persist(job);
    this.emit(jobId, `ai.${review.status}`, review);
  }

  private buildReviewInput(job: Job): ReviewJobInput {
    return {
      id: job.id,
      status: job.status,
      hostname: job.hostname,
      runnerIp: job.runnerIp,
      steps: job.steps,
      summary: job.summary,
      artifacts: this.readReviewArtifacts(job),
      recentLog: job.recentLog
    };
  }

  private readReviewArtifacts(job: Job): ReviewArtifact[] {
    return job.artifacts.flatMap((artifact) => {
      const path = join(this.jobDir(job.id), `${artifact.id}.${artifact.kind === "json" ? "json" : "txt"}`);
      if (!existsSync(path)) {
        return [];
      }

      return [{
        step: artifact.step,
        label: artifact.label,
        kind: artifact.kind,
        bytes: artifact.bytes,
        content: readFileSync(path, "utf8")
      }];
    });
  }

  private persist(job: Job): void {
    mkdirSync(this.jobDir(job.id), { recursive: true });
    writeFileSync(join(this.jobDir(job.id), "job.json"), JSON.stringify(job, null, 2));
  }

  private loadJobs(): void {
    if (!existsSync(this.dataDir)) {
      return;
    }

    for (const entry of readdirSync(this.dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const path = join(this.dataDir, entry.name, "job.json");
      if (!existsSync(path)) {
        continue;
      }

      try {
        const job = JSON.parse(readFileSync(path, "utf8")) as Job;
        this.jobs.set(job.id, job);
      } catch {
        // Ignore corrupt job files; artifacts remain on disk for manual inspection.
      }
    }
  }

  private jobDir(id: string): string {
    return join(this.dataDir, id);
  }
}
