from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Dict, Any, List, Optional

import duckdb
import pandas as pd
from tqdm import tqdm

MONTH_RE = re.compile(r"^\d{4}-\d{2}$")

# -----------------------------
# Metrics parsing
# -----------------------------
METRICS_FILE_MAP = {
    # community / sustainability
    "participants.json": "kpi_active_contributors_month",
    "new_contributors.json": "kpi_new_contributors_month",
    "inactive_contributors.json": "kpi_inactive_contributors_month",
    "bus_factor.json": "bus_factor",

    # issues & PR
    "issues_new.json": "kpi_new_issues_month",
    "issues_closed.json": "kpi_closed_issues_month",
    "change_requests.json": "kpi_new_prs_month",
    "change_requests_accepted.json": "kpi_merged_prs_month",

    # activity / impact
    "activity.json": "kpi_activity",
    "openrank.json": "kpi_openrank",
    "attention.json": "kpi_attention",
    "technical_fork.json": "kpi_technical_fork",

    # code changes
    "code_change_lines_sum.json": "kpi_code_change_lines_month",

    # latency
    "issue_response_time.json": "lat_issue_response",
    "issue_resolution_duration.json": "lat_issue_resolution",
    "change_request_response_time.json": "lat_pr_response",
    "change_request_resolution_duration.json": "lat_pr_resolution",

    # stars
    "stars.json": "stars",
}

def safe_read_json(p: Path) -> Any:
    with p.open("r", encoding="utf-8") as f:
        return json.load(f)

def detect_metrics_layout(obj: Any) -> str:
    if isinstance(obj, dict):
        if "avg" in obj and isinstance(obj["avg"], dict):
            return "avg_quantile"
        keys = list(obj.keys())[:5]
        if keys and any(isinstance(k, str) and MONTH_RE.match(k) for k in keys):
            return "series"
    return "unknown"

def parse_metric_file(path: Path) -> Dict[str, Dict[str, float]]:
    obj = safe_read_json(path)
    layout = detect_metrics_layout(obj)
    fname = path.name
    key = METRICS_FILE_MAP.get(fname)
    if key is None:
        return {}

    out: Dict[str, Dict[str, float]] = {}

    # latency (use avg + median)
    if key.startswith("lat_"):
        if layout == "avg_quantile":
            avg = obj.get("avg", {})
            q2 = obj.get("quantile_2", obj.get("quantile_1", {}))
            prefix = key.replace("lat_", "")
            out[f"lat_{prefix}_avg"] = {m: float(v) for m, v in avg.items() if MONTH_RE.match(m)}
            out[f"lat_{prefix}_median"] = {m: float(v) for m, v in q2.items() if MONTH_RE.match(m)}
        elif layout == "series":
            out[f"{key}_avg"] = {m: float(v) for m, v in obj.items() if MONTH_RE.match(m)}
        return out

    # stars: delta + total (if "-raw" exists)
    if fname == "stars.json" and isinstance(obj, dict):
        delta = {m: float(v) for m, v in obj.items() if isinstance(m, str) and MONTH_RE.match(m)}
        if delta:
            out["kpi_stars_delta_month"] = delta
        raw = {}
        for k, v in obj.items():
            if isinstance(k, str) and k.endswith("-raw"):
                m = k[:-4]
                if MONTH_RE.match(m):
                    raw[m] = float(v)
        if raw:
            out["kpi_stars_total"] = raw
        return out

    # general
    if layout == "series":
        out[key] = {m: float(v) for m, v in obj.items() if MONTH_RE.match(m)}
    elif layout == "avg_quantile":
        out[key] = {m: float(v) for m, v in obj.get("avg", {}).items() if MONTH_RE.match(m)}
    return out

def find_repo_dirs(metrics_root: Path) -> List[Path]:
    repo_dirs = []
    for root, _, files in os.walk(metrics_root):
        root_p = Path(root)
        if any(f.endswith(".json") for f in files):
            # heuristic: keep dirs that look like repo folders
            if len(list(root_p.glob("*.json"))) >= 5:
                repo_dirs.append(root_p)
    return sorted(repo_dirs)

def build_metrics_kpi(metrics_root: Path) -> pd.DataFrame:
    repo_dirs = find_repo_dirs(metrics_root)
    rows = []
    for d in tqdm(repo_dirs, desc="Parsing top_300_metrics"):
        repo = d.name
        month_dict: Dict[str, Dict[str, float]] = {}
        for jf in d.glob("*.json"):
            parsed = parse_metric_file(jf)
            for col, series in parsed.items():
                for month, val in series.items():
                    month_dict.setdefault(month, {})
                    month_dict[month][col] = val
        for month, kv in month_dict.items():
            row = {"repo_name": repo, "month": month}
            row.update(kv)
            rows.append(row)

    df = pd.DataFrame(rows)
    if df.empty:
        raise RuntimeError("No metrics parsed. Please check your top_300_metrics folder structure.")
    df["month"] = df["month"].astype(str)
    return df

