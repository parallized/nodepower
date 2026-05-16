import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertCircle,
  Check,
  Clipboard,
  Clock,
  ExternalLink,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  Route,
  Server,
  Terminal,
  XCircle
} from "lucide-react";
import "./styles.css";

type JobStatus = "queued" | "running" | "finished" | "failed" | "expired";
type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";

interface StepState {
  id: string;
  label: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  message?: string;
}

interface Artifact {
  id: string;
  label: string;
  kind: "text" | "json";
  bytes: number;
  createdAt: string;
}

interface Job {
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
  recentLog: string[];
  error?: string;
}

interface CreatedJob extends Job {
  token: string;
  installCommand: string;
}

interface ServerEvent {
  type: string;
  at: string;
  job: Job;
  payload?: unknown;
}

const statusText: Record<JobStatus, string> = {
  queued: "等待 VPS 连接",
  running: "测评进行中",
  finished: "报告完成",
  failed: "部分失败",
  expired: "已过期"
};

const stepText: Record<StepStatus, string> = {
  pending: "等待",
  running: "运行中",
  success: "完成",
  failed: "失败",
  skipped: "跳过"
};

function App() {
  const route = useRoute();
  if (route.page === "report") {
    return <ReportPage jobId={route.jobId} />;
  }
  return <NewJobPage />;
}

function useRoute() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const match = path.match(/^\/r\/([^/]+)$/);
  if (match) {
    return { page: "report" as const, jobId: match[1] };
  }
  return { page: "new" as const };
}

function NewJobPage() {
  const [created, setCreated] = useState<CreatedJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createJob() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/jobs", { method: "POST" });
      if (!response.ok) {
        throw new Error(`创建失败: HTTP ${response.status}`);
      }
      const job = (await response.json()) as CreatedJob;
      setCreated(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setLoading(false);
    }
  }

  if (created) {
    return (
      <Shell>
        <section className="new-layout created-layout">
          <div className="panel command-panel">
            <div className="panel-header">
              <div>
                <span className="label">任务已创建</span>
                <h2>{created.id}</h2>
              </div>
              <Activity size={22} />
            </div>
            <CommandBlock command={created.installCommand} reportUrl={created.reportUrl} />
          </div>
          <ReportEmbed jobId={created.id} />
        </section>
      </Shell>
    );
  }

  return (
    <Shell>
      <section className="new-layout">
        <div className="intro">
          <div className="eyebrow">
            <Server size={16} />
            VPS benchmark control plane
          </div>
          <h1>一次指令完成 VPS 测评并实时生成报告</h1>
          <p>
            生成一个 link id，在 SSH 里执行 agent 指令。终端显示 TUI 进度，桌面浏览器同时查看实时报告、步骤状态、日志和原始输出。
          </p>
          <div className="actions">
            <button className="primary" onClick={createJob} disabled={loading}>
              {loading ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              新建测评
            </button>
          </div>
          {error && <InlineError text={error} />}
        </div>

        <div className="panel command-panel">
          <div className="panel-header">
            <div>
              <span className="label">当前任务</span>
              <h2>尚未创建</h2>
            </div>
            <Activity size={22} />
          </div>
          <div className="empty-state">
            <Terminal size={28} />
            <p>点击「新建测评」后，这里会生成可直接复制到 VPS SSH 的命令。</p>
          </div>
        </div>
      </section>
    </Shell>
  );
}

function ReportEmbed({ jobId }: { jobId: string }) {
  const { job, connected, error, reload } = useJob(jobId);

  return (
    <div className="embed-report">
      <div className="report-topbar">
        <div>
          <div className="eyebrow">
            <Route size={16} />
            Report ID {jobId}
          </div>
          <h1>{job ? statusText[job.status] : "等待连接"}</h1>
        </div>
        <button className="secondary" onClick={reload}>
          <RefreshCw size={17} />
          刷新
        </button>
      </div>
      {error && <InlineError text={error} />}
      {job ? (
        <div className="embed-grid">
          <StatusPanel job={job} connected={connected} />
          <StepsPanel job={job} />
          <ArtifactsPanel job={job} />
          <LogsPanel job={job} />
        </div>
      ) : (
        <div className="panel loading-panel">
          <Loader2 className="spin" />
          <span>等待 VPS agent 连接...</span>
        </div>
      )}
    </div>
  );
}

