import express from "express";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMimoReviewerFromEnv } from "./mimo.js";
import { JobStore } from "./store.js";
import type { AgentEvent } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = process.env.NODEPOWER_ROOT ?? findRuntimeRoot(__dirname);
const port = Number(process.env.PORT ?? 8787);
const publicBaseUrl = normalizeBaseUrl(
  process.env.PUBLIC_BASE_URL ?? process.env.NODEPOWER_DEV_PUBLIC_BASE_URL ?? `http://localhost:${port}`
);
const dataDir = process.env.DATA_DIR ?? join(rootDir, "data");
const agentPath = join(rootDir, "agent", "nodepower-agent.sh");
const clientDir = join(rootDir, "dist", "client");

const store = new JobStore(dataDir, publicBaseUrl, createMimoReviewerFromEnv());
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "12mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "nodepower", publicBaseUrl });
});

app.post("/api/jobs", (_req, res) => {
  res.status(201).json(store.createJob());
});

app.get("/api/jobs/:id", (req, res) => {
  const job = store.getPublicJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  res.json(job);
});

app.get("/api/jobs/:id/events", (req, res) => {
  if (!store.getPublicJob(req.params.id)) {
    res.status(404).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const unsubscribe = store.subscribe(req.params.id, (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.get("/api/jobs/:id/artifacts/:artifactId", (req, res) => {
  const result = store.getArtifact(req.params.id, req.params.artifactId);
  if (!result) {
    res.status(404).json({ error: "artifact not found" });
    return;
  }

  const contentType = result.artifact.kind === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";
  res.setHeader("Content-Type", contentType);
  res.send(result.content);
});

app.post("/api/agent/:id/event", (req, res) => {
  const token = String(req.header("x-nodepower-token") ?? "");
  const event = req.body as AgentEvent;

  if (!isAgentEvent(event)) {
    res.status(400).json({ error: "invalid event payload" });
    return;
  }

  const job = store.receiveAgentEvent(req.params.id, token, event);
  if (!job) {
    res.status(404).json({ error: "job not found or token mismatch" });
    return;
  }

  res.json({ ok: true, job });

  if (event.type === "done") {
    store.requestAiReview(req.params.id);
  }
});

app.get("/agent.sh", (_req, res) => {
  res.setHeader("Content-Type", "text/x-shellscript; charset=utf-8");
  res.sendFile(agentPath);
});

if (existsSync(clientDir)) {
  app.use(express.static(clientDir, { index: false }));
  app.get(["/", "/new", "/r/:id"], (_req, res) => {
    res.sendFile(join(clientDir, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.type("text/plain").send([
      "NodePower API is running.",
      "",
      "Build the web client with: npm run build",
      "Create a job with: curl -X POST " + publicBaseUrl + "/api/jobs"
    ].join("\n"));
  });
}

const server = createServer(app);
server.listen(port, "0.0.0.0", () => {
  console.log(`NodePower listening on ${publicBaseUrl}`);
});

function normalizeBaseUrl(input: string): string {
  return input.replace(/\/+$/, "");
}

function findRuntimeRoot(startDir: string): string {
  const candidates = [
    join(startDir, "..", "..", ".."),
    join(startDir, ".."),
    process.cwd()
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "agent", "nodepower-agent.sh"))) {
      return candidate;
    }
  }

  return process.cwd();
}

function isAgentEvent(input: unknown): input is AgentEvent {
  if (!input || typeof input !== "object" || !("type" in input)) {
    return false;
  }

  const type = (input as { type: unknown }).type;
  return ["hello", "step", "log", "artifact", "summary", "done"].includes(String(type));
}
