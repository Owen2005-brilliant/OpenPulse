# scripts/healthscore.py
from pathlib import Path
import json
import numpy as np
import pandas as pd

POS = "pos"
NEG = "neg"

DIM_WEIGHTS = {"A": 0.25, "R": 0.25, "C": 0.20, "T": 0.10, "S": 0.20}

# 维度内部权重：先均匀（你后面要改成你们文档里的 w_i 也很方便）
DIM_DEF = {
    "A": [
        ("kpi_activity", POS),
        ("kpi_new_issues_month", POS),
        ("kpi_new_prs_month", POS),
        ("kpi_active_contributors_month", POS),  # 近似 active_dates
    ],
    "R": [
        ("lat_issue_response_median", NEG),
        ("lat_issue_resolution_median", NEG),
        ("lat_pr_response_median", NEG),
        ("lat_pr_resolution_median", NEG),
    ],
    "C": [
        ("kpi_active_contributors_month", POS),  # participants
        ("kpi_new_contributors_month", POS),
        ("kpi_inactive_contributors_month", NEG),
        ("bus_factor", POS),
    ],
    "T": [
        ("kpi_stars_delta_month", POS),
        ("kpi_technical_fork", POS),
        ("kpi_attention", POS),
    ],
    "S": [
        ("kpi_openrank", POS),
        ("kpi_release_count_month", POS),
        ("kpi_code_change_lines_month_abs", POS),
    ],
}

def safe_minmax(x, vmin, vmax):
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return 0.5
    if vmax <= vmin:
        return 0.5
    y = (x - vmin) / (vmax - vmin)
    return float(np.clip(y, 0.0, 1.0))

def compute_stats(df, cols):
    stats = {}
    for c in cols:
        s = df[c]
        s = s.replace([np.inf, -np.inf], np.nan).dropna()
        if len(s) == 0:
            stats[c] = {"min": 0.0, "max": 1.0}
        else:
            stats[c] = {"min": float(s.min()), "max": float(s.max())}
    return stats

def compute_scores(df, stats):
    # 预处理：绝对变更行数
    if "kpi_code_change_lines_month" in df.columns:
        df["kpi_code_change_lines_month_abs"] = df["kpi_code_change_lines_month"].abs()
    else:
        df["kpi_code_change_lines_month_abs"] = np.nan

    # release fallback（如果你有 *_log，就在这里补）
    if "kpi_release_count_month" not in df.columns and "kpi_release_count_month_log" in df.columns:
        df["kpi_release_count_month"] = df["kpi_release_count_month_log"]

    # 维度分
    for dim, items in DIM_DEF.items():
        w = 1.0 / len(items)
        dim_score = []
        for _, row in df.iterrows():
            acc = 0.0
            for col, sign in items:
                if col not in df.columns:
                    v = 0.5
                else:
                    v = safe_minmax(row[col], stats[col]["min"], stats[col]["max"])
                if sign == NEG:
                    v = 1.0 - v
                acc += w * v
            dim_score.append(acc)
        df[f"score_{dim}"] = dim_score

    # 总分
    df["health_H"] = (
        DIM_WEIGHTS["A"] * df["score_A"]
        + DIM_WEIGHTS["R"] * df["score_R"]
        + DIM_WEIGHTS["C"] * df["score_C"]
        + DIM_WEIGHTS["T"] * df["score_T"]
        + DIM_WEIGHTS["S"] * df["score_S"]
    )
    df["health_score"] = (100.0 * df["health_H"]).clip(0, 100)
    return df

def main():
    out_dir = Path("data/openpulse_processed")
    kpi_path = out_dir / "repo_month_kpi.parquet"
    df = pd.read_parquet(kpi_path)

    # 统一把 NaN/inf 清掉
    df = df.replace([np.inf, -np.inf], np.nan)

    # stats 需要覆盖所有可能用到的列
    all_cols = set()
    for items in DIM_DEF.values():
        for col, _ in items:
            all_cols.add(col)
    # 绝对值列
    all_cols.add("kpi_code_change_lines_month_abs")
    # 确保列存在
    if "kpi_code_change_lines_month" in df.columns:
        df["kpi_code_change_lines_month_abs"] = df["kpi_code_change_lines_month"].abs()

    cols_present = [c for c in all_cols if c in df.columns]
    stats = compute_stats(df, cols_present)

    df2 = compute_scores(df, stats)

    # 写回 parquet
    df2.to_parquet(kpi_path, index=False)

    # 保存归一化 stats，前端也可用
    (out_dir / "health_norm_stats.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("✅ health_score computed & saved into repo_month_kpi.parquet")

if __name__ == "__main__":
    main()