function ReportPage({ jobId }: { jobId: string }) {
  const { job, connected, error, reload } = useJob(jobId);

  return (
    <Shell>
      <div className="report-topbar">
        <div>
          <div className="eyebrow">
            <Route size={16} />
            Report ID {jobId}
          </div>
          <h1>{job ? statusText[job.status] : "读取报告"}</h1>
        </div>
        <button className="secondary" onClick={reload}>
          <RefreshCw size={17} />
          刷新
        </button>
      </div>

      {error && <InlineError text={error} />}

      {job ? (
        <div className="dashboard">
          <aside className="left-rail">
            <StatusPanel job={job} connected={connected} />
            <SummaryPanel job={job} />
            <CommandHint job={job} />
          </aside>
          <main className="main-grid">
            <StepsPanel job={job} />
            <ArtifactsPanel job={job} />
            <LogsPanel job={job} />
          </main>
        </div>
      ) : (
        <div className="panel loading-panel">
          <Loader2 className="spin" />
          <span>正在读取报告...</span>
        </div>
      )}
    </Shell>
  );
}

function useJob(jobId: string) {
  const [job, setJob] = useState<Job | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      const response = await fetch(`/api/jobs/${jobId}`);
      if (!response.ok) {
        throw new Error(`报告不存在或无法读取: HTTP ${response.status}`);
      }
      setJob((await response.json()) as Job);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取失败");
    }
  };

  useEffect(() => {
    reload();
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as ServerEvent;
      setJob(payload.job);
    };

    const events = ["snapshot", "job.created", "agent.hello", "agent.step", "agent.log", "agent.artifact", "agent.summary", "agent.done"];
    for (const eventName of events) {
      source.addEventListener(eventName, (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as ServerEvent;
        setJob(payload.job);
      });
    }

    return () => source.close();
  }, [jobId]);

  return { job, connected, error, reload };
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/">
          <span className="brand-mark">NP</span>
          <span>NodePower</span>
        </a>
        <nav>
          <a href="/new">新建测评</a>
          <a href="/healthz" target="_blank" rel="noreferrer">
            API
          </a>
        </nav>
      </header>
      <div className="content">{children}</div>
    </div>
  );
}

function StatusPanel({ job, connected }: { job: Job; connected: boolean }) {
  const completed = job.steps.filter((step) => ["success", "failed", "skipped"].includes(step.status)).length;
  const total = job.steps.length;
  const percent = Math.round((completed / total) * 100);

  return (
    <section className="panel status-panel">
      <div className="panel-header">
        <div>
          <span className="label">实时状态</span>
          <h2>{statusText[job.status]}</h2>
        </div>
        <StatusIcon status={job.status} />
      </div>
      <div className="progress-track" aria-label={`进度 ${percent}%`}>
        <div style={{ width: `${percent}%` }} />
      </div>
      <div className="metric-grid">
        <Metric label="步骤" value={`${completed}/${total}`} />
        <Metric label="SSE" value={connected ? "在线" : "离线"} tone={connected ? "good" : "warn"} />
        <Metric label="主机" value={job.hostname ?? "-"} />
        <Metric label="IP" value={job.runnerIp ?? valueFromSummary(job.summary, "publicIpv4") ?? "-"} />
      </div>
      {job.error && <InlineError text={job.error} />}
    </section>
  );
}

