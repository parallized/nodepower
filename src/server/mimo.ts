import type { AiReview, AiReviewer, ReviewArtifact, ReviewJobInput } from "./types.js";

const DEFAULT_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
const DEFAULT_MODEL = "mimo-v2.5";
const MAX_ARTIFACT_CHARS = 9000;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

export function createMimoReviewerFromEnv(): AiReviewer | undefined {
  const apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) {
    return undefined;
  }

  const baseUrl = (process.env.MIMO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = process.env.MIMO_MODEL ?? DEFAULT_MODEL;

  return async (input) => reviewWithMimo(input, { apiKey, baseUrl, model });
}

async function reviewWithMimo(
  input: ReviewJobInput,
  options: { apiKey: string; baseUrl: string; model: string }
): Promise<AiReview> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: [
              "你是 VPS 测评报告分析助手。",
              "根据系统信息、YABS、bench.sh、流媒体解锁和回程路由输出，生成中文总结和评分。",
              "必须只输出 JSON，不要输出 Markdown。",
              "评分范围 0-100，分数越高代表该项越适合普通 VPS 使用。",
              "如果某项数据缺失，给出保守评分并说明依据不足。"
            ].join("\n")
          },
          {
            role: "user",
            content: buildPrompt(input)
          }
        ]
      }),
      signal: controller.signal
    });

    const json = (await response.json()) as ChatCompletionResponse;
    if (!response.ok) {
      throw new Error(json.error?.message ?? `MiMo request failed: HTTP ${response.status}`);
    }

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("MiMo response did not include message content");
    }

    return normalizeReview(parseJsonObject(content), options.model);
  } finally {
    clearTimeout(timeout);
  }
}

function buildPrompt(input: ReviewJobInput): string {
  const artifactText = input.artifacts.map(formatArtifactForPrompt).join("\n\n");
  const payload = {
    job: {
      id: input.id,
      status: input.status,
      hostname: input.hostname,
      runnerIp: input.runnerIp,
      summary: input.summary,
      steps: input.steps,
      recentLog: input.recentLog.slice(-80)
    },
    artifacts: artifactText
  };

  return [
    "请分析下面的 VPS 测评数据。",
    "输出 JSON 格式：",
    "{",
    "  \"summary\": \"不超过 180 字的总体结论\",",
    "  \"scores\": [",
    "    {\"item\":\"CPU\", \"score\":0-100, \"reason\":\"简短原因\"},",
    "    {\"item\":\"内存\", \"score\":0-100, \"reason\":\"简短原因\"},",
    "    {\"item\":\"磁盘\", \"score\":0-100, \"reason\":\"简短原因\"},",
    "    {\"item\":\"网络\", \"score\":0-100, \"reason\":\"简短原因\"},",
    "    {\"item\":\"流媒体\", \"score\":0-100, \"reason\":\"简短原因\"},",
    "    {\"item\":\"回程路由\", \"score\":0-100, \"reason\":\"简短原因\"},",
    "    {\"item\":\"综合\", \"score\":0-100, \"reason\":\"简短原因\"}",
    "  ],",
    "  \"recommendations\": [\"1-4 条购买、建站、代理或避坑建议\"]",
    "}",
    "",
    JSON.stringify(payload, null, 2)
  ].join("\n");
}

function formatArtifactForPrompt(artifact: ReviewArtifact): string {
  const content = artifact.content.length > MAX_ARTIFACT_CHARS
    ? `${artifact.content.slice(0, MAX_ARTIFACT_CHARS)}\n...[truncated ${artifact.content.length - MAX_ARTIFACT_CHARS} chars]`
    : artifact.content;

  return [
    `# ${artifact.step ?? "unknown"} / ${artifact.label} / ${artifact.kind} / ${artifact.bytes} bytes`,
    content
  ].join("\n");
}

function normalizeReview(value: unknown, model: string): AiReview {
  if (!value || typeof value !== "object") {
    throw new Error("MiMo returned invalid JSON");
  }

  const raw = value as {
    summary?: unknown;
    scores?: unknown;
    recommendations?: unknown;
  };

  const scores = Array.isArray(raw.scores)
    ? raw.scores
        .map((item) => {
          if (!item || typeof item !== "object") {
            return undefined;
          }

          const scoreItem = item as { item?: unknown; score?: unknown; reason?: unknown };
          const score = Number(scoreItem.score);
          return {
            item: String(scoreItem.item ?? "未命名"),
            score: clampScore(Number.isFinite(score) ? score : 0),
            reason: String(scoreItem.reason ?? "")
          };
        })
        .filter((item): item is { item: string; score: number; reason: string } => Boolean(item))
    : [];

  const recommendations = Array.isArray(raw.recommendations)
    ? raw.recommendations.map((item) => String(item)).filter(Boolean).slice(0, 6)
    : [];

  return {
    status: "complete",
    summary: String(raw.summary ?? "AI 总结已生成，但未返回摘要文本。"),
    scores,
    recommendations,
    model,
    generatedAt: new Date().toISOString()
  };
}

function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("MiMo response was not JSON");
    }
    return JSON.parse(match[0]);
  }
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}
