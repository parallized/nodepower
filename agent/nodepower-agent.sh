#!/usr/bin/env bash
set -Eeuo pipefail

AGENT_VERSION="0.1.0"
BASE_URL="${1:-${NODEPOWER_BASE_URL:-}}"
JOB_ID="${2:-${NODEPOWER_JOB_ID:-}}"
TOKEN="${3:-${NODEPOWER_TOKEN:-}}"

if [ -z "$BASE_URL" ] || [ -z "$JOB_ID" ] || [ -z "$TOKEN" ]; then
  printf 'Usage: curl -fsSL https://panel.example.com/agent.sh | bash -s -- https://panel.example.com JOB_ID TOKEN\n' >&2
  exit 2
fi

BASE_URL="${BASE_URL%/}"
WORKDIR="${NODEPOWER_WORKDIR:-/tmp/nodepower-$JOB_ID}"
ARTIFACT_DIR="$WORKDIR/artifacts"
TUI_LOG="$WORKDIR/tui.log"
mkdir -p "$ARTIFACT_DIR"
: > "$TUI_LOG"

if [ -t 1 ]; then
  COLOR_RESET="$(printf '\033[0m')"
  COLOR_DIM="$(printf '\033[2m')"
  COLOR_GREEN="$(printf '\033[32m')"
  COLOR_RED="$(printf '\033[31m')"
  COLOR_BLUE="$(printf '\033[34m')"
  COLOR_YELLOW="$(printf '\033[33m')"
  CLEAR_SCREEN="$(printf '\033[2J\033[H')"
else
  COLOR_RESET=""
  COLOR_DIM=""
  COLOR_GREEN=""
  COLOR_RED=""
  COLOR_BLUE=""
  COLOR_YELLOW=""
  CLEAR_SCREEN=""
fi

STEP_IDS=(bootstrap system yabs bench media route summary)
STEP_LABELS=("初始化环境" "系统信息" "YABS 综合跑分" "bench.sh 基准" "流媒体解锁" "回程路由" "报告汇总")
STEP_STATUS=(pending pending pending pending pending pending pending)
STEP_MESSAGE=("" "" "" "" "" "" "")

cleanup_done=0

json_escape() {
  local input="${1-}"
  input="${input//$'\033'/}"
  input="${input//$'\b'/}"
  input="${input//$'\f'/}"
  input="${input//$'\v'/}"
  input="${input//\\/\\\\}"
  input="${input//\"/\\\"}"
  input="${input//$'\n'/\\n}"
  input="${input//$'\r'/\\r}"
  input="${input//$'\t'/\\t}"
  printf '%s' "$input"
}

clean_text() {
  local input="${1-}"
  input="${input//$'\r'/}"
  input="${input//$'\033'/}"
  input="${input//$'\b'/}"
  input="${input//$'\f'/}"
  input="${input//$'\v'/}"
  printf '%s' "$input"
}

post_json() {
  local payload="$1"
  local response
  response="$(curl -fsS --connect-timeout 10 --max-time 60 \
    -H "content-type: application/json" \
    -H "x-nodepower-token: $TOKEN" \
    --data "$payload" \
    "$BASE_URL/api/agent/$JOB_ID/event" 2>&1)" || {
      printf 'nodepower upload failed: %s\n' "$response" >> "$TUI_LOG"
      return 1
    }
}

event_hello() {
  local hostname runner_ip
  hostname="$(hostname 2>/dev/null || true)"
  runner_ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)"
  post_json "{\"type\":\"hello\",\"hostname\":\"$(json_escape "$hostname")\",\"runnerIp\":\"$(json_escape "$runner_ip")\",\"agentVersion\":\"$AGENT_VERSION\"}" || true
}

event_step() {
  local step="$1"
  local status="$2"
  local message="${3:-}"
  local exit_code="${4:-}"
  local extra=""
  if [ -n "$exit_code" ]; then
    extra=",\"exitCode\":$exit_code"
  fi
  post_json "{\"type\":\"step\",\"step\":\"$step\",\"status\":\"$status\",\"message\":\"$(json_escape "$message")\"$extra}" || true
}