function SummaryPanel({ job }: { job: Job }) {
  const items = [
    ["系统", valueFromSummary(job.summary, "os")],
    ["内核", valueFromSummary(job.summary, "kernel")],
    ["架构", valueFromSummary(job.summary, "arch")],
    ["CPU", valueFromSummary(job.summary, "cpuModel")],
    ["核心", valueFromSummary(job.summary, "cpuCount")],
    ["内存", valueFromSummary(job.summary, "memory")],
    ["磁盘", valueFromSummary(job.summary, "rootDisk")]
  ];

  return (
    <section className="panel">
      <div className="panel-title">
        <Server size={18} />
        机器摘要
      </div>
      <dl className="summary-list">
        {items.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value ?? "-"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function CommandHint({ job }: { job: Job }) {
  return (
    <section className="panel compact-panel">
      <div className="panel-title">
        <ExternalLink size={18} />
        报告链接
      </div>
      <CopyLine value={job.reportUrl} />
    </section>
  );
}

function StepsPanel({ job }: { job: Job }) {
  return (
    <section className="panel">
      <div className="panel-title">
        <Activity size={18} />
        测评流程
      </div>
      <div className="steps">
        {job.steps.map((step) => (
          <div className={`step step-${step.status}`} key={step.id}>
            <StepIcon status={step.status} />
            <div>
              <div className="step-main">
                <strong>{step.label}</strong>
                <span>{stepText[step.status]}</span>
              </div>
              <p>{step.message ?? "等待 agent 上报"}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ArtifactsPanel({ job }: { job: Job }) {
  return (
    <section className="panel artifacts-panel">
      <div className="panel-title">
        <FileText size={18} />
        原始输出
      </div>
      {job.artifacts.length > 0 ? (
        <div className="artifact-list">
          {job.artifacts.map((artifact) => (
            <a href={`/api/jobs/${job.id}/artifacts/${artifact.id}`} target="_blank" rel="noreferrer" key={artifact.id}>
              <span>
                <strong>{artifact.label}</strong>
                <small>{formatBytes(artifact.bytes)} · {artifact.kind}</small>
              </span>
              <ExternalLink size={16} />
            </a>
          ))}
        </div>
      ) : (
        <div className="empty-state small">
          <FileText size={22} />
          <p>检测开始后会逐步出现 YABS、bench.sh、媒体解锁和回程路由输出。</p>
        </div>
      )}
    </section>
  );
}

function LogsPanel({ job }: { job: Job }) {
  const logs = useMemo(() => job.recentLog.slice(-120), [job.recentLog]);
  return (
    <section className="panel logs-panel">
      <div className="panel-title">
        <Terminal size={18} />
        实时日志
      </div>
      <pre aria-live="polite">{logs.length > 0 ? logs.join("\n") : "等待 agent 连接..."}</pre>
    </section>
  );
}

function CommandBlock({ command, reportUrl }: { command: string; reportUrl: string }) {
  return (
    <div className="command-stack">
      <div>
        <span className="label">SSH 中执行</span>
        <CopyCode value={command} />
      </div>
      <div>
        <span className="label">实时报告</span>
        <CopyLine value={reportUrl} />
      </div>
    </div>
  );
}

function CopyCode({ value }: { value: string }) {
  return (
    <div className="copy-code">
      <code>{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

function CopyLine({ value }: { value: string }) {
  return (
    <div className="copy-line">
      <a href={value} target="_blank" rel="noreferrer">{value}</a>
      <CopyButton value={value} />
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setDone(true);
    window.setTimeout(() => setDone(false), 1600);
  }

  return (
    <button className="icon-button" onClick={copy} aria-label="复制">
      {done ? <Check size={17} /> : <Clipboard size={17} />}
    </button>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" }) {
  return (
    <div className={`metric ${tone ? `metric-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InlineError({ text }: { text: string }) {
  return (
    <div className="inline-error">
      <AlertCircle size={17} />
      <span>{text}</span>
    </div>
  );
}

function StatusIcon({ status }: { status: JobStatus }) {
  if (status === "finished") return <Check className="good" size={24} />;
  if (status === "failed") return <XCircle className="bad" size={24} />;
  if (status === "running") return <Loader2 className="spin active" size={24} />;
  return <Clock className="muted-icon" size={24} />;
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "success") return <Check size={18} />;
  if (status === "failed") return <XCircle size={18} />;
  if (status === "running") return <Loader2 className="spin" size={18} />;
  if (status === "skipped") return <AlertCircle size={18} />;
  return <Clock size={18} />;
}

function valueFromSummary(summary: Record<string, unknown>, key: string) {
  const value = summary[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

createRoot(document.getElementById("root")!).render(<App />);
