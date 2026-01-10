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

## 亮点与特点

### 1) “离线可用 + 可解释”的双通道预警

- **规则预警（强可解释）**：`frontend/src/lib/riskRules.ts`
  - 使用近 6 个月序列，对“活跃度下滑、PR 响应/解决变慢、Bus Factor 风险、Issue 积压、关注度激增但吞吐未提升”等进行规则判定
  - 输出结构化告警（level/title/detail/metric），便于 UI 展示与后续解释
- **AI 摘要（强可读性）**：`backend/app.py` 的 `/api/alerts`
  - 将规则告警 + 最新指标 + 近期序列压缩成 3~5 条可执行建议（Markdown）

### 2) 健康度评分同时支持“脚本统一打分”和“前端自适应归一化”

- **脚本打分**：`scripts/healthscore.py`
  - 在 `data/openpulse_processed/repo_month_kpi.parquet` 上计算维度分与总分 `health_score`
  - 保存 `health_norm_stats.json`（min/max）便于复用或解释
- **前端自适应**：`frontend/src/pages/Dashboard.jsx`
  - 基于“该 repo 自身历史”的 p10..p90 分位数做 robust 归一化（减少极值干扰）
  - 若某维度全缺失，使用中性分（50）避免不必要的惩罚

### 3) 数据处理链路清晰、可复现

- `scripts/openpulse_etl.py` 将“指标 json + 事件日志 txt”合并为统一的 repo-month 粒度 KPI 表
- `scripts/export_dashboard_json.py` 将 parquet 直接导出为前端静态 JSON（避免前端/后端读 parquet）
- 前端仅依赖 `/public/data` 即可跑通大屏展示（更适合比赛演示与离线环境）

### 4) 大屏交互体验为展示场景优化

- 页面使用 Framer Motion 做路由切换与进场动画
- 弹窗内容使用 Markdown 渲染（`react-markdown` + `remark-gfm`），并默认不启用 raw HTML，降低 XSS 风险
- 支持 Esc 关闭弹窗、点击遮罩关闭、仓库切换自动清理弹窗状态

---

## 核心实现细节（面向开发者）

### 前端数据约定（`frontend/public/data`）

- `repos.json`：仓库列表（首页下拉）
- `latest.json`：每个仓库**最新月份**的一行指标汇总（Dashboard 顶部 KPI、概览、AI 输入）
- `repo_meta.json`：仓库元信息（语言/描述/许可证/创建时间等）
- `timeseries/{repo}.json`：该仓库按月序列（前端画图、规则预警、趋势对比）
  - 文件名规则：将 `owner/repo` 替换为 `owner__repo.json`

### 后端接口（`backend/app.py`）

后端默认监听 `http://localhost:8000`，供前端在本地开发时直接调用：

- `POST /api/intro`：生成 60~120 字中文简介（Markdown 非必须，纯文本返回）
  - **无 OPENAI_API_KEY**：返回离线兜底简介
- `POST /api/alerts`：生成 3~5 条“近期预警与建议”（Markdown）
  - **无 OPENAI_API_KEY 或上游失败**：返回离线兜底摘要（mode=fallback）
- `POST /api/report`：生成“项目健康分析报告”（Markdown）
  - **注意**：当前实现中缺少 `OPENAI_API_KEY` 会直接报错（用于保证“报告”不误导）

可配置环境变量：

- `OPENAI_API_KEY`：必需（用于 LLM）
- `OPENAI_BASE_URL`：可选（默认 `https://api.openai.com/v1`）
- `OPENAI_MODEL`：可选（默认 `gpt-4o-mini`）

### ETL（`scripts/openpulse_etl.py`）

- 从 `top_300_metrics` 中解析多种指标文件，映射到统一 KPI 字段
- 用 DuckDB 直接对超大日志文件做月度聚合（commits/issues/prs/releases/代码变更行等），生成 `_log` 后缀列用于补齐
- 产出：
  - `repo_meta.parquet`
  - `log_monthly_agg.parquet`
  - `repo_month_kpi.parquet`
  - `repo_month_evidence.jsonl`（最新月证据：issue 慢响应、PR 慢合并等）

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

---

## 常见问题（FAQ）

### 前端报错：拉不到 `/data/...`

- 确认 `frontend/public/data/` 下已经有 `repos.json / latest.json / repo_meta.json / timeseries/*.json`
- 如果没有，请运行：`python scripts/export_dashboard_json.py`

### 前端生成报告/简介/预警时请求失败

- 前端默认请求 `http://localhost:8000`，请确认后端已启动
- 若你不想启动后端：规则预警与图表仍可使用；AI 文案相关功能会不可用或进入兜底模式

---

## 维护建议（可选）

- 建议在根目录补充 `.gitignore`（避免提交 `node_modules/`、`dist/`、大体积数据产物）
- 若要部署：可将前端 `npm run build` 的产物托管为静态站点；后端部署为单独服务并配置跨域/反向代理


