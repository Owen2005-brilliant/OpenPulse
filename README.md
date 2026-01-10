# OpenPulse（2025 OpenSODA）

OpenPulse 是一个面向开源仓库的**健康度监测与治理决策支持**大屏：基于开源行为数据构建指标体系与健康度评分，提供趋势分析、规则预警，并可选接入 LLM 生成“项目简介 / 风险摘要 / 健康报告”。

---

## 项目内容与目标

- **面向对象**：GitHub 开源仓库（Top repos 数据集）
- **核心产出**：
  - **健康度总分** + 维度分（活跃度 / 响应效率 / 贡献结构 / 关注度 / 可持续性）
  - **趋势看板**（时序曲线、对比、KPI 卡片）
  - **规则预警**（可解释、可复现）
---

## 整体结构（架构与数据流）

```text
Raw dataset (data/)
  ├─ top_300_metrics/.../*.json        # 指标文件（按 repo 组织）
  └─ top300_20_23log/*.txt             # 事件日志（巨文件）
          |
          v
scripts/openpulse_etl.py               # 解析指标 + DuckDB 聚合日志 -> parquet 产物
          |
          v
data/openpulse_processed/*.parquet     # repo_meta / repo_month_kpi / ...
          |
          +--> scripts/healthscore.py  # 写回 health_score，并保存归一化 stats
          |
          +--> scripts/export_dashboard_json.py
                  |
                  v
frontend/public/data/*.json            # 前端直接 fetch 的数据（repos/latest/meta/timeseries）
                  |
                  v
frontend (Vite + React + ECharts)      # 大屏展示 + 本地规则引擎 riskRules
                  |
                  v (optional)
backend (FastAPI + OpenAI SDK)         # /api/intro /api/alerts /api/report (Markdown)
```

---

## 目录结构说明

```text
.
├─ backend/                         # FastAPI 后端：AI 文案/报告/预警接口（支持兜底）
│  ├─ app.py
│  └─ requirements.txt
├─ frontend/                        # 前端大屏（Vite + React + Tailwind + ECharts）
│  ├─ public/data/                  # 静态数据（由脚本导出，前端直接 fetch）
│  ├─ src/
│  │  ├─ pages/
│  │  │  ├─ Home.tsx               # 入口页：选择仓库 + Globe
│  │  │  └─ Dashboard.jsx          # 核心看板：指标、图表、弹窗、健康度、预警
│  │  ├─ components/               # 组件：Globe、HealthGauge 等
│  │  └─ lib/riskRules.ts          # 规则预警引擎（基于近 6 个月序列）
│  └─ package.json
├─ scripts/                         # 数据 ETL / 打分 / 导出脚本
│  ├─ openpulse_etl.py              # 指标解析 + 日志聚合 + 合并产出 parquet/jsonl
│  ├─ healthscore.py                # 维度分/总分计算，写回 repo_month_kpi.parquet
│  └─ export_dashboard_json.py       # 导出前端所需的 repos/latest/meta/timeseries JSON
├─ data/
│  ├─ openpulse_processed/          # ETL 产物（parquet/jsonl/json）
│  ├─ top_300_metrics/              # 原始指标（海量 json，按 repo 组织）
│  └─ top300_20_23log/              # 原始日志 txt
└─ PPT/                             # 汇报材料
```

---

## 创新点与亮点

### 1) 原创指标体系构建：从“行为数据”到“可解释健康度”

- **原创维度框架**：将开源项目健康拆解为 5 个维度（活跃度 / 响应效率 / 贡献结构 / 关注度与影响力 / 可持续性），既覆盖“产出”，也覆盖“组织协作效率”和“抗风险能力”。
- **统一口径的 KPI 映射**：在 `scripts/openpulse_etl.py` 中把离散的指标 JSON 与超大事件日志按“repo-month”聚合对齐，形成可复现的 KPI 表（`repo_month_kpi.parquet`），避免“各说各话”的指标口径漂移。
- **可解释的打分机制**：`scripts/healthscore.py` 计算维度分与总分（`health_score`），并输出归一化统计用于解释与复用（`health_norm_stats.json`）。

### 2) 基于 Agent 的项目健康报告与 Alert 信息：从“发现问题”到“给出可执行治理方案”

- **结构化输出，便于渲染与评审阅读**：后端优先产出结构化 JSON（sections/risks/actions/evidence/next_metrics），前端做卡片化渲染，保证风格统一、信息密度高、可高亮严重等级。
- **时间窗口对比 + 触发/未触发解释**：将“最近 1 月 / 最近 3 月 vs 前 3 月”等对比口径输出为证据，报告中解释为什么触发（或为什么没触发），让结论可复核。
- **行动建议落到执行层**：每条建议给出负责人/节奏/SLA/成功判据（例如“2 周内将 PR 首响中位数降到 <24h”）。

### 3) “摘要 + 可解释”的双通道预警

- **规则预警（强可解释）**：`frontend/src/lib/riskRules.ts`
  - 使用近 6 个月序列，对“活跃度下滑、PR 响应/解决变慢、Bus Factor 风险、Issue 积压、关注度激增但吞吐未提升”等进行规则判定
  - 输出结构化告警（level/title/detail/metric）
- **AI 摘要（强可读性）**：`backend/app.py` 的 `/api/alerts_v2`
  - 将规则告警 + 最新指标 + 近期序列压缩成 3~5 条可执行建议

### 4) 大屏交互体验为展示场景优化

- 页面使用 Framer Motion 做路由切换与进场动画
- 弹窗内容支持卡片化结构渲染，并保留 Markdown 回退路径，保证稳定性
- 支持 Esc 关闭弹窗、点击遮罩关闭、仓库切换自动清理弹窗状态

---

## 本地运行（推荐顺序）

### 1) 启动后端

```bash
cd backend
python -m pip install -r requirements.txt
set OPENAI_API_KEY=你的key
python -m uvicorn app:app --host 0.0.0.0 --port 8000
```
### 2) 启动前端

```bash
cd frontend
npm install
npm run dev
```
> 需启动后端之后，才能进行报告、alert等内容的agent生成
环境变量配置：
- `OPENAI_API_KEY`：必需（用于 LLM）
- `OPENAI_BASE_URL`：可选（默认 `https://api.openai.com/v1`）
- `OPENAI_MODEL`：可选（默认 `gpt-4o-mini`）

---



