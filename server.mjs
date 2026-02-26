import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { shouldSend, getState, setState } from "./notifier.mjs";
import { openDb, insertAgentMetrics, insertP0Event, insertCronJobMetric, queryAgentMetrics, queryCronJobMetrics, queryP0Events } from "./db.mjs";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT ?? 3412);
const ACTIVE_MINUTES = Number(process.env.ACTIVE_MINUTES ?? 60 * 24); // 24h

const db = openDb();

const app = express();

app.disable("x-powered-by");

// React UI (built)
const CLIENT_DIST = path.join(process.cwd(), "client", "dist");

// Serve built assets
app.use(express.static(CLIENT_DIST));

// Fallback to SPA index.html for non-API routes
app.get(/^\/(?!api\/|ops\/|detail\/).*/, (_req, res) => {
  res.sendFile(path.join(CLIENT_DIST, "index.html"));
});

async function runOpenClaw(args) {
  // Uses local OpenClaw CLI which already knows how to find ~/.openclaw/openclaw.json
  // Keep output bounded.
  const { stdout, stderr } = await execFileAsync("openclaw", args, {
    timeout: 30_000,
    maxBuffer: 5 * 1024 * 1024
  });
  return { stdout, stderr };
}

async function sendTelegram(text, accountId, buttons = null) {
  // target can be numeric chat id (user id) for Telegram.
  const args = [
    "message",
    "send",
    "--channel",
    "telegram",
    "--account",
    accountId,
    "--target",
    "538226139",
    "--message",
    text
  ];
  if (buttons) {
    args.push("--buttons", JSON.stringify(buttons));
  }
  await execFileAsync("openclaw", args, {
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024
  });
}

async function sendTelegramP0Jarvis(text) {
  // P0 general -> Jarvis channel (default bot)
  return sendTelegram(text, "default");
}

async function sendTelegramP0Haru(text, buttons = null) {
  // P0 coding-idle -> Haru channel (coding bot)
  return sendTelegram(text, "coding", buttons);
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: String(e), text };
  }
}

function parsePeer(value) {
  if (!value) return { kind: null, id: null, label: "" };

  if (typeof value === "object") {
    const kind = value.kind || value.type || value.peerKind || null;
    const id = value.id || value.peerId || value.target || value.value || null;
    return { kind, id, label: [kind, id].filter(Boolean).join("/") };
  }

  const s = String(value).trim();
  if (!s) return { kind: null, id: null, label: "" };

  const m = s.match(/^([^:/\s]+)[/:](.+)$/);
  if (m) return { kind: m[1], id: m[2], label: `${m[1]}/${m[2]}` };
  return { kind: null, id: s, label: s };
}

function normalizeBindingDetail(detail, agent) {
  const agentId = agent.id || "";
  const agentLabel = agent.identityName || agent.name || agentId;

  let channel = "";
  let accountId = "";
  let peer = { kind: null, id: null, label: "" };
  let raw = "";

  if (typeof detail === "string") {
    raw = detail;
    const tokens = detail.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 0 && !tokens[0].includes("=")) {
      channel = tokens[0];
    }
    const kv = {};
    for (const token of tokens.slice(1)) {
      const m = token.match(/^([a-zA-Z0-9_.-]+)=(.+)$/);
      if (m) kv[m[1]] = m[2];
    }

    channel = channel || kv.channel || kv.provider || "";
    accountId = kv.accountId || kv.account || kv.profile || "";
    if (kv.peer || kv.target || kv.to || kv.chat) {
      peer = parsePeer(kv.peer || kv.target || kv.to || kv.chat);
    } else if (kv.peerKind || kv.peerId) {
      peer = parsePeer({ kind: kv.peerKind || null, id: kv.peerId || null });
    }
  } else if (detail && typeof detail === "object") {
    raw = JSON.stringify(detail);
    channel = detail.channel || detail.provider || detail.kind || "";
    accountId = detail.accountId || detail.account || detail.profile || "";

    if (detail.peer || detail.target) {
      peer = parsePeer(detail.peer || detail.target);
    } else if (detail.peerKind || detail.peerId) {
      peer = parsePeer({ kind: detail.peerKind || null, id: detail.peerId || null });
    }
  }

  const human = [channel || "-", accountId ? `@${accountId}` : null, peer.label ? `(${peer.label})` : null]
    .filter(Boolean)
    .join(" ");

  return {
    channel: channel || "-",
    accountId: accountId || "-",
    peerKind: peer.kind,
    peerId: peer.id,
    peerLabel: peer.label || "-",
    agentId,
    label: `${human} -> ${agentLabel}`,
    raw
  };
}

