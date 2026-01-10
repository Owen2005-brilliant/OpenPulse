import { useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import HealthGauge from "../components/HealthGauge";
import { buildRiskAlerts } from "../lib/riskRules";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// -----------------------------
// helpers: metrics 优先 + log fallback
// -----------------------------
// latest 取值：优先主字段，缺失再用 *_log
const pick = (obj, key, fallbackKey) => {
  const v = obj?.[key];
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (!fallbackKey) return v;
  return obj?.[fallbackKey];
};

// series 取值：同理
const seriesPick = (row, key, fallbackKey) => {
  const v = row?.[key];
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (!fallbackKey) return v;
  return row?.[fallbackKey];
};

function Panel({ title, children, className = "", compact = false }) {
  return (
    <div className={`rounded-xl border border-slate-700/60 bg-slate-900/40 shadow-[0_0_40px_rgba(59,130,246,0.08)] ${className}`}>
      {title ? (
        <div className={`${compact ? "px-3 py-2" : "px-4 py-3"} border-b border-slate-700/50 text-slate-200 font-semibold tracking-wide`}>
          {title}
        </div>
      ) : null}
      <div className={compact ? "p-3" : "p-4"}>{children}</div>
    </div>
  );
}

function StatCard({ label, value, suffix = "", trend = "up", compact = false }) {
  const display = useMemo(() => {
    if (typeof value === "number" && !Number.isNaN(value)) {
      // 顶部 KPI 卡片更偏“数字看板”，compact 模式下用整数显示更利落
      const v = compact ? Math.round(value) : value;
      return v.toLocaleString();
    }
    return value ?? "-";
  }, [value]);
  return (
    <div
      className={`relative rounded-xl border border-slate-700/60 bg-slate-900/40 ${
        compact ? "px-3 py-2" : "px-4 py-3"
      } ${compact ? "flex flex-col items-center justify-center text-center" : "flex flex-col justify-between"}`}
    >
      <div className={`text-slate-300 ${compact ? "text-xs" : "text-sm"}`}>{label}</div>

      <div className={`${compact ? "mt-2" : ""} flex items-end justify-center gap-2`}>
        <div className={`text-slate-100 font-bold leading-none ${compact ? "text-3xl" : "text-4xl"}`}>{display}</div>
        {suffix ? (
          <div className={`text-slate-300 mb-1 ${compact ? "text-xs" : "text-sm"}`}>{suffix}</div>
        ) : null}
      </div>

      <div
        className={`absolute right-2 top-2 rounded-md border px-1.5 py-0.5 text-[10px] tabular-nums ${
          trend === "up"
            ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
            : "border-rose-500/25 bg-rose-500/10 text-rose-200"
        }`}
        title={trend === "up" ? "Up" : "Down"}
      >
        {trend === "up" ? "▲" : "▼"}
      </div>
    </div>
  );
}

function MarkdownBlock({ text, className = "" }) {
  const md = (text || "").toString();
  return (
    <div className={`overflow-auto pr-1 ${className || "max-h-[70vh]"}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // react-markdown 默认不渲染 raw HTML，能避免 XSS；这里也不启用 rehypeRaw
        components={{
          h1: (props) => <h1 className="text-xl font-semibold text-slate-100 mb-3" {...props} />,
          h2: (props) => <h2 className="text-lg font-semibold text-slate-100 mt-4 mb-2" {...props} />,
          h3: (props) => <h3 className="text-base font-semibold text-slate-100 mt-3 mb-2" {...props} />,
          p: (props) => <p className="text-slate-200/90 text-sm leading-relaxed my-2" {...props} />,
          ul: (props) => <ul className="list-disc pl-5 my-2 space-y-1 text-slate-200/90 text-sm" {...props} />,
          ol: (props) => <ol className="list-decimal pl-5 my-2 space-y-1 text-slate-200/90 text-sm" {...props} />,
          li: (props) => <li className="leading-relaxed" {...props} />,
          strong: (props) => <strong className="text-slate-100 font-semibold" {...props} />,
          em: (props) => <em className="text-slate-100/90" {...props} />,
          hr: () => <hr className="my-4 border-white/10" />,
          blockquote: (props) => (
            <blockquote className="border-l-2 border-sky-500/40 pl-3 my-3 text-slate-200/85" {...props} />
          ),
          code: ({ inline, children, ...props }) =>
            inline ? (
              <code className="px-1 py-0.5 rounded bg-white/5 border border-white/10 text-slate-100 text-xs" {...props}>
                {children}
              </code>
            ) : (
              <pre className="p-3 rounded-lg bg-black/30 border border-white/10 overflow-auto my-3">
                <code className="text-slate-100 text-xs" {...props}>
                  {children}
                </code>
              </pre>
            ),
          a: (props) => (
            <a className="text-sky-300 hover:text-sky-200 underline" target="_blank" rel="noreferrer" {...props} />
          ),
        }}
      >
        {md}
      </ReactMarkdown>
    </div>
  );
}

// -----------------------------
// v2 streaming helpers (SSE over fetch POST)
// -----------------------------
async function streamSSEPost(url, body, { onDelta, onError, onDone, signal } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(txt || `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error("No response body (stream unsupported).");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let eventName = "message";
  let dataLines = [];

  const flushEvent = () => {
    const data = dataLines.join("\n");
    if (eventName === "delta") onDelta?.(data);
    if (eventName === "error") onError?.(data);
    if (eventName === "done") onDone?.(data);
    eventName = "message";
    dataLines = [];
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // 兼容 \r\n 分隔（某些环境下 SSE 用 CRLF），统一成 \n，避免找不到 "\n\n" 分隔符导致“看起来不流式”。
    buf = buf.replace(/\r\n/g, "\n");

    while (true) {
      const idx = buf.indexOf("\n\n");
      if (idx === -1) break;
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      const lines = raw.split("\n").map((l) => l.replace(/\r$/, ""));
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim() || "message";
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }
      flushEvent();
    }
  }
}

function LevelBadge({ level }) {
  const lv = (level || "").toLowerCase();
  const cls =
    lv === "high"
      ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
      : lv === "medium"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
      : "border-sky-500/30 bg-sky-500/10 text-sky-200";
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {lv ? lv.toUpperCase() : "—"}
    </span>
  );
}

function ComparisonsTable({ comparisons }) {
  const items = comparisons?.items || [];
  if (!comparisons?.available || !items.length) return null;

  const fmt = (x) => (typeof x === "number" && !Number.isNaN(x) ? x.toFixed(2) : "—");
  const fmtPct = (p) => (typeof p === "number" && !Number.isNaN(p) ? `${(p * 100).toFixed(0)}%` : "—");

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3 overflow-auto">
      <div className="text-slate-200 font-semibold text-sm mb-2">时间窗口对比（last1 vs prev3 / last3 vs prev3）</div>
      <table className="w-full text-xs text-slate-200/90">
        <thead className="text-slate-400">
          <tr>
            <th className="text-left py-1 pr-2">指标</th>
            <th className="text-right py-1 px-2">last1</th>
            <th className="text-right py-1 px-2">prev3_avg</th>
            <th className="text-right py-1 px-2">Δ%</th>
            <th className="text-right py-1 px-2">last3_avg</th>
            <th className="text-right py-1 px-2">prev3_before_last3</th>
            <th className="text-right py-1 pl-2">Δ%</th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 10).map((it, idx) => (
            <tr key={idx} className="border-t border-white/10">
              <td className="py-1 pr-2 text-slate-100 whitespace-nowrap">{it.label || it.metric}</td>
              <td className="py-1 px-2 text-right tabular-nums">{fmt(it.last1)}</td>
              <td className="py-1 px-2 text-right tabular-nums">{fmt(it.prev3_avg)}</td>
              <td className="py-1 px-2 text-right tabular-nums">
                <span className={typeof it.last1_vs_prev3_pct === "number" && it.last1_vs_prev3_pct < 0 ? "text-rose-300" : "text-emerald-300"}>
                  {fmtPct(it.last1_vs_prev3_pct)}
                </span>
              </td>
              <td className="py-1 px-2 text-right tabular-nums">{fmt(it.last3_avg)}</td>
              <td className="py-1 px-2 text-right tabular-nums">{fmt(it.prev3_before_last3_avg)}</td>
              <td className="py-1 pl-2 text-right tabular-nums">
                <span className={typeof it.last3_vs_prev3_pct === "number" && it.last3_vs_prev3_pct < 0 ? "text-rose-300" : "text-emerald-300"}>
                  {fmtPct(it.last3_vs_prev3_pct)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StructuredAlertsView({ data, showComparisons = true }) {
  if (!data) return null;
  const risks = Array.isArray(data.risks) ? data.risks : [];
  const next = Array.isArray(data.next_metrics) ? data.next_metrics : [];
  const whyT = Array.isArray(data.why_triggered) ? data.why_triggered : [];
  const whyN = Array.isArray(data.why_not_triggered) ? data.why_not_triggered : [];

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-white/10 bg-white/5 p-3">
        <div className="text-slate-100 font-semibold">摘要</div>
        <div className="mt-2 text-slate-200/90 text-sm leading-relaxed">{data.summary || "—"}</div>
        {next.length ? (
          <div className="mt-2 text-xs text-slate-400">
            下一步关注指标：<span className="text-slate-200">{next.join("、")}</span>
          </div>
        ) : null}
      </div>

      {showComparisons ? <ComparisonsTable comparisons={data.comparisons} /> : null}

      {(whyT.length || whyN.length) ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="text-slate-100 font-semibold text-sm">为什么触发</div>
            <ul className="mt-2 list-disc pl-5 space-y-1 text-sm text-slate-200/90">
              {whyT.length ? whyT.slice(0, 8).map((x, i) => <li key={i}>{x}</li>) : <li className="text-slate-500">—</li>}
            </ul>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="text-slate-100 font-semibold text-sm">为什么没触发 / 未观察到</div>
            <ul className="mt-2 list-disc pl-5 space-y-1 text-sm text-slate-200/90">
              {whyN.length ? whyN.slice(0, 8).map((x, i) => <li key={i}>{x}</li>) : <li className="text-slate-500">—</li>}
            </ul>
          </div>
        </div>
      ) : null}

      {risks.length ? (
        <div className="space-y-3">
          {risks.map((r, idx) => (
            <div key={r.id || idx} className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-slate-100 font-semibold">{r.title || "风险项"}</div>
                <LevelBadge level={r.level} />
              </div>
              <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-slate-400">风险点</div>
                  <div className="mt-1 text-sm text-slate-200/90 leading-relaxed">{r.risk || "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-400">影响</div>
                  <div className="mt-1 text-sm text-slate-200/90 leading-relaxed">{r.impact || "—"}</div>
                </div>
              </div>
              {Array.isArray(r.evidence) && r.evidence.length ? (
                <div className="mt-3">
                  <div className="text-xs text-slate-400">证据</div>
                  <ul className="mt-1 list-disc pl-5 space-y-1 text-sm text-slate-200/90">
                    {r.evidence.slice(0, 6).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              ) : null}
              {Array.isArray(r.actions) && r.actions.length ? (
                <div className="mt-3">
                  <div className="text-xs text-slate-400">建议动作（负责人 / 节奏 / SLA / 成功判据）</div>
                  <div className="mt-2 space-y-2">
                    {r.actions.slice(0, 4).map((a, i) => (
                      <div key={i} className="rounded-lg border border-white/10 bg-black/20 p-2 text-sm text-slate-200/90">
                        <div><span className="text-slate-400">负责人：</span>{a.owner || "—"}</div>
                        <div className="mt-1 grid grid-cols-1 md:grid-cols-3 gap-2">
                          <div><span className="text-slate-400">节奏：</span>{a.cadence || "—"}</div>
                          <div><span className="text-slate-400">SLA：</span>{a.sla || "—"}</div>
                          <div><span className="text-slate-400">成功判据：</span>{a.success || "—"}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// robust min-max using p10..p90
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function scaleByQuantile(x, p10, p90, invert = false) {
  if (x == null || p10 == null || p90 == null || p90 === p10) return 0.5;
  const t = clamp01((x - p10) / (p90 - p10));
  return invert ? 1 - t : t;
}

function computeQuantiles(series, getter) {
  const arr = series
    .map(getter)
    .filter(v => typeof v === "number" && !Number.isNaN(v))
    .sort((a, b) => a - b);
  if (arr.length < 5) return { p10: null, p90: null };
  const q = (p) => {
    const idx = (arr.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return arr[lo];
    return arr[lo] * (hi - idx) + arr[hi] * (idx - lo);
  };
  return { p10: q(0.1), p90: q(0.9) };
}

function buildTempScores(latest, series) {
  // compute per-metric quantiles on this repo’s history
  const q = (getter) => computeQuantiles(series, getter);

  const commits_effective = pick(latest, "kpi_commits_month", "kpi_commits_month_log");
  const issues_effective = pick(latest, "kpi_new_issues_month", "kpi_new_issues_month_log");
  const prs_effective = pick(latest, "kpi_new_prs_month", "kpi_new_prs_month_log");
  const release_effective = pick(latest, "kpi_release_count_month", "kpi_release_count_month_log");

  const qc = q(d => seriesPick(d, "kpi_commits_month", "kpi_commits_month_log"));
  const qi = q(d => seriesPick(d, "kpi_new_issues_month", "kpi_new_issues_month_log"));
  const qp = q(d => seriesPick(d, "kpi_new_prs_month", "kpi_new_prs_month_log"));
  const qrel = q(d => seriesPick(d, "kpi_release_count_month", "kpi_release_count_month_log"));
  const qac = q(d => seriesPick(d, "kpi_active_contributors_month"));
  const qstars = q(d => seriesPick(d, "kpi_stars_delta_month"));
  const qopen = q(d => seriesPick(d, "kpi_openrank"));

  const qIssueResp = q(d => seriesPick(d, "lat_issue_response_median"));
  const qPrRes = q(d => seriesPick(d, "lat_pr_resolution_median"));
  const qBus = q(d => seriesPick(d, "bus_factor"));
  const qInact = q(d => seriesPick(d, "kpi_inactive_contributors_month"));

  // 如果某个维度输入全部缺失，给中性 50 分（避免被拉到 0）
  const isNum = (x) => typeof x === "number" && !Number.isNaN(x);
  const allMissing = (...xs) => xs.every(x => !isNum(x));

  const s_activity_raw =
    100 * (
      0.5 * scaleByQuantile(commits_effective, qc.p10, qc.p90) +
      0.25 * scaleByQuantile(issues_effective, qi.p10, qi.p90) +
      0.25 * scaleByQuantile(prs_effective, qp.p10, qp.p90)
    );
  const s_activity = allMissing(commits_effective, issues_effective, prs_effective) ? 50 : s_activity_raw;

  const s_responsiveness_raw =
    100 * (
      0.55 * scaleByQuantile(latest.lat_issue_response_median, qIssueResp.p10, qIssueResp.p90, true) +
      0.45 * scaleByQuantile(latest.lat_pr_resolution_median, qPrRes.p10, qPrRes.p90, true)
    );
  const s_responsiveness =
    allMissing(latest.lat_issue_response_median, latest.lat_pr_resolution_median) ? 50 : s_responsiveness_raw;

  const s_contributors_raw =
    100 * (
      0.7 * scaleByQuantile(latest.kpi_active_contributors_month, qac.p10, qac.p90) +
      0.3 * scaleByQuantile(latest.kpi_new_contributors_month, 0, Math.max(1, latest.kpi_new_contributors_month ?? 1))
    );
  const s_contributors =
    allMissing(latest.kpi_active_contributors_month, latest.kpi_new_contributors_month) ? 50 : s_contributors_raw;

  const s_attention_raw =
    100 * (
      0.65 * scaleByQuantile(latest.kpi_stars_delta_month, qstars.p10, qstars.p90) +
      0.35 * scaleByQuantile(latest.kpi_openrank, qopen.p10, qopen.p90)
    );
  const s_attention = allMissing(latest.kpi_stars_delta_month, latest.kpi_openrank) ? 50 : s_attention_raw;

  const s_sustainability_raw =
    100 * (
      0.7 * scaleByQuantile(latest.bus_factor, qBus.p10, qBus.p90) +
      0.3 * scaleByQuantile(latest.kpi_inactive_contributors_month, qInact.p10, qInact.p90, true)
    );
  const s_sustainability =
    allMissing(latest.bus_factor, latest.kpi_inactive_contributors_month) ? 50 : s_sustainability_raw;

  // 额外：发布频率维度（可用于后续扩展；缺失同样给中性 50）
  const s_release =
    100 * scaleByQuantile(release_effective, qrel.p10, qrel.p90);

  const health =
    0.26 * s_activity +
    0.24 * s_responsiveness +
    0.2 * s_contributors +
    0.15 * s_attention +
    0.15 * s_sustainability;

  return {
    dim: {
      activity: Math.round(s_activity),
      responsiveness: Math.round(s_responsiveness),
      contributors: Math.round(s_contributors),
      attention: Math.round(s_attention),
      sustainability: Math.round(s_sustainability),
    },
    health: Math.round(health),
  };
}

function TrendChart({ series }) {
  const months = series.map(d => d.month);
  // Commits 数据不稳定：这里改用 kpi_activity（更通用且覆盖面更好）
  const activity = series.map(d => (d.kpi_activity ?? null));
  const stars = series.map(d => (d.kpi_stars_delta_month ?? null));

  const last = series?.[series.length - 1] ?? {};
  const prev = series?.[series.length - 2] ?? {};
  const lastMonth = last?.month ?? "—";

  const lastAct = typeof last?.kpi_activity === "number" ? last.kpi_activity : null;
  const prevAct = typeof prev?.kpi_activity === "number" ? prev.kpi_activity : null;
  const lastStars = typeof last?.kpi_stars_delta_month === "number" ? last.kpi_stars_delta_month : null;
  const prevStars = typeof prev?.kpi_stars_delta_month === "number" ? prev.kpi_stars_delta_month : null;

  const delta = (a, b) => {
    if (typeof a !== "number" || typeof b !== "number") return null;
    if (b === 0) return null;
    return (a - b) / Math.abs(b);
  };
  const actCh = delta(lastAct, prevAct);
  const starCh = delta(lastStars, prevStars);

  const option = {
    tooltip: { trigger: "axis" },
    legend: { data: ["Activity", "Stars"], textStyle: { color: "#cbd5e1" } },
    grid: { left: 44, right: 20, top: 38, bottom: 34 },
    xAxis: { type: "category", data: months, axisLabel: { color: "#94a3b8" } },
    yAxis: { type: "value", axisLabel: { color: "#94a3b8" }, splitLine: { lineStyle: { color: "rgba(148,163,184,0.15)" } } },
    series: [
      {
        name: "Activity",
        type: "line",
        data: activity,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, color: "#60a5fa" },
        areaStyle: { color: "rgba(96,165,250,0.12)" },
      },
      {
        name: "Stars",
        type: "line",
        data: stars,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, color: "#a3e635" },
        areaStyle: { color: "rgba(163,230,53,0.10)" },
      },
    ],
  };

  const StatPill = ({ label, value, ch, colorClass }) => (
    <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <div className={`text-slate-100 font-semibold tabular-nums ${colorClass}`}>
          {typeof value === "number" && !Number.isNaN(value) ? Math.round(value).toLocaleString() : "—"}
        </div>
        <div className="text-[11px] tabular-nums">
          {typeof ch === "number" ? (
            <span className={ch >= 0 ? "text-emerald-300" : "text-rose-300"}>
              {ch >= 0 ? "▲" : "▼"} {Math.abs(ch * 100).toFixed(0)}%
            </span>
          ) : (
            <span className="text-slate-500">—</span>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="w-full">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-slate-300 text-sm">
          Latest Month: <span className="text-slate-100 font-semibold">{lastMonth}</span>
        </div>
        <div className="text-xs text-slate-500">Area trend (Activity vs Stars)</div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <StatPill label="Activity (latest)" value={lastAct} ch={actCh} colorClass="text-sky-200" />
        <StatPill label="Stars Δ / mo (latest)" value={lastStars} ch={starCh} colorClass="text-lime-200" />
      </div>

      <ReactECharts option={option} style={{ height: 300, width: "100%" }} />
    </div>
  );
}

function ActivityOpenRankChart({ series }) {
  const months = series.map(d => d.month);
  const activity = series.map(d => d.kpi_activity ?? null);
  const openrank = series.map(d => d.kpi_openrank ?? null);

  const option = {
    tooltip: { trigger: "axis" },
    legend: { data: ["Activity", "OpenRank"], textStyle: { color: "#cbd5e1" } },
    grid: { left: 40, right: 20, top: 30, bottom: 30 },
    xAxis: { type: "category", data: months, axisLabel: { color: "#94a3b8" } },
    yAxis: { type: "value", axisLabel: { color: "#94a3b8" }, splitLine: { lineStyle: { color: "rgba(148,163,184,0.15)" } } },
    series: [
      { name: "Activity", type: "line", smooth: true, showSymbol: false, data: activity },
      { name: "OpenRank", type: "line", smooth: true, showSymbol: false, data: openrank },
    ],
  };
  return <ReactECharts option={option} style={{ height: 240 }} />;
}

function ResponsivenessChart({ series }) {
  const months = series.map(d => d.month);
  const issueResp = series.map(d => d.lat_issue_response_median ?? null);
  const prRes = series.map(d => d.lat_pr_resolution_median ?? null);

  const option = {
    tooltip: { trigger: "axis" },
    legend: { textStyle: { color: "#cbd5e1" } },
    grid: { left: 40, right: 20, top: 30, bottom: 30 },
    xAxis: { type: "category", data: months, axisLabel: { color: "#94a3b8" } },
    yAxis: { type: "value", axisLabel: { color: "#94a3b8" }, splitLine: { lineStyle: { color: "rgba(148,163,184,0.15)" } } },
    series: [
      { name: "Issue Response Median (h)", type: "bar", data: issueResp },
      { name: "PR Resolution Median (h)", type: "line", data: prRes, smooth: true, showSymbol: false },
    ],
  };
  return <ReactECharts option={option} style={{ height: 210 }} />;
}

export default function Dashboard({ initialRepo = "" }) {
  const [repos, setRepos] = useState([]);
  const [latestMap, setLatestMap] = useState({});
  const [metaMap, setMetaMap] = useState({});
  const [repo, setRepo] = useState("");

  const [series, setSeries] = useState([]);
  const [report, setReport] = useState("");
  const [loading, setLoading] = useState(false);
  const [reportErr, setReportErr] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [reportV2, setReportV2] = useState(null);
  const [reportStreamText, setReportStreamText] = useState("");

  const [alertsSummary, setAlertsSummary] = useState("");
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsErr, setAlertsErr] = useState("");
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertsV2, setAlertsV2] = useState(null);
  const [alertsStreamText, setAlertsStreamText] = useState("");

  const [introCache, setIntroCache] = useState({}); // { [repo]: { month?: string, intro: string } }
  const [introText, setIntroText] = useState("");
  const [introLoading, setIntroLoading] = useState(false);
  const [introErr, setIntroErr] = useState("");
  const [introOpen, setIntroOpen] = useState(false);

  const API_BASE = (import.meta?.env?.VITE_API_BASE_URL || "http://localhost:8000").replace(/\/$/, "");
  const streamCtrlRef = useRef(null);

  useEffect(() => {
    (async () => {
      const r = await fetch("/data/repos.json").then(res => res.json());
      const l = await fetch("/data/latest.json").then(res => res.json());
      const m = await fetch("/data/repo_meta.json").then(res => res.json());

      const isUsefulRepo = (latestObj) => {
        const commits = (latestObj?.kpi_commits_month ?? latestObj?.kpi_commits_month_log ?? 0);
        const issues = (latestObj?.kpi_new_issues_month ?? latestObj?.kpi_new_issues_month_log ?? 0);
        const prs = (latestObj?.kpi_new_prs_month ?? latestObj?.kpi_new_prs_month_log ?? 0);
        const activity = (latestObj?.kpi_activity ?? 0);
        return (commits + issues + prs + activity) > 0;
      };

      const filtered = (Array.isArray(r) ? r : []).filter(x => isUsefulRepo(l?.[x?.repo_name] ?? {}));
      setRepos(filtered);
      setLatestMap(l);
      setMetaMap(m);
      const first = filtered?.[0]?.repo_name;
      const wanted = typeof initialRepo === "string" ? initialRepo : "";
      const picked = wanted && filtered.some(x => x.repo_name === wanted) ? wanted : first;
      if (picked) setRepo(picked);
    })();
  }, [initialRepo]);

  useEffect(() => {
    if (!repo) return;
    (async () => {
      const file = repo.replace("/", "__");
      const s = await fetch(`/data/timeseries/${file}.json`).then(res => res.json());
      setSeries(s);
    })();
  }, [repo]);

  const latest = latestMap[repo] ?? {};
  const meta = metaMap[repo] ?? {};

  useEffect(() => {
    // repo 切换时清空报告（避免错 repo 的报告残留）
    if (streamCtrlRef.current) {
      try { streamCtrlRef.current.abort(); } catch {}
      streamCtrlRef.current = null;
    }
    setReport("");
    setReportErr("");
    setLoading(false);
    setReportOpen(false);
    setReportV2(null);
    setReportStreamText("");
    setAlertsSummary("");
    setAlertsErr("");
    setAlertsLoading(false);
    setAlertsOpen(false);
    setAlertsV2(null);
    setAlertsStreamText("");
    setIntroText("");
    setIntroErr("");
    setIntroLoading(false);
    setIntroOpen(false);
  }, [repo]);

  useEffect(() => {
    if (!reportOpen && !alertsOpen && !introOpen) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        setReportOpen(false);
        setAlertsOpen(false);
        setIntroOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [reportOpen, alertsOpen, introOpen]);

  async function generateReport() {
    try {
      setLoading(true);
      setReport("");
      setReportErr("");
      setReportOpen(true);
      setReportV2(null);
      setReportStreamText("");

      if (streamCtrlRef.current) {
        try { streamCtrlRef.current.abort(); } catch {}
      }
      const ctrl = new AbortController();
      streamCtrlRef.current = ctrl;

      const ruleAlerts = buildRiskAlerts(latest, series);
      let donePayload = "";
      await streamSSEPost(
        `${API_BASE}/api/report_v2/stream`,
        {
          repo_name: repo,
          month: latest?.month ?? null,
          latest,
          meta,
          series: (Array.isArray(series) ? series : []).slice(-6),
          rule_alerts: ruleAlerts,
        },
        {
          signal: ctrl.signal,
          onDelta: (t) => setReportStreamText((prev) => (prev + t).slice(-50000)),
          onError: (t) => setReportErr((prev) => prev || String(t || "Upstream error")),
          onDone: (t) => {
            donePayload = t || "";
          },
        }
      );

      if (donePayload) {
        try {
          setReportV2(JSON.parse(donePayload));
        } catch (e) {
          // fallback: show raw as markdown
          setReport(donePayload);
          setReportErr((prev) => prev || "报告 JSON 解析失败，已回退到原始内容。");
        }
      }

    } catch (e) {
      setReportErr(e?.message ? String(e.message) : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function generateAlertsSummary() {
    try {
      setAlertsLoading(true);
      setAlertsSummary("");
      setAlertsErr("");
      setAlertsOpen(true);
      setAlertsV2(null);
      setAlertsStreamText("");

      if (streamCtrlRef.current) {
        try { streamCtrlRef.current.abort(); } catch {}
      }
      const ctrl = new AbortController();
      streamCtrlRef.current = ctrl;

      const ruleAlerts = buildRiskAlerts(latest, series);

      let donePayload = "";
      await streamSSEPost(
        `${API_BASE}/api/alerts_v2/stream`,
        {
          repo_name: repo,
          month: latest?.month ?? null,
          latest,
          series: (Array.isArray(series) ? series : []).slice(-6),
          rule_alerts: ruleAlerts,
        },
        {
          signal: ctrl.signal,
          onDelta: (t) => setAlertsStreamText((prev) => (prev + t).slice(-50000)),
          onError: (t) => setAlertsErr((prev) => prev || String(t || "Upstream error")),
          onDone: (t) => {
            donePayload = t || "";
          },
        }
      );

      if (donePayload) {
        try {
          setAlertsV2(JSON.parse(donePayload));
        } catch (e) {
          setAlertsSummary(donePayload);
          setAlertsErr((prev) => prev || "预警 JSON 解析失败，已回退到原始内容。");
        }
      }
    } catch (e) {
      setAlertsErr(e?.message ? String(e.message) : String(e));
    } finally {
      setAlertsLoading(false);
    }
  }

  async function fetchIntro({ openModal }) {
    if (!repo) return;

    // cache hit
    const cached = introCache?.[repo];
    if (cached?.intro && (!latest?.month || cached?.month === latest?.month)) {
      setIntroText(cached.intro);
      setIntroErr("");
      if (openModal) setIntroOpen(true);
      return;
    }

    try {
      setIntroLoading(true);
      setIntroErr("");
      if (openModal) setIntroOpen(true);

      const res = await fetch("http://localhost:8000/api/intro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_name: repo,
          month: latest?.month ?? null,
          meta,
          latest,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.detail || `HTTP ${res.status}`;
        throw new Error(msg);
      }

      const text = (data.intro || "").toString();
      setIntroText(text);
      setIntroCache((prev) => ({ ...(prev || {}), [repo]: { month: latest?.month, intro: text } }));
    } catch (e) {
      setIntroErr(e?.message ? String(e.message) : String(e));
    } finally {
      setIntroLoading(false);
    }
  }

  const scores = useMemo(() => {
    // 恢复之前的前端计算逻辑（基于 repo 自身历史分位数做归一化）
    if (!series.length) return { health: null, dim: {} };
    return buildTempScores(latest, series);
  }, [latest, series]);

  const alerts = useMemo(() => buildRiskAlerts(latest, series), [latest, series]);

  // 切换 repo 后预取一次简介（不会弹窗），保证“随切随有”但不打扰用户
  useEffect(() => {
    if (!repo) return;
    const t = setTimeout(() => {
      fetchIntro({ openModal: false });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  // KPI trend helper for cards (compare last vs prev month; fallback to neutral)
  const cardTrend = (key, fallbackKey) => {
    const prev = series?.[series.length - 2];
    const curr = series?.[series.length - 1];
    const pv = seriesPick(prev, key, fallbackKey);
    const cv = seriesPick(curr, key, fallbackKey);
    if (typeof pv === "number" && typeof cv === "number") return cv >= pv ? "up" : "down";
    return "up";
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="max-w-[1400px] mx-auto px-4 py-4">
        {/* Header */}
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/40 px-6 py-4 text-center text-2xl font-semibold tracking-wide shadow-[0_0_60px_rgba(59,130,246,0.08)]">
          OpenPulse — Project Health Monitoring and Governance Decision Support Platform
        </div>

          {/* Report modal */}
        {reportOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onMouseDown={() => setReportOpen(false)}
          >
            <div
              className="w-full max-w-3xl max-h-[90vh] rounded-2xl border border-slate-700/60 bg-slate-950 shadow-[0_0_80px_rgba(59,130,246,0.12)] flex flex-col"
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-slate-700/50 px-5 py-4">
                <div>
                  <div className="text-slate-100 font-semibold">Agent-Generated Project Analysis Report</div>
                  <div className="text-slate-400 text-sm mt-1">
                    Repo: <span className="text-slate-200">{repo || "—"}</span>
                    {"  "} | {"  "}Month: <span className="text-slate-200">{latest?.month ?? "—"}</span>
                  </div>
                </div>
                <button
                  className="h-9 w-9 rounded-lg bg-slate-900/60 hover:bg-slate-800/60 border border-slate-700/50 text-slate-200"
                  onClick={() => setReportOpen(false)}
                  aria-label="Close"
                  title="Close"
                >
                  ×
                </button>
              </div>

              <div className="px-5 py-4 flex-1 overflow-y-auto">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-slate-300 text-sm">
                    Overall Health Score: <span className="text-slate-100 font-semibold">{scores.health ?? "—"}</span>
                  </div>
                  <button
                    onClick={generateReport}
                    disabled={loading || !repo}
                    className={`px-3 py-2 rounded-lg text-white text-sm ${
                      loading || !repo
                        ? "bg-slate-700 cursor-not-allowed"
                        : "bg-sky-600 hover:bg-sky-500"
                    }`}
                  >
                    {loading ? "Generating..." : "Regenerate"}
                  </button>
                </div>

                <div className="mt-4 rounded-xl border border-slate-700/50 bg-slate-900/30 p-4">
                  {loading ? (
                    <div className="text-slate-200 text-sm">
                      正在生成报告（流式输出中）…
                      <div className="mt-2 rounded-lg border border-white/10 bg-black/20 p-2 text-xs text-slate-300/90 whitespace-pre-wrap max-h-[22vh] overflow-auto">
                        {reportStreamText || "…"}
                      </div>
                    </div>
                  ) : reportErr ? (
                    <div className="text-rose-300 text-sm whitespace-pre-wrap">Error: {reportErr}</div>
                  ) : reportV2 ? (
                    <div className="space-y-3">
                      <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                        <div className="text-slate-100 font-semibold">{reportV2.title || "项目健康分析报告"}</div>
                        <ul className="mt-2 list-disc pl-5 space-y-1 text-sm text-slate-200/90">
                          {(reportV2.executive_summary || []).slice(0, 8).map((x, i) => <li key={i}>{x}</li>)}
                        </ul>
                        {Array.isArray(reportV2.next_metrics) && reportV2.next_metrics.length ? (
                          <div className="mt-2 text-xs text-slate-400">
                            下一步关注指标：<span className="text-slate-200">{reportV2.next_metrics.join("、")}</span>
                          </div>
                        ) : null}
                      </div>

                      <ComparisonsTable comparisons={reportV2.comparisons} />

                      {/* 复用结构化预警视图展示 risks（报告里的 why_* 字段不存在） */}
                      <StructuredAlertsView
                        data={{
                          summary: (reportV2.executive_summary || [])[0] || "",
                          comparisons: reportV2.comparisons,
                          risks: reportV2.risks || [],
                          next_metrics: reportV2.next_metrics || [],
                          why_triggered: [],
                          why_not_triggered: [],
                        }}
                        showComparisons={false}
                      />
                    </div>
                  ) : report ? (
                    <MarkdownBlock text={report} />
                  ) : (
                    <div className="text-slate-400 text-sm">
                      Click “Regenerate” to generate a report.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : null}

          {/* Alerts modal */}
          {alertsOpen ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
              onMouseDown={() => setAlertsOpen(false)}
            >
              <div
                className="w-full max-w-3xl max-h-[90vh] rounded-2xl border border-slate-700/60 bg-slate-950 shadow-[0_0_80px_rgba(59,130,246,0.12)] flex flex-col"
                onMouseDown={(e) => e.stopPropagation()}
                onWheel={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between border-b border-slate-700/50 px-5 py-4">
                  <div>
                    <div className="text-slate-100 font-semibold">AI Risk Alerts Summary</div>
                    <div className="text-slate-400 text-sm mt-1">
                      Repo: <span className="text-slate-200">{repo || "—"}</span>
                      {"  "} | {"  "}Month: <span className="text-slate-200">{latest?.month ?? "—"}</span>
                    </div>
                  </div>
                  <button
                    className="h-9 w-9 rounded-lg bg-slate-900/60 hover:bg-slate-800/60 border border-slate-700/50 text-slate-200"
                    onClick={() => setAlertsOpen(false)}
                    aria-label="Close"
                    title="Close"
                  >
                    ×
                  </button>
                </div>

                <div className="px-5 py-4 flex-1 overflow-y-auto">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-slate-300 text-sm">
                      Rule Alerts: <span className="text-slate-100 font-semibold">{alerts.length}</span>
                    </div>
                    <button
                      onClick={generateAlertsSummary}
                      disabled={alertsLoading || !repo}
                      className={`px-3 py-2 rounded-lg text-white text-sm ${
                        alertsLoading || !repo
                          ? "bg-slate-700 cursor-not-allowed"
                          : "bg-sky-600 hover:bg-sky-500"
                      }`}
                    >
                      {alertsLoading ? "Generating..." : "Regenerate"}
                    </button>
                  </div>

                  <div className="mt-4 rounded-xl border border-slate-700/50 bg-slate-900/30 p-4">
                    {alertsLoading ? (
                      <div className="text-slate-200 text-sm">
                        正在生成预警摘要（流式输出中）…
                        <div className="mt-2 rounded-lg border border-white/10 bg-black/20 p-2 text-xs text-slate-300/90 whitespace-pre-wrap max-h-[22vh] overflow-auto">
                          {alertsStreamText || "…"}
                        </div>
                      </div>
                    ) : alertsErr ? (
                      <div className="text-rose-300 text-sm whitespace-pre-wrap">Error: {alertsErr}</div>
                    ) : alertsV2 ? (
                      <StructuredAlertsView data={alertsV2} />
                    ) : alertsSummary ? (
                      <MarkdownBlock text={alertsSummary} />
                    ) : (
                      <div className="text-slate-400 text-sm">
                        Click “Regenerate” to generate an AI summary from rule-based alerts.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* Intro modal */}
          {introOpen ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
              onMouseDown={() => setIntroOpen(false)}
            >
              <div
                className="w-full max-w-2xl rounded-2xl border border-slate-700/60 bg-slate-950 shadow-[0_0_80px_rgba(59,130,246,0.12)]"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between border-b border-slate-700/50 px-5 py-4">
                  <div>
                    <div className="text-slate-100 font-semibold">项目简介</div>
                    <div className="text-slate-400 text-sm mt-1">
                      Repo: <span className="text-slate-200">{repo || "—"}</span>
                      {"  "} | {"  "}Month: <span className="text-slate-200">{latest?.month ?? "—"}</span>
                    </div>
                  </div>
                  <button
                    className="h-9 w-9 rounded-lg bg-slate-900/60 hover:bg-slate-800/60 border border-slate-700/50 text-slate-200"
                    onClick={() => setIntroOpen(false)}
                    aria-label="Close"
                    title="Close"
                  >
                    ×
                  </button>
                </div>

                <div className="px-5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-slate-300 text-sm">
                      简介由模型生成，可能需要几秒。
                    </div>
                    <button
                      onClick={() => fetchIntro({ openModal: true })}
                      disabled={introLoading || !repo}
                      className={`px-3 py-2 rounded-lg text-white text-sm ${
                        introLoading || !repo
                          ? "bg-slate-700 cursor-not-allowed"
                          : "bg-sky-600 hover:bg-sky-500"
                      }`}
                    >
                      {introLoading ? "Generating..." : "Regenerate"}
                    </button>
                  </div>

                  <div className="mt-4 rounded-xl border border-slate-700/50 bg-slate-900/30 p-4">
                    {introLoading && !introText ? (
                      <div className="text-slate-200 text-sm">Generating intro...</div>
                    ) : introErr ? (
                      <div className="text-rose-300 text-sm whitespace-pre-wrap">Error: {introErr}</div>
                    ) : introText ? (
                      <MarkdownBlock text={introText} className="max-h-[60vh]" />
                    ) : (
                      <div className="text-slate-400 text-sm">
                        点击 “Regenerate” 生成项目简介。
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

        {/* Main grid */}
        <div className="mt-4 grid grid-cols-12 gap-4">
          {/* Row 1: repo + kpis + alerts */}
          <Panel title="OpenPulse" className="col-span-12 lg:col-span-3" compact>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-slate-200 font-semibold truncate">{repo}</div>
                <button
                  type="button"
                  className="shrink-0 px-3 py-1.5 rounded-lg text-white text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700/60"
                  onClick={() => fetchIntro({ openModal: true })}
                  title="查看项目简介（点击后可生成/刷新）"
                >
                  项目简介
                </button>
              </div>

              {meta?.repo_description ? (
                <div className="text-slate-400 text-sm line-clamp-3">{meta.repo_description}</div>
              ) : null}
              {meta?.repo_language ? (
                <div className="text-slate-400 text-sm">Language: {meta.repo_language}</div>
              ) : null}
              {meta?.repo_license ? (
                <div className="text-slate-400 text-sm">License: {meta.repo_license}</div>
              ) : null}
              {latest?.month ? (
                <div className="text-slate-400 text-sm">Last Update: {latest.month}</div>
              ) : null}

              <div className="mt-3">
                <div className="text-slate-300 text-sm mb-2">Select Repo</div>
                <select
                  className="w-full rounded-lg bg-slate-950/60 border border-slate-700/60 px-3 py-2 text-slate-100"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                >
                  {repos.map(r => (
                    <option key={r.repo_name} value={r.repo_name}>{r.repo_name}</option>
                  ))}
                </select>
              </div>
            </div>
          </Panel>

          <div className="col-span-12 lg:col-span-6 grid grid-cols-4 gap-3">
            <StatCard
              label="Activity"
              value={pick(latest, "kpi_activity")}
              trend={cardTrend("kpi_activity")}
              compact
            />
            <StatCard
              label="New Issues"
              value={pick(latest, "kpi_new_issues_month", "kpi_new_issues_month_log")}
              trend={cardTrend("kpi_new_issues_month", "kpi_new_issues_month_log")}
              compact
            />
            <StatCard
              label="Pull Requests"
              value={pick(latest, "kpi_new_prs_month", "kpi_new_prs_month_log")}
              trend={cardTrend("kpi_new_prs_month", "kpi_new_prs_month_log")}
              compact
            />
            <StatCard
              label="Active Contributors"
              value={pick(latest, "kpi_active_contributors_month")}
              trend={cardTrend("kpi_active_contributors_month")}
              compact
            />
          </div>

          <Panel title="" className="col-span-12 lg:col-span-3" compact>
            <div>
              <div className="flex items-center justify-between">
                <div className="text-slate-100 font-semibold">Risk Alerts</div>
                <button
                  onClick={generateAlertsSummary}
                  disabled={alertsLoading || !repo}
                  className={`px-3 py-1.5 rounded-lg text-white text-xs ${
                    alertsLoading || !repo
                      ? "bg-slate-700 cursor-not-allowed"
                      : "bg-sky-600 hover:bg-sky-500"
                  }`}
                  title="Generate AI summary based on rule alerts"
                >
                  {alertsLoading ? "AI..." : "AI 解读"}
                </button>
              </div>
              <div className="mt-3 space-y-2 max-h-[210px] overflow-auto pr-1">
                {alerts.length === 0 ? (
                  <div className="text-slate-400 text-sm">
                    当前未触发风险预警，项目整体状态较为稳健。建议持续关注活跃度、响应时延与关键人风险等指标变化。
                  </div>
                ) : (
                  alerts.map((a) => (
                    <div
                      key={a.id}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="text-slate-200 font-medium">{a.title}</div>
                        <span
                          className={[
                            "text-xs px-2 py-1 rounded-md border tabular-nums",
                            a.level === "high"
                              ? "border-red-500/30 text-red-200 bg-red-500/10"
                              : a.level === "medium"
                              ? "border-orange-500/30 text-orange-200 bg-orange-500/10"
                              : "border-yellow-500/30 text-yellow-200 bg-yellow-500/10",
                          ].join(" ")}
                        >
                          {a.level.toUpperCase()}
                        </span>
                      </div>
                      <div className="mt-1 text-sm text-slate-300 leading-relaxed">{a.detail}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </Panel>

          {/* Row 2: health + trend */}
          <Panel title="" className="col-span-12 lg:col-span-4">
            <HealthGauge score={scores.health} dims={scores.dim} />
          </Panel>

          <Panel title="Activity & Stars Trend" className="col-span-12 lg:col-span-8">
            <TrendChart series={series} />
          </Panel>

          {/* Row 3: mini trend + responsiveness + report */}
          <Panel title="Activity & OpenRank Trends" className="col-span-12 lg:col-span-4">
            <ActivityOpenRankChart series={series} />
          </Panel>

          <Panel title="Responsiveness Analysis" className="col-span-12 lg:col-span-5">
            <ResponsivenessChart series={series} />
            <div className="mt-2 text-slate-300 text-sm">
              Issue Response Median: <b>{latest.lat_issue_response_median ?? "—"}</b> h &nbsp;&nbsp;|&nbsp;&nbsp;
              PR Resolution Median: <b>{latest.lat_pr_resolution_median ?? "—"}</b> h
            </div>
          </Panel>

          <Panel title="Agent-Generated Project Analysis Report" className="col-span-12 lg:col-span-3">
            <div className="flex items-center justify-between">
              <div className="text-slate-300 text-sm">Month: {latest.month ?? "—"}</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={generateReport}
                  disabled={loading || !repo}
                  className={`px-3 py-2 rounded-lg text-white text-sm ${
                    loading || !repo
                      ? "bg-slate-700 cursor-not-allowed"
                      : "bg-sky-600 hover:bg-sky-500"
                  }`}
                >
                  {loading ? "Generating..." : "Generate"}
                </button>
                <button
                  onClick={() => setReportOpen(true)}
                  disabled={!report && !loading && !reportErr}
                  className={`px-3 py-2 rounded-lg text-white text-sm ${
                    report || loading || reportErr
                      ? "bg-slate-800 hover:bg-slate-700"
                      : "bg-slate-700 cursor-not-allowed"
                  }`}
                >
                  View
                </button>
              </div>
            </div>

            <div className="mt-3 rounded-lg border border-slate-700/50 bg-slate-950/30 p-3">
              <div className="text-slate-200 font-semibold">
                Overall Health Score: {scores.health ?? "—"}
              </div>
              <div className="mt-2 text-slate-400 text-sm">
                {loading
                  ? "Generating report..."
                  : reportErr
                    ? "Report generation failed. Click “View” to see details."
                    : report
                      ? "Report generated. Click “View” to open."
                      : "Click “Generate” to create a report."}
              </div>
            </div>
          </Panel>

          {/* Footer row */}
          <div className="col-span-12 grid grid-cols-12 gap-4">
            <Panel className="col-span-12 lg:col-span-6">
              <div className="flex items-center justify-between">
                <div className="text-slate-300">OpenRank</div>
                <div className="text-slate-100 font-bold text-xl">
                  {typeof latest?.kpi_openrank === "number" && !Number.isNaN(latest.kpi_openrank)
                    ? latest.kpi_openrank.toFixed(2)
                    : "—"}
                </div>
              </div>
            </Panel>
            <Panel className="col-span-12 lg:col-span-6">
              <div className="flex items-center justify-between">
                <div className="text-slate-300">Code Changes</div>
                <div className="text-slate-100 font-bold text-xl">
                  {pick(latest, "kpi_code_change_lines_month", "kpi_code_change_lines_month_log") ?? "—"} Lines / Mo
                </div>
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
