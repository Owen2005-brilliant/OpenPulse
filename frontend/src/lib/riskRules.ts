export type Row = Record<string, any>;

function num(x: any): number | null {
  return typeof x === "number" && !Number.isNaN(x) ? x : null;
}

function avg(arr: (number | null)[]) {
  const v = arr.filter((x): x is number => x !== null);
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function pctChange(now: number, prev: number) {
  if (prev === 0) return null;
  return (now - prev) / prev;
}

function quantile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

function seriesNum(d: Row, key: string, fallbackKey?: string) {
  const v = num(d?.[key]);
  if (v !== null) return v;
  return fallbackKey ? num(d?.[fallbackKey]) : null;
}

export type AlertItem = {
  id: string;
  level: "high" | "medium" | "low";
  title: string;
  detail: string;
  metric?: string;
};

const levelOrder: Record<AlertItem["level"], number> = { high: 3, medium: 2, low: 1 };

export function buildRiskAlerts(latest: Row | null, series: Row[] | null): AlertItem[] {
  const alerts: AlertItem[] = [];
  if (!latest || !series || series.length < 6) return alerts;

  const last6 = series.slice(-6);
  const prev3 = last6.slice(0, 3);
  const now3 = last6.slice(3, 6);

  // ---- A: Activity Decline ----
  const prevAct = avg(prev3.map((d) => seriesNum(d, "kpi_activity")));
  const nowAct = avg(now3.map((d) => seriesNum(d, "kpi_activity")));
  if (prevAct !== null && nowAct !== null) {
    const ch = pctChange(nowAct, prevAct);
    if (ch !== null && ch < -0.3) {
      alerts.push({
        id: "activity_decline",
        level: "medium",
        title: "Activity Decline Detected",
        detail: `Last 3 months activity dropped ${(Math.abs(ch) * 100).toFixed(0)}% vs previous 3 months.`,
        metric: "kpi_activity",
      });
    }
  }

  const prevPR = avg(prev3.map((d) => seriesNum(d, "kpi_new_prs_month", "kpi_new_prs_month_log")));
  const nowPR = avg(now3.map((d) => seriesNum(d, "kpi_new_prs_month", "kpi_new_prs_month_log")));
  const prevIssues = avg(prev3.map((d) => seriesNum(d, "kpi_new_issues_month", "kpi_new_issues_month_log")));
  const nowIssues = avg(now3.map((d) => seriesNum(d, "kpi_new_issues_month", "kpi_new_issues_month_log")));
  if (prevPR !== null && nowPR !== null && prevIssues !== null && nowIssues !== null) {
    const chPR = pctChange(nowPR, prevPR);
    const chI = pctChange(nowIssues, prevIssues);
    if (chPR !== null && chI !== null && chPR < -0.3 && chI < -0.3) {
      alerts.push({
        id: "throughput_drop",
        level: "low",
        title: "Throughput Decline",
        detail: `New PRs and issues dropped notably in last 3 months (PR ${(Math.abs(chPR) * 100).toFixed(0)}%, Issues ${(Math.abs(chI) * 100).toFixed(0)}%).`,
        metric: "kpi_new_prs_month/kpi_new_issues_month",
      });
    }
  }

  // ---- B: PR Response/Resolution Slowdown ----
  const prevPrResp = avg(prev3.map((d) => seriesNum(d, "lat_pr_response_median")));
  const nowPrResp = avg(now3.map((d) => seriesNum(d, "lat_pr_response_median")));
  if (prevPrResp !== null && nowPrResp !== null) {
    const ch = pctChange(nowPrResp, prevPrResp);
    if ((ch !== null && ch > 0.5) || nowPrResp > 24) {
      alerts.push({
        id: "pr_response_slowdown",
        level: nowPrResp > 72 ? "high" : "medium",
        title: "PR Response Slowdown",
        detail: `PR response median is now ~${nowPrResp.toFixed(1)}h (prev ~${prevPrResp.toFixed(1)}h).`,
        metric: "lat_pr_response_median",
      });
    }
  }

  const prevPrRes = avg(prev3.map((d) => seriesNum(d, "lat_pr_resolution_median")));
  const nowPrRes = avg(now3.map((d) => seriesNum(d, "lat_pr_resolution_median")));
  if (prevPrRes !== null && nowPrRes !== null) {
    const ch = pctChange(nowPrRes, prevPrRes);
    if ((ch !== null && ch > 0.5) || nowPrRes > 48) {
      alerts.push({
        id: "pr_resolution_slowdown",
        level: nowPrRes > 72 ? "high" : "medium",
        title: "PR Resolution Slowdown",
        detail: `PR resolution median is now ~${nowPrRes.toFixed(1)}h (prev ~${prevPrRes.toFixed(1)}h).`,
        metric: "lat_pr_resolution_median",
      });
    }
  }

  // ---- C: Bus Factor Risk ----
  const bf = num(latest.bus_factor);
  if (bf !== null && bf <= 3) {
    const ac = num(latest.kpi_active_contributors_month);
    const level: AlertItem["level"] = bf <= 2 ? "high" : "medium";
    const extra =
      ac !== null && ac <= 5 ? ` Active contributors are also low (${ac}).` : "";
    alerts.push({
      id: "bus_factor",
      level,
      title: "Bus Factor Risk",
      detail: `Bus factor is ${bf}. Project may rely on very few key contributors.${extra}`,
      metric: "bus_factor",
    });
  }

  // ---- D: Issue Backlog Rising ----
  const hasClosed = series.some((d) => num(d?.kpi_closed_issues_month) !== null);
  if (hasClosed) {
    const flags = now3
      .map((d) => {
        const n = seriesNum(d, "kpi_new_issues_month", "kpi_new_issues_month_log");
        const c = num(d?.kpi_closed_issues_month);
        if (n === null || c === null) return null;
        return n > c;
      })
      .filter((x): x is boolean => x !== null);
    if (flags.length === 3 && flags.every(Boolean)) {
      alerts.push({
        id: "issue_backlog",
        level: "medium",
        title: "Issue Backlog Rising",
        detail: "New issues exceeded closed issues for 3 consecutive months. Backlog may be growing.",
        metric: "kpi_new_issues_month/kpi_closed_issues_month",
      });
    }
  } else {
    const prevIssueRes = avg(prev3.map((d) => seriesNum(d, "lat_issue_resolution_median")));
    const nowIssueRes = avg(now3.map((d) => seriesNum(d, "lat_issue_resolution_median")));
    if (prevIssueRes !== null && nowIssueRes !== null) {
      const ch = pctChange(nowIssueRes, prevIssueRes);
      if ((ch !== null && ch > 0.5) || nowIssueRes > 48) {
        alerts.push({
          id: "issue_resolution_slow",
          level: nowIssueRes > 120 ? "high" : "medium",
          title: "Issue Resolution Slowing",
          detail: `Issue resolution median is now ~${nowIssueRes.toFixed(1)}h (prev ~${prevIssueRes.toFixed(1)}h).`,
          metric: "lat_issue_resolution_median",
        });
      }
    }
  }

  // ---- E: Attention Surge w/ Low Throughput ----
  const starsHist = series
    .map((d) => seriesNum(d, "kpi_stars_delta_month"))
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  const attHist = series
    .map((d) => seriesNum(d, "kpi_attention"))
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  const p90Stars = quantile(starsHist, 0.9);
  const p90Att = quantile(attHist, 0.9);

  const nowStars = avg(now3.map((d) => seriesNum(d, "kpi_stars_delta_month")));
  const nowAtt = avg(now3.map((d) => seriesNum(d, "kpi_attention")));
  const lowThroughput =
    (prevAct !== null && nowAct !== null && nowAct <= prevAct * 1.05) ||
    (prevPR !== null && nowPR !== null && nowPR <= prevPR * 1.05);

  const surge =
    (p90Stars !== null && nowStars !== null && nowStars >= p90Stars && nowStars >= 50) ||
    (p90Att !== null && nowAtt !== null && nowAtt >= p90Att);

  if (surge && lowThroughput) {
    alerts.push({
      id: "attention_surge_low_throughput",
      level: "low",
      title: "Attention Surge w/ Low Throughput",
      detail:
        "Attention is surging while throughput hasn’t improved much. Watch maintainer load & triage pressure.",
      metric: "kpi_attention/kpi_stars_delta_month",
    });
  }

  return alerts
    .sort((a, b) => levelOrder[b.level] - levelOrder[a.level])
    .slice(0, 5);
}

