import { useEffect, useMemo, useState } from "react";
import { KO as T } from "@/i18n/ko";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/hooks/use-toast";
import { TrendLineChart } from "@/components/TrendLineChart";

async function api(path, opts) {
  const res = await fetch(`/api/${path}`, opts);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "API 오류가 났어요");
  return json;
}

function fmtTs(ms) {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function fmtAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  return `${h}시간`;
}

function CronAnalysis({ cron, cronTrends }) {
  if (!cronTrends?.rows || !cron) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>크론 분석(7일)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">자비스: 분석 데이터를 불러오는 중이에요…</div>
        </CardContent>
      </Card>
    );
  }

  const liveJobs = new Map((cron.jobs || []).map((j) => [j.id, j]));
  const rows = cronTrends.rows;

  // Aggregate per job
  const byJob = new Map();
  for (const r of rows) {
    const j = byJob.get(r.job_id) || {
      jobId: r.job_id,
      agentId: r.agent_id,
      enabled: !!r.enabled,
      maxConsecutive: 0,
      errorSamples: 0,
      lastError: null,
      lastTs: 0,
    };
    j.maxConsecutive = Math.max(j.maxConsecutive, Number(r.consecutive_errors || 0));
    if (r.last_status === "error" || r.last_run_status === "error" || Number(r.consecutive_errors || 0) > 0) {
      j.errorSamples += 1;
      if (r.last_error && r.ts_ms >= j.lastTs) {
        j.lastError = r.last_error;
        j.lastTs = r.ts_ms;
      }
    }
    byJob.set(r.job_id, j);
  }

  const jobStats = [...byJob.values()].map((j) => {
    const live = liveJobs.get(j.jobId);
    return {
      ...j,
      name: live?.name || j.jobId,
      liveEnabled: live?.enabled,
      liveLastStatus: live?.state?.lastStatus || live?.state?.lastRunStatus,
      liveConsecutive: live?.state?.consecutiveErrors || 0,
    };
  });

  const topConsecutive = [...jobStats]
    .sort((a, b) => (b.maxConsecutive - a.maxConsecutive) || (b.errorSamples - a.errorSamples))
    .slice(0, 10);

  // Group error text
  const errorGroups = new Map();
  for (const j of jobStats) {
    if (!j.lastError) continue;
    const key = String(j.lastError).slice(0, 140);
    errorGroups.set(key, (errorGroups.get(key) || 0) + 1);
  }
  const topErrors = [...errorGroups.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([text, count]) => ({ text, count }));

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>7일 연속 오류 TOP</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-background sticky top-0">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left">작업</th>
                  <th className="px-3 py-2 text-right">최대 연속</th>
                  <th className="px-3 py-2 text-right">오류 샘플</th>
                </tr>
              </thead>
              <tbody>
                {topConsecutive.map((j) => (
                  <tr key={j.jobId} className="border-b">
                    <td className="px-3 py-2">
                      <div className="font-medium">{j.name}</div>
                      <div className="text-xs text-muted-foreground break-all">{j.jobId}</div>
                      {j.lastError ? (
                        <div className="mt-1 text-xs text-muted-foreground line-clamp-2">{j.lastError}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Badge variant={j.maxConsecutive > 0 ? "destructive" : "secondary"}>{j.maxConsecutive}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right">{j.errorSamples}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>오류 원인 TOP</CardTitle>
        </CardHeader>
        <CardContent>
          {topErrors.length === 0 ? (
            <div className="text-sm text-muted-foreground">자비스: 최근 7일간 기록된 오류 원인이 없어요.</div>
          ) : (
            <div className="space-y-2">
              {topErrors.map((e) => (
                <div key={e.text} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">{e.count}건</div>
                    <Badge variant="outline">TOP</Badge>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap break-words">{e.text}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function UsageCharts({ trendAgent }) {
  const rows = trendAgent.rows || [];

  // downsample: take one point per 5 minutes per agent to keep chart light
  const byAgent = {};
  for (const r of rows) {
    (byAgent[r.agent_id] ||= []).push(r);
  }

  const charts = Object.entries(byAgent).map(([agentId, points]) => {
    points.sort((a, b) => a.ts_ms - b.ts_ms);
    const sampled = [];
    let lastBucket = -1;
    for (const p of points) {
      const bucket = Math.floor(p.ts_ms / (5 * 60 * 1000));
      if (bucket === lastBucket) continue;
      lastBucket = bucket;
      sampled.push({
        tsMs: p.ts_ms,
        tsLabel: "·",
        cronErrors: p.cron_errors,
        tokens24h: p.tokens_24h_total,
        sessions: p.sessions_active,
      });
    }

    return (
      <Card key={agentId} className="border-muted">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{agentId} · 크론 오류(B) / 토큰(A)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <div className="mb-2 text-sm text-muted-foreground">크론 오류 추이 (B)</div>
            <TrendLineChart
              data={sampled}
              lines={[{ key: "cronErrors", name: "크론 오류", color: "#ef4444" }]}
              height={240}
            />
          </div>
          <div>
            <div className="mb-2 text-sm text-muted-foreground">토큰(24h 합계) 추이 (A)</div>
            <TrendLineChart
              data={sampled}
              lines={[{ key: "tokens24h", name: "토큰(24h)", color: "#22c55e" }]}
              height={240}
            />
          </div>
        </CardContent>
      </Card>
    );
  });

  return <div className="grid gap-4 md:grid-cols-2">{charts}</div>;
}

export default function App() {
  const { toast } = useToast();
  const [tab, setTab] = useState("overview");

  const [overview, setOverview] = useState(null);
  const [cron, setCron] = useState(null);
  const [cronTrends, setCronTrends] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [trendAgent, setTrendAgent] = useState(null);

  // Sessions UI state
  const [windowKey, setWindowKey] = useState("24h");
  const [agentId, setAgentId] = useState("all");
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState({
    direct: true,
    cron: true,
    run: true,
    group: true,
    channel: true,
  });

  // Confirm dialog for cron actions
  const [confirm, setConfirm] = useState({ open: false, job: null, action: null });

  const refreshOverview = async () => {
    const data = await api("overview");
    setOverview(data);
  };
  const refreshCron = async () => {
    const [live, trends] = await Promise.all([
      api("cron"),
      api("trends/cron-jobs?days=7"),
    ]);
    setCron(live);
    setCronTrends(trends);
  };
  const refreshSessions = async () => {
    const data = await api(`sessions?window=${encodeURIComponent(windowKey)}`);
    setSessions(data);
  };

  const refreshTrends = async () => {
    const data = await api("trends/agent-metrics?days=7");
    setTrendAgent(data);
  };

  useEffect(() => {
    refreshOverview().catch((e) => toast({ title: T.status.error, description: e.message, variant: "destructive" }));
  }, []);

  useEffect(() => {
    if (tab === "cron") refreshCron().catch((e) => toast({ title: T.status.error, description: e.message, variant: "destructive" }));
    if (tab === "sessions") refreshSessions().catch((e) => toast({ title: T.status.error, description: e.message, variant: "destructive" }));
    if (tab === "usage") refreshTrends().catch((e) => toast({ title: T.status.error, description: e.message, variant: "destructive" }));
  }, [tab]);

  useEffect(() => {
    if (tab === "sessions") refreshSessions().catch(() => {});
  }, [windowKey]);

  const agentRole = (id) => {
    if (id === "main") return { label: T.overview.role.jarvis, tone: "jarvis" };
    if (id === "coding") return { label: T.overview.role.haru, tone: "haru" };
    return { label: id, tone: "other" };
  };

  const kindOfKey = (key) => {
    if (!key) return "direct";
    if (key.includes(":cron:") && key.includes(":run:")) return "run";
    if (key.includes(":cron:")) return "cron";
    if (key.includes(":group:")) return "group";
    if (key.includes(":channel:")) return "channel";
    return "direct";
  };

  const filteredSessions = useMemo(() => {
    if (!sessions?.sessions) return [];
    const q = query.trim().toLowerCase();
    return [...sessions.sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((s) => {
        if (agentId !== "all" && s.agentId !== agentId) return false;
        const k = kindOfKey(s.key);
        if (!kinds[k]) return false;
        if (!q) return true;
        // NOTE: errorText 검색은 다음 단계에서 cron job state.lastError 조인해서 추가
        const hay = [s.key, s.agentId, s.kind, s.modelProvider, s.model].join(" ").toLowerCase();
        return hay.includes(q);
      });
  }, [sessions, agentId, query, kinds]);

  const runCronAction = async (jobId, action) => {
    await api(`cron/${jobId}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    toast({ title: T.status.ok, description: `자비스: 크론 작업 처리했어요 (${action})` });
    refreshCron().catch(() => {});
    refreshOverview().catch(() => {});
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4">
          <div>
            <div className="text-sm text-muted-foreground">{T.app.subtitle}</div>
            <h1 className="text-lg font-semibold">{T.app.title}</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => refreshOverview().catch(() => {})}>{T.topbar.refresh}</Button>
            <Button variant="outline" asChild>
              <a href="/ops/" target="_blank" rel="noreferrer">{T.topbar.openclawOps}</a>
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="overview">{T.tabs.overview}</TabsTrigger>
            <TabsTrigger value="sessions">{T.tabs.sessions}</TabsTrigger>
            <TabsTrigger value="cron">{T.tabs.cron}</TabsTrigger>
            <TabsTrigger value="routing">{T.tabs.routing}</TabsTrigger>
            <TabsTrigger value="usage">{T.tabs.usage}</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>{T.overview.agentsTitle}</CardTitle>
              </CardHeader>
              <CardContent>
                {!overview ? (
                  <div className="text-sm text-muted-foreground">{T.status.loading}</div>
                ) : (
                  <div className="space-y-3">
                    <div className="text-xs text-muted-foreground">
                      {T.overview.updatedAt}: {fmtTs(overview.updatedAtMs)} · {T.overview.cached}: {String(overview.cached)}
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      {overview.agents.map((a) => {
                        const r = agentRole(a.agentId);
                        return (
                          <Card key={a.agentId} className="border-muted">
                            <CardHeader className="pb-2">
                              <CardTitle className="flex items-center justify-between text-base">
                                <span>
                                  {a.emoji ? `${a.emoji} ` : ""}{a.name}
                                </span>
                                <Badge variant="outline">{r.label}</Badge>
                              </CardTitle>
                            </CardHeader>
                            <CardContent className="grid grid-cols-2 gap-2 text-sm">
                              <div><span className="text-muted-foreground">{T.overview.kpi.sessions}</span> {a.sessionsActive}</div>
                              <div><span className="text-muted-foreground">{T.overview.kpi.tokens24h}</span> {a.tokens24h.toLocaleString()}</div>
                              <div><span className="text-muted-foreground">{T.overview.kpi.cronJobs}</span> {a.cronJobs}</div>
                              <div><span className="text-muted-foreground">{T.overview.kpi.cronErrors}</span> {a.cronErrors}</div>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="sessions" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>{T.sessions.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={windowKey} onValueChange={setWindowKey}>
                    <SelectTrigger className="w-[160px]"><SelectValue placeholder="표시 범위" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="24h">{T.sessions.scope.h24}</SelectItem>
                      <SelectItem value="7d">{T.sessions.scope.d7}</SelectItem>
                      <SelectItem value="30d">{T.sessions.scope.d30}</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select value={agentId} onValueChange={setAgentId}>
                    <SelectTrigger className="w-[160px]"><SelectValue placeholder="에이전트" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{T.sessions.agent.all}</SelectItem>
                      <SelectItem value="main">{T.sessions.agent.jarvis}</SelectItem>
                      <SelectItem value="coding">{T.sessions.agent.haru}</SelectItem>
                    </SelectContent>
                  </Select>

                  <Input className="w-[280px]" placeholder={T.sessions.searchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} />

                  <div className="flex flex-wrap gap-1">
                    {[
                      ["direct", "DM"],
                      ["cron", "CRON"],
                      ["run", "RUN"],
                      ["group", "GROUP"],
                      ["channel", "CHANNEL"],
                    ].map(([k, label]) => (
                      <Button
                        key={k}
                        variant={kinds[k] ? "default" : "outline"}
                        size="sm"
                        onClick={() => setKinds((p) => ({ ...p, [k]: !p[k] }))}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>

                  <div className="text-xs text-muted-foreground">
                    표시: {filteredSessions.length} / 전체 {sessions?.sessions?.length ?? 0}
                  </div>
                </div>

                <div className="space-y-2">
                  {!sessions ? (
                    <div className="text-sm text-muted-foreground">불러오는 중…</div>
                  ) : (
                    <div className="max-h-[520px] overflow-auto rounded-md border">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-background">
                          <tr className="border-b">
                            <th className="px-3 py-2 text-left">키</th>
                            <th className="px-3 py-2 text-left">업데이트</th>
                            <th className="px-3 py-2 text-left">모델</th>
                            <th className="px-3 py-2 text-left">토큰</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredSessions.map((s) => {
                            const k = kindOfKey(s.key);
                            const kindLabel = ({ direct: "DM", cron: "CRON", run: "RUN", group: "GROUP", channel: "CHANNEL" })[k] || k;
                            return (
                              <tr key={s.key} className="border-b hover:bg-muted/50">
                                <td className="px-3 py-2">
                                  <div className="flex flex-wrap gap-1">
                                    <Badge variant="outline">{s.agentId}</Badge>
                                    <Badge variant="secondary">{kindLabel}</Badge>
                                    <span className="text-xs text-muted-foreground">{s.kind}</span>
                                  </div>
                                  <div className="mt-1 font-mono text-xs break-all">{s.key}</div>
                                </td>
                                <td className="px-3 py-2">
                                  {fmtTs(s.updatedAt)}
                                  <div className="text-xs text-muted-foreground">경과 {fmtAge(s.ageMs)}</div>
                                </td>
                                <td className="px-3 py-2">
                                  <Badge variant="outline">{s.modelProvider}/{s.model}</Badge>
                                </td>
                                <td className="px-3 py-2">
                                  <div className="flex flex-wrap gap-1">
                                    <Badge variant="outline">입력 {s.inputTokens ?? "-"}</Badge>
                                    <Badge variant="outline">출력 {s.outputTokens ?? "-"}</Badge>
                                    <Badge variant="outline">합계 {s.totalTokens ?? "-"}</Badge>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="cron" className="mt-4">
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>{T.cron.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="text-xs text-muted-foreground">{T.cron.noteConfirm}</div>

                  {!cron ? (
                    <div className="text-sm text-muted-foreground">{T.status.loading}</div>
                  ) : (
                    <div className="max-h-[520px] overflow-auto rounded-md border">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-background">
                          <tr className="border-b">
                            <th className="px-3 py-2 text-left">{T.cron.cols.job}</th>
                            <th className="px-3 py-2 text-left">{T.cron.cols.schedule}</th>
                            <th className="px-3 py-2 text-left">{T.cron.cols.enabled}</th>
                            <th className="px-3 py-2 text-left">{T.cron.cols.last}</th>
                            <th className="px-3 py-2 text-left">{T.cron.cols.actions}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cron.jobs.map((j) => {
                            const st = j.state || {};
                            const bad = st.lastStatus === "error" || st.lastRunStatus === "error" || (st.consecutiveErrors || 0) > 0;
                            return (
                              <tr key={j.id} className="border-b hover:bg-muted/50">
                                <td className="px-3 py-2">
                                  <div className="font-medium">{j.name || j.id}</div>
                                  <div className="text-xs text-muted-foreground">{j.id} · agent={j.agentId}</div>
                                </td>
                                <td className="px-3 py-2">
                                  <div>{j.schedule?.kind}</div>
                                  <div className="text-xs text-muted-foreground">{j.schedule?.expr}</div>
                                </td>
                                <td className="px-3 py-2">
                                  <Badge variant={j.enabled ? "default" : "outline"}>{j.enabled ? T.cron.enabled : T.cron.disabled}</Badge>
                                </td>
                                <td className="px-3 py-2">
                                  <Badge variant={bad ? "destructive" : "secondary"}>{st.lastStatus || st.lastRunStatus || "-"}</Badge>
                                  <div className="text-xs text-muted-foreground">{T.cron.nextRun}: {st.nextRunAtMs ? fmtTs(st.nextRunAtMs) : "-"}</div>
                                  {st.lastError ? <div className="text-xs text-muted-foreground line-clamp-2">{st.lastError}</div> : null}
                                </td>
                                <td className="px-3 py-2">
                                  <div className="flex flex-wrap gap-2">
                                    <Button
                                      size="sm"
                                      variant={j.enabled ? "destructive" : "default"}
                                      onClick={() => setConfirm({ open: true, job: j, action: j.enabled ? "disable" : "enable" })}
                                    >
                                      {j.enabled ? T.cron.disable : T.cron.enable}
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={() => setConfirm({ open: true, job: j, action: "run" })}>{T.cron.runNow}</Button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>

              <CronAnalysis cron={cron} cronTrends={cronTrends} />
            </div>
          </TabsContent>

          <TabsContent value="routing" className="mt-4">
            <Card>
              <CardHeader><CardTitle>라우팅(바인딩)</CardTitle></CardHeader>
              <CardContent>
                <div className="text-sm text-muted-foreground">
                  다음 단계에서 bindings 원문 테이블(채널/accountId/peer)을 예쁘게 렌더링할게요.
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="usage" className="mt-4">
            <Card>
              <CardHeader><CardTitle>사용량(7일)</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {!trendAgent ? (
                  <div className="text-sm text-muted-foreground">{T.status.loading}</div>
                ) : (
                  <UsageCharts trendAgent={trendAgent} />
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={confirm.open} onOpenChange={(open) => setConfirm((p) => ({ ...p, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{T.confirm.title}</DialogTitle>
            <DialogDescription>
              {T.confirm.desc}
              {confirm.job ? (
                <div className="mt-2 text-xs text-muted-foreground">
                  {T.cron.cols.job}: {confirm.job.name || confirm.job.id}<br />
                  동작: {confirm.action}
                </div>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm({ open: false, job: null, action: null })}>{T.confirm.cancel}</Button>
            <Button
              onClick={() => {
                const j = confirm.job;
                const act = confirm.action;
                setConfirm({ open: false, job: null, action: null });
                if (j && act) runCronAction(j.id, act).catch((e) => toast({ title: T.status.error, description: e.message, variant: "destructive" }));
              }}
            >
              {T.confirm.run}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Toaster />
    </div>
  );
}