# -----------------------------
# Log parsing (DuckDB, streaming)
# -----------------------------
def guess_delim_from_first_line(log_file: Path) -> Optional[str]:
    # quick heuristic: choose among tab/comma/pipe
    with log_file.open("r", encoding="utf-8", errors="ignore") as f:
        line = f.readline()
    if not line:
        return None
    candidates = [("\t", line.count("\t")), (",", line.count(",")), ("|", line.count("|"))]
    candidates.sort(key=lambda x: x[1], reverse=True)
    if candidates[0][1] == 0:
        return None
    return candidates[0][0]

def build_repo_meta_from_log(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    # any_value is fine for description/language/license; created_at use min
    return con.execute("""
        SELECT
          repo_name,
          any_value(repo_description) AS repo_description,
          any_value(repo_language) AS repo_language,
          any_value(repo_license) AS repo_license,
          min(repo_created_at) AS repo_created_at
        FROM log
        WHERE repo_name IS NOT NULL
        GROUP BY repo_name
    """).df()

def build_log_monthly_agg(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    return con.execute("""
        WITH base AS (
          SELECT
            repo_name,
            strftime(created_at, '%Y-%m') AS month,
            type, action,
            push_distinct_size,
            pull_merged,
            pull_additions, pull_deletions,
            release_published_at
          FROM log
          WHERE repo_name IS NOT NULL AND created_at IS NOT NULL
        )
        SELECT
          repo_name,
          month,
          SUM(CASE WHEN type='Push' THEN COALESCE(push_distinct_size,0) ELSE 0 END) AS kpi_commits_month_log,
          SUM(CASE WHEN type='Issues' AND action='opened' THEN 1 ELSE 0 END) AS kpi_new_issues_month_log,
          SUM(CASE WHEN type='PullRequest' AND action='opened' THEN 1 ELSE 0 END) AS kpi_new_prs_month_log,
          SUM(CASE WHEN type='Release' AND release_published_at IS NOT NULL THEN 1 ELSE 0 END) AS kpi_release_count_month_log,
          SUM(CASE WHEN type='PullRequest' AND COALESCE(pull_merged,0)=1
                   THEN COALESCE(pull_additions,0)+COALESCE(pull_deletions,0) ELSE 0 END) AS kpi_code_change_lines_month_log
        FROM base
        GROUP BY repo_name, month
    """).df()

def build_evidence_latest_month(con: duckdb.DuckDBPyConnection, out_jsonl: Path, topk: int = 5) -> None:
    """
    Evidence for latest month per repo:
      - slow issue first response (issue_created_at -> first IssueComment time)
      - slow PR merge duration (PR created -> merged_at)

    Notes:
      - Avoid scalar subqueries (DuckDB requires they return exactly one row).
      - Use try_cast(...) to tolerate dirty/heterogeneous datetime strings.
      - Month is carried by JOIN latest_tbl as t.latest_month.
    """
    import json
    import pandas as pd

    # 1) latest month per repo (deduplicated)
    latest = con.execute("""
        SELECT
          repo_name,
          max(strftime(try_cast(created_at AS TIMESTAMP), '%Y-%m')) AS latest_month
        FROM log
        WHERE repo_name IS NOT NULL AND try_cast(created_at AS TIMESTAMP) IS NOT NULL
        GROUP BY repo_name
    """).df()
    latest = latest.dropna(subset=["repo_name", "latest_month"]).drop_duplicates(subset=["repo_name"])
    con.register("latest_tbl", latest)

    # -----------------------------
    # 2) Issue slow response evidence
    # -----------------------------
    issue_evd = con.execute(r"""
      WITH issue_base AS (
        SELECT
          l.repo_name,
          t.latest_month AS month,
          l.issue_id,
          any_value(l.issue_number) AS issue_number,
          any_value(l.issue_title) AS issue_title,
          any_value(l.issue_author_id) AS issue_author_id,
          min(try_cast(l.issue_created_at AS TIMESTAMP)) AS issue_created_at
        FROM log l
        JOIN latest_tbl t
          ON l.repo_name = t.repo_name
         AND strftime(try_cast(l.created_at AS TIMESTAMP), '%Y-%m') = t.latest_month
        WHERE l.issue_id IS NOT NULL
          AND try_cast(l.issue_created_at AS TIMESTAMP) IS NOT NULL
        GROUP BY l.repo_name, t.latest_month, l.issue_id
      ),
      first_comment AS (
        SELECT
          l.repo_name,
          l.issue_id,
          min(try_cast(l.issue_comment_created_at AS TIMESTAMP)) AS first_comment_at
        FROM log l
        JOIN latest_tbl t
          ON l.repo_name = t.repo_name
         AND strftime(try_cast(l.created_at AS TIMESTAMP), '%Y-%m') = t.latest_month
        WHERE l.type = 'IssueComment'
          AND l.issue_id IS NOT NULL
          AND try_cast(l.issue_comment_created_at AS TIMESTAMP) IS NOT NULL
          AND l.issue_comment_author_id IS NOT NULL
        GROUP BY l.repo_name, l.issue_id
      )
      SELECT
        i.repo_name,
        i.month,
        i.issue_id,
        i.issue_number,
        i.issue_title,
        i.issue_created_at,
        c.first_comment_at,
        date_diff('minute', i.issue_created_at, c.first_comment_at) / 60.0 AS response_hours
      FROM issue_base i
      JOIN first_comment c
        ON i.repo_name = c.repo_name AND i.issue_id = c.issue_id
      WHERE c.first_comment_at >= i.issue_created_at
      ORDER BY response_hours DESC
    """).df()

    # -----------------------------
    # 3) PR slow merge evidence
    # -----------------------------
    pr_evd = con.execute(r"""
      WITH pr_base AS (
        SELECT
          l.repo_name,
          t.latest_month AS month,
          l.issue_id,
          any_value(l.issue_number) AS pr_number,
          any_value(l.issue_title) AS pr_title,
          min(try_cast(l.issue_created_at AS TIMESTAMP)) AS pr_created_at,
          max(try_cast(l.pull_merged_at AS TIMESTAMP)) AS pr_merged_at,
          any_value(l.pull_additions) AS pull_additions,
          any_value(l.pull_deletions) AS pull_deletions
        FROM log l
        JOIN latest_tbl t
          ON l.repo_name = t.repo_name
         AND strftime(try_cast(l.created_at AS TIMESTAMP), '%Y-%m') = t.latest_month
        WHERE l.type = 'PullRequest'
          AND l.issue_id IS NOT NULL
          AND try_cast(l.issue_created_at AS TIMESTAMP) IS NOT NULL
          AND COALESCE(l.pull_merged, 0) = 1
          AND try_cast(l.pull_merged_at AS TIMESTAMP) IS NOT NULL
        GROUP BY l.repo_name, t.latest_month, l.issue_id
      )
      SELECT
        repo_name,
        month,
        issue_id,
        pr_number,
        pr_title,
        pr_created_at,
        pr_merged_at,
        date_diff('minute', pr_created_at, pr_merged_at) / 60.0 AS merge_hours,
        COALESCE(pull_additions, 0) + COALESCE(pull_deletions, 0) AS change_lines
      FROM pr_base
      WHERE pr_merged_at >= pr_created_at
      ORDER BY merge_hours DESC
    """).df()

    # -----------------------------
    # 4) Write jsonl: keep topk per repo for each evidence type
    # -----------------------------
    out_jsonl.parent.mkdir(parents=True, exist_ok=True)
    with out_jsonl.open("w", encoding="utf-8") as f:
        if not issue_evd.empty:
            for repo, g in issue_evd.groupby("repo_name"):
                for _, r in g.head(topk).iterrows():
                    f.write(json.dumps({
                        "repo_name": r["repo_name"],
                        "month": r["month"],
                        "evidence_type": "issue_slow_response",
                        "entity_type": "issue",
                        "issue_id": int(r["issue_id"]),
                        "issue_number": int(r["issue_number"]) if pd.notna(r["issue_number"]) else None,
                        "issue_title": r["issue_title"],
                        "issue_created_at": str(r["issue_created_at"]),
                        "first_comment_at": str(r["first_comment_at"]),
                        "response_hours": float(r["response_hours"]),
                    }, ensure_ascii=False) + "\n")

        if not pr_evd.empty:
            for repo, g in pr_evd.groupby("repo_name"):
                for _, r in g.head(topk).iterrows():
                    f.write(json.dumps({
                        "repo_name": r["repo_name"],
                        "month": r["month"],
                        "evidence_type": "pr_slow_merge",
                        "entity_type": "pull_request",
                        "issue_id": int(r["issue_id"]),
                        "pr_number": int(r["pr_number"]) if pd.notna(r["pr_number"]) else None,
                        "pr_title": r["pr_title"],
                        "pr_created_at": str(r["pr_created_at"]),
                        "pr_merged_at": str(r["pr_merged_at"]),
                        "merge_hours": float(r["merge_hours"]),
                        "change_lines": int(r["change_lines"]) if pd.notna(r["change_lines"]) else None,
                    }, ensure_ascii=False) + "\n")

# -----------------------------
# Main pipeline
# -----------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--metrics_dir", type=str, required=True, help="Path to extracted top_300_metrics folder")
    ap.add_argument("--log_file", type=str, required=True, help="Path to top300_20_23_1681699961594.txt")
    ap.add_argument("--out_dir", type=str, required=True, help="Output folder")
    ap.add_argument("--log_delim", type=str, default=None, help="Optional: delimiter for log file, e.g. '\\t' or ','")
    ap.add_argument("--skip_evidence", action="store_true", help="Skip generating evidence jsonl")
    args = ap.parse_args()

    metrics_dir = Path(args.metrics_dir)
    log_file = Path(args.log_file)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1) metrics -> partial kpi table
    metrics_df = build_metrics_kpi(metrics_dir)

    # 2) log -> duckdb view
    delim = args.log_delim
    if delim is None:
        delim = guess_delim_from_first_line(log_file)

    delim_clause = f", delim='{delim}'" if delim else ""
    con = duckdb.connect(database=":memory:")

    # Important: increase sample_size for better type inference on huge files
    con.execute(f"""
      CREATE VIEW log AS
      SELECT *
      FROM read_csv_auto(
        '{str(log_file).replace("'", "''")}',
        header=True,
        sample_size=1000000,
        ignore_errors=true
        {delim_clause}
      )
    """)

    # 3) repo_meta
    meta_df = build_repo_meta_from_log(con)
    meta_df.to_parquet(out_dir / "repo_meta.parquet", index=False)

    # 4) log monthly aggregate
    log_monthly_df = build_log_monthly_agg(con)
    log_monthly_df.to_parquet(out_dir / "log_monthly_agg.parquet", index=False)

    # 5) merge metrics + log monthly
    kpi = pd.merge(metrics_df, log_monthly_df, on=["repo_name", "month"], how="outer")

    # fill: prefer metrics if exists, else use log-derived
    def coalesce(a, b):
        return a.where(~a.isna(), b)

    if "kpi_new_issues_month" in kpi.columns and "kpi_new_issues_month_log" in kpi.columns:
        kpi["kpi_new_issues_month"] = coalesce(kpi["kpi_new_issues_month"], kpi["kpi_new_issues_month_log"])
    if "kpi_new_prs_month" in kpi.columns and "kpi_new_prs_month_log" in kpi.columns:
        kpi["kpi_new_prs_month"] = coalesce(kpi["kpi_new_prs_month"], kpi["kpi_new_prs_month_log"])
    if "kpi_code_change_lines_month" in kpi.columns and "kpi_code_change_lines_month_log" in kpi.columns:
        kpi["kpi_code_change_lines_month"] = coalesce(kpi["kpi_code_change_lines_month"], kpi["kpi_code_change_lines_month_log"])

    # commits / releases are often not in metrics; use log
    if "kpi_commits_month" not in kpi.columns:
        kpi["kpi_commits_month"] = kpi.get("kpi_commits_month_log")
    else:
        kpi["kpi_commits_month"] = coalesce(kpi["kpi_commits_month"], kpi.get("kpi_commits_month_log"))

    if "kpi_release_count_month" not in kpi.columns:
        kpi["kpi_release_count_month"] = kpi.get("kpi_release_count_month_log")
    else:
        kpi["kpi_release_count_month"] = coalesce(kpi["kpi_release_count_month"], kpi.get("kpi_release_count_month_log"))

    # drop helper columns
    for c in [c for c in kpi.columns if c.endswith("_log")]:
        pass  # keep them if you want debugging; otherwise drop
    # kpi.drop(columns=[c for c in kpi.columns if c.endswith("_log")], inplace=True, errors="ignore")

    # 6) save main table
    kpi.to_parquet(out_dir / "repo_month_kpi.parquet", index=False)

    # 7) evidence (optional)
    if not args.skip_evidence:
        build_evidence_latest_month(con, out_dir / "repo_month_evidence.jsonl", topk=5)

    print(f"[OK] Written to: {out_dir}")
    print(" - repo_meta.parquet")
    print(" - repo_month_kpi.parquet")
    if not args.skip_evidence:
        print(" - repo_month_evidence.jsonl")


if __name__ == "__main__":
    main()