event_log() {
  local step="$1"
  local line="$2"
  post_json "{\"type\":\"log\",\"step\":\"$step\",\"line\":\"$(json_escape "$line")\"}" || true
}

event_artifact() {
  local step="$1"
  local label="$2"
  local kind="${3:-text}"
  local file="$4"
  if [ ! -s "$file" ]; then
    return 0
  fi
  local content
  content="$(clean_text "$(cat "$file")")"
  post_json "{\"type\":\"artifact\",\"step\":\"$step\",\"label\":\"$(json_escape "$label")\",\"kind\":\"$kind\",\"content\":\"$(json_escape "$content")\"}" || true
}

event_summary() {
  local file="$1"
  if [ ! -s "$file" ]; then
    return 0
  fi
  local content
  content="$(cat "$file")"
  post_json "{\"type\":\"summary\",\"data\":$content}" || true
}

event_done() {
  local status="$1"
  local error="${2:-}"
  post_json "{\"type\":\"done\",\"status\":\"$status\",\"error\":\"$(json_escape "$error")\"}" || true
}

set_step_local() {
  local step="$1"
  local status="$2"
  local message="${3:-}"
  local i
  for i in "${!STEP_IDS[@]}"; do
    if [ "${STEP_IDS[$i]}" = "$step" ]; then
      STEP_STATUS[$i]="$status"
      STEP_MESSAGE[$i]="$message"
      break
    fi
  done
  draw_tui
}

status_mark() {
  case "$1" in
    running) printf '%b' "${COLOR_BLUE}RUN ${COLOR_RESET}" ;;
    success) printf '%b' "${COLOR_GREEN}OK  ${COLOR_RESET}" ;;
    failed) printf '%b' "${COLOR_RED}FAIL${COLOR_RESET}" ;;
    skipped) printf '%b' "${COLOR_YELLOW}SKIP${COLOR_RESET}" ;;
    *) printf '%b' "${COLOR_DIM}WAIT${COLOR_RESET}" ;;
  esac
}

draw_tui() {
  if [ ! -t 1 ]; then
    return 0
  fi
  printf '%b' "$CLEAR_SCREEN"
  printf 'NodePower VPS 测评\n'
  printf '%b\n' "${COLOR_DIM}Job: $JOB_ID  Report: $BASE_URL/r/$JOB_ID${COLOR_RESET}"
  printf '\n'
  local i
  for i in "${!STEP_IDS[@]}"; do
    printf '  [%s] %s' "$(status_mark "${STEP_STATUS[$i]}")" "${STEP_LABELS[$i]}"
    if [ -n "${STEP_MESSAGE[$i]}" ]; then
      printf '  %b%s%b' "$COLOR_DIM" "${STEP_MESSAGE[$i]}" "$COLOR_RESET"
    fi
    printf '\n'
  done
  printf '\n%b\n' "${COLOR_DIM}最近日志:${COLOR_RESET}"
  tail -n 8 "$TUI_LOG" 2>/dev/null || true
  printf '\n浏览器实时报告: %s/r/%s\n' "$BASE_URL" "$JOB_ID"
}

log_line() {
  local step="$1"
  local line
  line="$(clean_text "$2")"
  printf '[%s] %s\n' "$step" "$line" >> "$TUI_LOG"
  event_log "$step" "$line"
  draw_tui
}

start_step() {
  local step="$1"
  local message="${2:-}"
  set_step_local "$step" running "$message"
  event_step "$step" running "$message"
}

finish_step() {
  local step="$1"
  local status="$2"
  local message="${3:-}"
  local code="${4:-}"
  set_step_local "$step" "$status" "$message"
  event_step "$step" "$status" "$message" "$code"
}

have_command() {
  command -v "$1" >/dev/null 2>&1
}

download() {
  local url="$1"
  local output="$2"
  if have_command curl; then
    curl -fsSL --connect-timeout 15 --max-time 120 "$url" -o "$output"
  elif have_command wget; then
    wget -qO "$output" "$url"
  else
    return 127
  fi
}

