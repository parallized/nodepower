# NodePower

一条命令完成 VPS 测评，并在浏览器里实时看报告。

## 怎么使用

打开测评网站，点「新建测评」，复制页面生成的一行命令。然后 SSH 登录 VPS，把命令粘进去执行。终端会显示测评进度，同时页面会给出一个报告链接。打开报告链接，就能实时查看 yabs、bench.sh、流媒体解锁、回程路由等结果。

## 这个项目做什么

NodePower 是一个 VPS 测评控制台。它把「网页创建任务」「SSH 执行检测」「浏览器实时看进度」串成一个流程：

```text
浏览器创建测评
    ↓
复制一行 SSH 命令
    ↓
VPS 运行 agent
    ↓
agent 执行检测并上报
    ↓
浏览器实时刷新报告
```

## 检测内容

- 系统信息：系统版本、内核、CPU、内存、磁盘、网络信息
- YABS 综合跑分：`masonr/yet-another-bench-script`
- bench.sh 基准：`teddysun/across`
- 流媒体解锁：`lmc999/RegionRestrictionCheck`
- 回程路由：电信、联通、移动常用目标，自动使用 `traceroute` / `tracepath` / `ping`

所有第三方脚本输出都会保存为原始 artifact，方便用户查看完整结果。

## 界面能力

- 创建测评任务并生成 link id
- 自动生成可复制的 SSH 命令
- SSH 终端 TUI 显示测评进度
- 浏览器报告页实时刷新
- 展示步骤状态、机器摘要、实时日志、原始输出文件
- 报告链接可直接分享

## 快速开始

```bash
npm install
npm run dev
```

开发模式：

- 前端：`http://localhost:5173`
- API：`http://localhost:8787`
- Vite 会代理 `/api` 和 `/agent.sh`

只启动 API：

```bash
npm run dev:api
```

## 生产部署

先构建：

```bash
npm run build
```

启动：

```bash
PUBLIC_BASE_URL=https://bench.example.com npm start
```

默认监听 `8787`，可以改端口：

```bash
PORT=3000 PUBLIC_BASE_URL=https://bench.example.com npm start
```

`PUBLIC_BASE_URL` 必须是 VPS 能访问到的公网地址。不要在生产环境留成 `localhost`，否则复制到 VPS 上的命令无法回传数据。

## 实际执行的命令

点击「新建测评」后，页面会生成类似命令：

```bash
curl -fsSL https://bench.example.com/agent.sh | bash -s -- https://bench.example.com <JOB_ID> <TOKEN>
```

SSH 登录 VPS 后直接执行即可。

报告地址：

```text
https://bench.example.com/r/<JOB_ID>
```

## Docker

```bash
docker compose up -d --build
```

部署前修改 [docker-compose.yml](./docker-compose.yml)：

```yaml
environment:
  PORT: "8787"
  PUBLIC_BASE_URL: "https://bench.example.com"
  DATA_DIR: "/app/data"
```

## Nginx 反代

SSE 实时进度需要关闭代理缓冲：

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;

  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;

  proxy_buffering off;
}
```

## 数据存储

当前版本使用本地文件存储：

```text
data/<jobId>/
  job.json
  *.txt
  *.json
```

修改数据目录：

```bash
DATA_DIR=/var/lib/nodepower PUBLIC_BASE_URL=https://bench.example.com npm start
```

## API 简表

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/jobs` | 创建测评任务 |
| `GET` | `/api/jobs/:id` | 读取报告状态 |
| `GET` | `/api/jobs/:id/events` | SSE 实时事件 |
| `GET` | `/api/jobs/:id/artifacts/:artifactId` | 读取原始输出 |
| `POST` | `/api/agent/:id/event` | agent 上报事件 |
| `GET` | `/agent.sh` | 下载 VPS agent |

## 项目结构

```text
agent/
  nodepower-agent.sh      VPS 端检测 agent
src/server/
  index.ts                Express API、SSE、静态文件托管
  store.ts                job 状态、artifact、事件广播
src/client/
  src/main.tsx            React 页面
  src/styles.css          页面样式
scripts/
  copy-static.mjs         构建后复制 agent
```

## 注意事项

- 当前报告链接是公开可读的，知道 link id 就能打开。
- 当前版本没有登录、私有报告和自动过期清理。
- 面向公众开放前建议加创建任务限流、报告过期清理、artifact 大小限制。
- 第三方测评脚本来自外部仓库，正式运营建议固定版本或自托管镜像。
- 部分 VPS 没有 `traceroute`，agent 会自动 fallback；都不可用时回程路由会标记为 skipped。

## 可选后续

- YABS / bench.sh 结构化解析
- 报告访问密码
- job 自动过期和清理
- 多用户登录和配额
- Webhook 或 Telegram 通知
- 自托管第三方脚本镜像