function extractTelegramAccounts(channelsList) {
  const out = new Set();
  if (Array.isArray(channelsList?.chat?.telegram)) {
    for (const id of channelsList.chat.telegram) {
      if (id) out.add(String(id));
    }
  }
  if (Array.isArray(channelsList?.channels)) {
    for (const item of channelsList.channels) {
      if (item?.channel === "telegram" && item?.accountId) out.add(String(item.accountId));
    }
  }
  return [...out].sort();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[s]));
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Human-friendly detail page for Telegram URL button
app.get("/detail/:session", async (req, res) => {
  try {
    const session = String(req.params.session || "");
    if (!session.startsWith("cc-")) return res.status(400).send("invalid session");
    const out = await captureClaudeSession(session, 200);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><meta charset="utf-8" />\n<title>${session} 상세 로그</title>\n<pre style="white-space:pre-wrap;word-break:break-word;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${escapeHtml(out)}</pre>`);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// ── In-memory cache (refreshed in background) ─────────────────────
const SESSION_WINDOWS = {
  "24h": 1440,
  "7d": 10080,
  "30d": 43200
};

let cache = {
  updatedAtMs: 0,
  agents: null,
  sessionsByWindow: {
    "24h": null,
    "7d": null,
    "30d": null
  },
  cron: null,
  overview: null,
  lastError: null,
  lastRefreshMs: null
};

app.get("/api/agents", async (_req, res) => {
  if (cache.agents) return res.json({ ok: true, cached: true, updatedAtMs: cache.updatedAtMs, agents: cache.agents });
  try {
    const { stdout, stderr } = await runOpenClaw(["agents", "list", "--json", "--bindings"]);
    const parsed = safeJsonParse(stdout);
    if (!parsed.ok) return res.status(500).json({ ok: false, error: parsed.error, stderr });
    res.json({ ok: true, cached: false, agents: parsed.value });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/api/routing", async (_req, res) => {
  try {
    const { stdout, stderr } = await runOpenClaw(["agents", "list", "--json", "--bindings"]);
    const parsed = safeJsonParse(stdout);
    if (!parsed.ok) return res.status(500).json({ ok: false, error: parsed.error, stderr });

    const agents = Array.isArray(parsed.value) ? parsed.value : [];
    const rows = [];

    for (const agent of agents) {
      const details = Array.isArray(agent.bindingDetails)
        ? agent.bindingDetails
        : (Array.isArray(agent.bindings) ? agent.bindings : []);

      if (details.length === 0) continue;
      for (const detail of details) {
        rows.push(normalizeBindingDetail(detail, agent));
      }
    }

    let telegramAccounts = [];
    let channelsError = null;
    try {
      const channels = await runOpenClaw(["channels", "list", "--json", "--no-usage"]);
      const channelsParsed = safeJsonParse(channels.stdout);
      if (channelsParsed.ok) {
        telegramAccounts = extractTelegramAccounts(channelsParsed.value);
      } else {
        channelsError = channelsParsed.error;
      }
    } catch (e) {
      channelsError = String(e);
    }

    res.json({
      ok: true,
      updatedAtMs: Date.now(),
      total: rows.length,
      rows,
      telegramAccounts,
      channelsError
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/api/sessions", async (req, res) => {
  const window = String(req.query.window || "24h");
  const active = SESSION_WINDOWS[window] ?? SESSION_WINDOWS["24h"];

  const cached = cache.sessionsByWindow[window];
  if (cached) {
    return res.json({ ok: true, cached: true, window, activeMinutes: active, updatedAtMs: cache.updatedAtMs, ...cached });
  }

  try {
    const { stdout, stderr } = await runOpenClaw(["sessions", "--all-agents", "--json", "--active", String(active)]);
    const parsed = safeJsonParse(stdout);
    if (!parsed.ok) return res.status(500).json({ ok: false, error: parsed.error, stderr });
    res.json({ ok: true, cached: false, window, activeMinutes: active, ...parsed.value });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

function redactCronJob(job) {
  // Avoid leaking secrets embedded in payload.message.
  const safe = {
    id: job.id,
    agentId: job.agentId,
    name: job.name,
    enabled: job.enabled,
    schedule: job.schedule,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    delivery: job.delivery,
    state: job.state,
    // Keep minimal payload metadata only
    payload: job.payload ? {
      kind: job.payload.kind,
      model: job.payload.model,
      timeoutSeconds: job.payload.timeoutSeconds
    } : undefined
  };
  return safe;
}

app.get("/api/cron", async (_req, res) => {
  if (cache.cron) {
    return res.json({ ok: true, cached: true, updatedAtMs: cache.updatedAtMs, jobs: cache.cron.jobs, total: cache.cron.total });
  }
  try {
    const { stdout, stderr } = await runOpenClaw(["cron", "list", "--all", "--json"]);
    const parsed = safeJsonParse(stdout);
    if (!parsed.ok) return res.status(500).json({ ok: false, error: parsed.error, stderr });

    const jobs = (parsed.value.jobs ?? []).map(redactCronJob);
    res.json({ ok: true, cached: false, jobs, total: parsed.value.total });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/api/cron/:id/:action", express.json(), async (req, res) => {
  const { id, action } = req.params;
  if (!["enable", "disable", "run"].includes(action)) {
    return res.status(400).json({ ok: false, error: "Invalid action" });
  }
  try {
    const args = ["cron", action, id, "--json"]; // enable/disable accept id; run accepts id
    const { stdout, stderr } = await runOpenClaw(args);
    const parsed = safeJsonParse(stdout);
    if (!parsed.ok) return res.status(500).json({ ok: false, error: parsed.error, stderr });
    res.json({ ok: true, result: parsed.value, stderr: stderr?.trim() || undefined });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/api/overview", async (_req, res) => {
  if (cache.overview) {
    return res.json({ ok: true, cached: true, updatedAtMs: cache.updatedAtMs, ...cache.overview });
  }
  res.status(503).json({ ok: false, error: "캐시 준비 중입니다. 잠시 후 새로고침 해주세요." });
});

// Trends APIs (SQLite)
app.get("/api/trends/agent-metrics", (req, res) => {
  const days = req.query.days ? Number(req.query.days) : 7;
  const rows = queryAgentMetrics(db, { days });
  res.json({ ok: true, days, rows });
});

app.get("/api/trends/cron-jobs", (req, res) => {
  const days = req.query.days ? Number(req.query.days) : 7;
  const rows = queryCronJobMetrics(db, { days });
  res.json({ ok: true, days, rows });
});

app.get("/api/trends/p0", (req, res) => {
  const days = req.query.days ? Number(req.query.days) : 7;
  const rows = queryP0Events(db, { days });
  res.json({ ok: true, days, rows });
});

async function listClaudeCodeTasks() {
  // Uses claude-code-orchestrator tmux task lister (local).
  const script = "/home/icartsh/.openclaw/workspace/skills/claude-code-orchestrator/scripts/list-tasks.sh";
  try {
    const { stdout } = await execFileAsync("bash", [script, "--json", "--lines", "40"], {
      timeout: 20_000,
      maxBuffer: 5 * 1024 * 1024
    });
    const parsed = safeJsonParse(stdout);
    if (!parsed.ok) return [];
    return parsed.value;
  } catch {
    return [];
  }
}

async function captureClaudeSession(session, lines = 200) {
  const script = "/home/icartsh/.openclaw/workspace/skills/claude-code-orchestrator/scripts/monitor-tmux-task.sh";
  const { stdout } = await execFileAsync("bash", [script, "--session", session, "--lines", String(lines)], {
    timeout: 20_000,
    maxBuffer: 5 * 1024 * 1024
  });
  return stdout;
}

function looksIdlePrompt(lastLines) {
  if (!lastLines) return false;
  const s = String(lastLines).trim();
  if (!s) return false;
  const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || "";
  return last === "❯" || last.startsWith("❯ ");
}

function tailLines(text, n = 10) {
  const lines = String(text || "").split(/\r?\n/);
  const out = lines.slice(-n).join("\n").trimEnd();
  return out;
}

async function computeP0() {
  const now = Date.now();

  const p0 = [];

  // ── P0: cron failures ─────────────────────────────────────────────
  const cronR = await runOpenClaw(["cron", "list", "--all", "--json"]);
  const cronP = safeJsonParse(cronR.stdout);
  const jobs = cronP.ok ? (cronP.value.jobs ?? []) : [];

  const badJobs = jobs.filter(j => {
    const st = j.state || {};
    return (st.consecutiveErrors ?? 0) >= 1 || st.lastStatus === "error" || st.lastRunStatus === "error";
  });

  for (const j of badJobs) {
    const st = j.state || {};
    const key = `p0:cron:${j.id}:${st.lastRunAtMs || 0}:${st.lastStatus || st.lastRunStatus || "error"}`;
    const title = j.name || j.id;
    const reason = st.lastError ? `원인: ${st.lastError}` : "원인: (미상)";
    const msg = `[P0][자비스] 크론 오류 감지: ${title}\n- jobId: ${j.id}\n- 에이전트: ${j.agentId}\n- 상태: ${(st.lastStatus || st.lastRunStatus || "error")} (연속 ${(st.consecutiveErrors || 0)}회)\n- ${reason}\n- 대시보드: https://jarvis.icartsh.com/ (크론 작업 탭)`;
    p0.push({ key, msg, channel: "jarvis" });
  }

  // ── P0: token spike (rough) ───────────────────────────────────────
  const sessionsR = await runOpenClaw(["sessions", "--all-agents", "--json", "--active", "1440"]);
  const sessionsP = safeJsonParse(sessionsR.stdout);
  const sessions = sessionsP.ok ? (sessionsP.value.sessions ?? []) : [];
  const byAgent = {};
  for (const s of sessions) {
    byAgent[s.agentId] = (byAgent[s.agentId] || 0) + Number(s.totalTokens || 0);
  }
  const TOKEN_P0 = Number(process.env.TOKEN_P0 ?? 3_000_000);
  for (const [agentId, total] of Object.entries(byAgent)) {
    if (total >= TOKEN_P0) {
      const key = `p0:tokens:${agentId}:${Math.floor(total/10000)}`;
      const msg = `[P0][자비스] 토큰 사용량 급증: ${agentId}\n- 최근 24시간 토큰: ${Number(total).toLocaleString()}\n- 기준: ${TOKEN_P0.toLocaleString()}\n- 대시보드: https://jarvis.icartsh.com/ (사용량 탭)`;
      p0.push({ key, msg, channel: "jarvis" });
    }
  }

  // ── P0: Claude Code idle prompt > 2 minutes (coding agent) ─────────
  const IDLE_P0_MS = Number(process.env.IDLE_P0_MS ?? 2 * 60 * 1000);
  const tasks = await listClaudeCodeTasks();
  const idleNow = new Set();

  for (const t of tasks) {
    if (!t?.session) continue;
    if (!looksIdlePrompt(t.lastLines)) continue;

    idleNow.add(t.session);

    const state = getState();
    const idleMap = (state.idleFirstSeenAtBySession ||= {});
    const first = idleMap[t.session] ?? now;
    if (idleMap[t.session] == null) {
      // persist first seen
      setState(st => {
        st.idleFirstSeenAtBySession ||= {};
        st.idleFirstSeenAtBySession[t.session] = now;
      });
    }

    if (now - first >= IDLE_P0_MS) {
      const label = t.label || t.session;
      const key = `p0:idle:${t.session}:${Math.floor(first/1000)}`;
      const snippet = tailLines(t.lastLines, 10);
      const detailUrl = `https://jarvis.icartsh.com/detail/${encodeURIComponent(t.session)}`;
      const msg = `[P0][하루] 입력 대기 2분+ (코딩 세션)\n- 세션: ${t.session}\n- 라벨: ${label}\n- 마지막 로그(10줄):\n\n${snippet ? '```\n' + snippet + '\n```' : '(없음)'}\n\n버튼으로 200줄 상세 로그를 볼 수 있어요.\n추가로 더 길게 필요하면 "자세히보여줘"라고 말해주시면 제가 더 길게 캡쳐해서 보내드릴게요.`;

      const buttons = [[
        { text: "자세히(200줄)", url: detailUrl },
        { text: "대시보드 열기", url: "https://jarvis.icartsh.com/" }
      ]];

      p0.push({ key, msg, channel: "haru", buttons });
    }
  }

  // Clear idle timers for sessions that are no longer idle
  setState(st => {
    const m = (st.idleFirstSeenAtBySession ||= {});
    for (const sess of Object.keys(m)) {
      if (!idleNow.has(sess)) delete m[sess];
    }
  });

  // ── Send with cooldown ────────────────────────────────────────────
  for (const item of p0) {
    if (!shouldSend(item.key, now)) continue;

    // Persist P0 to DB (best-effort)
    try {
      insertP0Event(db, {
        tsMs: now,
        key: item.key,
        kind: item.channel === "haru" ? "idle_input" : (item.key.startsWith("p0:cron:") ? "cron_error" : (item.key.startsWith("p0:tokens:") ? "token_spike" : "p0")),
        agentId: item.channel === "haru" ? "coding" : "main",
        title: item.key,
        message: item.msg
      });
    } catch {}

    if (item.channel === "haru") {
      await sendTelegramP0Haru(item.msg, item.buttons || null);
    } else {
      await sendTelegramP0Jarvis(item.msg);
    }
  }
}

async function refreshAll() {
  const t0 = Date.now();
  try {
    const [agentsR, sessionsR, cronR] = await Promise.all([
      runOpenClaw(["agents", "list", "--json", "--bindings"]),
      runOpenClaw(["sessions", "--all-agents", "--json", "--active", String(SESSION_WINDOWS["24h"]) ]),
      runOpenClaw(["cron", "list", "--all", "--json"])
    ]);

    const agentsP = safeJsonParse(agentsR.stdout);
    const sessionsP = safeJsonParse(sessionsR.stdout);
    const cronP = safeJsonParse(cronR.stdout);

    if (!agentsP.ok) throw new Error(`agents parse failed: ${agentsP.error}`);
    if (!sessionsP.ok) throw new Error(`sessions parse failed: ${sessionsP.error}`);
    if (!cronP.ok) throw new Error(`cron parse failed: ${cronP.error}`);

    // Redact cron job payloads before caching
    const cronSafe = {
      jobs: (cronP.value.jobs ?? []).map(redactCronJob),
      total: cronP.value.total ?? (cronP.value.jobs?.length ?? 0)
    };

    const agents = agentsP.value;
    const sessionsWrap24h = sessionsP.value;
    const sessions = sessionsWrap24h.sessions ?? [];

    // Overview summary per agent
    const byAgent = {};
    for (const a of agents) {
      byAgent[a.id] = {
        agentId: a.id,
        name: a.identityName ?? a.name ?? a.id,
        emoji: a.identityEmoji,
        workspace: a.workspace,
        model: a.model,
        sessionsActive: 0,
        tokens24h: 0,
        cronJobs: 0,
        cronErrors: 0
      };
    }

    for (const s of sessions) {
      const a = byAgent[s.agentId];
      if (!a) continue;
      a.sessionsActive += 1;
      a.tokens24h += Number(s.totalTokens ?? 0);
    }

    for (const j of (cronP.value.jobs ?? [])) {
      const a = byAgent[j.agentId];
      if (!a) continue;
      a.cronJobs += 1;
      if (j.state?.lastStatus === "error" || j.state?.lastRunStatus === "error" || (j.state?.consecutiveErrors ?? 0) > 0) a.cronErrors += 1;
    }

    const overview = {
      activeMinutes: ACTIVE_MINUTES,
      agents: Object.values(byAgent)
    };

    cache = {
      updatedAtMs: Date.now(),
      agents,
      sessionsByWindow: {
        ...cache.sessionsByWindow,
        "24h": sessionsWrap24h
      },
      cron: cronSafe,
      overview,
      lastError: null,
      lastRefreshMs: Date.now() - t0
    };

    // Persist metrics to SQLite (sample every refresh)
    const tsMs = cache.updatedAtMs;
    for (const a of overview.agents) {
      insertAgentMetrics(db, {
        tsMs,
        agentId: a.agentId,
        sessionsActive: a.sessionsActive,
        tokens24hTotal: a.tokens24h,
        cronJobs: a.cronJobs,
        cronErrors: a.cronErrors
      });
    }

    // Persist job-level cron metrics (for 7d analysis)
    for (const j of (cronP.value.jobs ?? [])) {
      const st = j.state || {};
      insertCronJobMetric(db, {
        tsMs,
        jobId: j.id,
        agentId: j.agentId || null,
        enabled: j.enabled ? 1 : 0,
        scheduleKind: j.schedule?.kind || null,
        scheduleExpr: j.schedule?.expr || null,
        lastStatus: st.lastStatus || null,
        lastRunStatus: st.lastRunStatus || null,
        consecutiveErrors: Number(st.consecutiveErrors || 0),
        lastError: st.lastError || null,
        nextRunAtMs: st.nextRunAtMs || null,
        lastRunAtMs: st.lastRunAtMs || null
      });
    }
  } catch (e) {
    cache.lastError = String(e);
  }
}

async function refreshSessionsWindow(windowKey) {
  const active = SESSION_WINDOWS[windowKey];
  const r = await runOpenClaw(["sessions", "--all-agents", "--json", "--active", String(active)]);
  const p = safeJsonParse(r.stdout);
  if (!p.ok) return;
  cache.sessionsByWindow[windowKey] = p.value;
}

function startCollector() {
  const intervalMs = Number(process.env.REFRESH_EVERY_MS ?? 10_000);
  const longIntervalMs = Number(process.env.REFRESH_LONG_EVERY_MS ?? 60_000);

  // initial refresh (do not block server start)
  refreshAll();
  setInterval(() => refreshAll(), intervalMs);

  // long windows (7d/30d) refresh less frequently
  setInterval(() => {
    refreshSessionsWindow("7d");
    refreshSessionsWindow("30d");
  }, longIntervalMs);
}

function startNotifier() {
  const intervalMs = Number(process.env.NOTIFY_EVERY_MS ?? 60_000);
  setInterval(() => {
    computeP0().catch(() => {});
  }, intervalMs);
}

app.listen(PORT, "127.0.0.1", () => {
  console.log(`openclaw-ops-dashboard listening on http://127.0.0.1:${PORT}/`);
  startCollector();
  startNotifier();
});