run_and_capture() {
  local step="$1"
  local label="$2"
  local output="$3"
  shift 3
  : > "$output"
  log_line "$step" "running $label"
  set +e
  "$@" > >(tee -a "$output" | while IFS= read -r line; do log_line "$step" "$line"; done) \
      2> >(tee -a "$output" | while IFS= read -r line; do log_line "$step" "$line"; done)
  local code=$?
  set -e
  return "$code"
}

collect_system() {
  local output="$ARTIFACT_DIR/system.txt"
  start_step system "读取系统和网络信息"
  {
    printf 'Hostname: %s\n' "$(hostname 2>/dev/null || true)"
    printf 'Kernel: %s\n' "$(uname -a 2>/dev/null || true)"
    printf 'Uptime: %s\n' "$(uptime 2>/dev/null || true)"
    printf 'CPU:\n'
    (lscpu 2>/dev/null || cat /proc/cpuinfo 2>/dev/null | head -n 40 || true)
    printf '\nMemory:\n'
    (free -h 2>/dev/null || true)
    printf '\nDisk:\n'
    (df -hT 2>/dev/null || true)
    printf '\nIP:\n'
    (ip addr 2>/dev/null || ifconfig 2>/dev/null || true)
  } > "$output"
  event_artifact system "system-info" text "$output"
  finish_step system success "系统信息已上传" 0
}

run_yabs() {
  local output="$ARTIFACT_DIR/yabs.txt"
  local script="$WORKDIR/yabs.sh"
  start_step yabs "下载并执行 yabs.sh"
  if ! download "https://raw.githubusercontent.com/masonr/yet-another-bench-script/master/yabs.sh" "$script"; then
    finish_step yabs failed "无法下载 YABS" 1
    return 1
  fi
  chmod +x "$script"
  if run_and_capture yabs "YABS" "$output" bash "$script" -fi; then
    event_artifact yabs "yabs-output" text "$output"
    finish_step yabs success "YABS 完成" 0
  else
    local code=$?
    event_artifact yabs "yabs-output" text "$output"
    finish_step yabs failed "YABS 失败" "$code"
    return "$code"
  fi
}

run_bench() {
  local output="$ARTIFACT_DIR/bench-sh.txt"
  local script="$WORKDIR/bench.sh"
  start_step bench "下载并执行 bench.sh"
  if ! download "https://raw.githubusercontent.com/teddysun/across/master/bench.sh" "$script"; then
    finish_step bench failed "无法下载 bench.sh" 1
    return 1
  fi
  chmod +x "$script"
  if run_and_capture bench "bench.sh" "$output" bash "$script"; then
    event_artifact bench "bench-sh-output" text "$output"
    finish_step bench success "bench.sh 完成" 0
  else
    local code=$?
    event_artifact bench "bench-sh-output" text "$output"
    finish_step bench failed "bench.sh 失败" "$code"
    return "$code"
  fi
}

run_media_unlock() {
  local output="$ARTIFACT_DIR/media-unlock.txt"
  local script="$WORKDIR/media-check.sh"
  start_step media "下载并执行流媒体解锁检测"
  if ! download "https://raw.githubusercontent.com/lmc999/RegionRestrictionCheck/main/check.sh" "$script"; then
    finish_step media failed "无法下载媒体解锁脚本" 1
    return 1
  fi
  chmod +x "$script"
  if run_and_capture media "RegionRestrictionCheck" "$output" bash "$script"; then
    event_artifact media "media-unlock-output" text "$output"
    finish_step media success "流媒体检测完成" 0
  else
    local code=$?
    event_artifact media "media-unlock-output" text "$output"
    finish_step media failed "流媒体检测失败" "$code"
    return "$code"
  fi
}

