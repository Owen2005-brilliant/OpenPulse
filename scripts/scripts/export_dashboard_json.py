import json
from pathlib import Path
import pandas as pd
import math

IN_DIR = Path("data/openpulse_processed")
OUT_DIR = Path("frontend/public/data")
TS_DIR = OUT_DIR / "timeseries"

OUT_DIR.mkdir(parents=True, exist_ok=True)
TS_DIR.mkdir(parents=True, exist_ok=True)

kpi = pd.read_parquet(IN_DIR / "repo_month_kpi.parquet")
meta = pd.read_parquet(IN_DIR / "repo_meta.parquet")

# 规范化 month 排序
kpi["month"] = kpi["month"].astype(str)
kpi = kpi.sort_values(["repo_name", "month"])

# 1) repos list
repos = sorted(kpi["repo_name"].dropna().unique().tolist())
(OUT_DIR / "repos.json").write_text(
    json.dumps([{"repo_name": r} for r in repos], ensure_ascii=False, indent=2),
    encoding="utf-8"
)

# 2) latest per repo
latest_rows = kpi.groupby("repo_name", as_index=False).tail(1)
latest_map = {row["repo_name"]: row.dropna().to_dict() for _, row in latest_rows.iterrows()}

(OUT_DIR / "latest.json").write_text(
    json.dumps(latest_map, ensure_ascii=False),
    encoding="utf-8"
)

# 3) meta map
meta_map = {row["repo_name"]: row.dropna().to_dict() for _, row in meta.iterrows()}
(OUT_DIR / "repo_meta.json").write_text(
    json.dumps(meta_map, ensure_ascii=False),
    encoding="utf-8"
)

# 4) timeseries per repo
cols_keep = [
    "month",
    "kpi_commits_month",
    "kpi_commits_month_log",
    "kpi_new_issues_month",
    "kpi_new_issues_month_log",
    "kpi_new_prs_month",
    "kpi_new_prs_month_log",
    "kpi_active_contributors_month",
    "kpi_stars_delta_month",
    "lat_issue_response_median",
    "lat_pr_resolution_median",
    "bus_factor",
    "kpi_release_count_month",
    "kpi_release_count_month_log",
    "kpi_code_change_lines_month",
    "kpi_code_change_lines_month_log",
    "kpi_activity",
    "kpi_openrank",
    "kpi_attention",
]
cols_keep = [c for c in cols_keep if c in kpi.columns]

def clean_value(x):
    # 把 NaN/inf 变成 None，保证 JSON 合法且前端可用
    if x is None:
        return None
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    return x

for repo, g in kpi.groupby("repo_name"):
    # 先选列
    df = g[cols_keep].copy()

    # 关键：把 pandas 的 NaN 统一转成 None
    df = df.where(pd.notnull(df), None)

    # 再做一次保险：把 None/NaN/inf 处理干净
    records = []
    for row in df.to_dict(orient="records"):
        records.append({k: clean_value(v) for k, v in row.items()})

    (TS_DIR / f"{repo.replace('/', '__')}.json").write_text(
        json.dumps(records, ensure_ascii=False),
        encoding="utf-8"
    )

print("[OK] Exported dashboard json to frontend/public/data/")