run_route_trace() {
  local output="$ARTIFACT_DIR/route-trace.txt"
  start_step route "检测到中国常用网络的回程路由"
  : > "$output"

  if have_command curl; then
    {
      printf '== ipinfo ==\n'
      curl -fsS --max-time 15 https://ipinfo.io/json || true
      printf '\n\n'
    } >> "$output"
  fi

  local targets=(
    "219.141.136.12 ChinaTelecom-Beijing"
    "202.106.50.1 ChinaUnicom-Beijing"
    "221.179.155.161 ChinaMobile-Beijing"
    "202.96.209.133 ChinaTelecom-Shanghai"
    "210.22.97.1 ChinaUnicom-Shanghai"
    "211.136.112.200 ChinaMobile-Shanghai"
    "58.60.188.222 ChinaTelecom-Shenzhen"
    "210.21.4.130 ChinaUnicom-Guangzhou"
    "120.196.165.24 ChinaMobile-Guangzhou"
  )

  local tracer=""
  if have_command traceroute; then
    tracer="traceroute -n -w 2 -q 1"
  elif have_command tracepath; then
    tracer="tracepath -n"
  elif have_command ping; then
    tracer="ping -c 4"
  fi

  if [ -z "$tracer" ]; then
    printf 'No traceroute, tracepath, or ping command found.\n' >> "$output"
    event_artifact route "route-trace-output" text "$output"
    finish_step route skipped "系统缺少 traceroute/tracepath/ping" 0
    return 0
  fi

  local target ip label
  for target in "${targets[@]}"; do
    ip="${target%% *}"
    label="${target#* }"
    printf '\n== %s %s ==\n' "$label" "$ip" >> "$output"
    log_line route "tracing $label $ip"
    set +e
    if have_command timeout; then
      timeout 90 bash -c "$tracer $ip" >> "$output" 2>&1
    else
      bash -c "$tracer $ip" >> "$output" 2>&1
    fi
    set -e
  done

  event_artifact route "route-trace-output" text "$output"
  finish_step route success "回程路由检测完成" 0
}

build_summary() {
  local output="$ARTIFACT_DIR/summary.json"
  start_step summary "生成摘要"
  local os_name kernel arch cpu_model cpu_count mem_total disk_root ipv4
  os_name="$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-unknown}" || uname -s)"
  kernel="$(uname -r 2>/dev/null || true)"
  arch="$(uname -m 2>/dev/null || true)"
  cpu_model="$(awk -F: '/model name/ {gsub(/^ /, "", $2); print $2; exit}' /proc/cpuinfo 2>/dev/null || true)"
  cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || true)"
  mem_total="$(free -h 2>/dev/null | awk '/Mem:/ {print $2}' || true)"
  disk_root="$(df -h / 2>/dev/null | awk 'NR==2 {print $2 " total, " $4 " free"}' || true)"
  ipv4="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  cat > "$output" <<JSON
{
  "os": "$(json_escape "$os_name")",
  "kernel": "$(json_escape "$kernel")",
  "arch": "$(json_escape "$arch")",
  "cpuModel": "$(json_escape "$cpu_model")",
  "cpuCount": "$(json_escape "$cpu_count")",
  "memory": "$(json_escape "$mem_total")",
  "rootDisk": "$(json_escape "$disk_root")",
  "publicIpv4": "$(json_escape "$ipv4")",
  "agentVersion": "$AGENT_VERSION"
}
JSON
  event_summary "$output"
  event_artifact summary "summary-json" json "$output"
  finish_step summary success "摘要已生成" 0
}

install_prerequisites_hint() {
  start_step bootstrap "检查依赖"
  local missing=()
  have_command curl || missing+=("curl")
  have_command bash || missing+=("bash")
  have_command tee || missing+=("tee")
  if [ "${#missing[@]}" -gt 0 ]; then
    finish_step bootstrap failed "缺少依赖: ${missing[*]}" 1
    return 1
  fi
  finish_step bootstrap success "基础依赖正常" 0
}

main() {
  draw_tui
  event_hello
  install_prerequisites_hint
  collect_system

  run_yabs || true
  run_bench || true
  run_media_unlock || true
  run_route_trace || true
  build_summary || true

  local failed=0
  local status
  for status in "${STEP_STATUS[@]}"; do
    if [ "$status" = "failed" ]; then
      failed=1
    fi
  done

  cleanup_done=1
  if [ "$failed" -eq 1 ]; then
    event_done failed "一个或多个检测步骤失败，已保留可用输出"
  else
    event_done finished ""
  fi
  draw_tui
}

on_error() {
  local code=$?
  if [ "$cleanup_done" -eq 0 ]; then
    event_done failed "agent exited unexpectedly with code $code"
  fi
  exit "$code"
}

trap on_error ERR
main
