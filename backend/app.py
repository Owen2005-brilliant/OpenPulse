import os
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from openai import OpenAI


app = FastAPI()

# 允许前端本地开发直接访问（Vite 默认 5173）
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ReportReq(BaseModel):
    repo_name: str
    month: str | None = None
    latest: dict[str, Any]  # 前端把 latest 关键指标直接传过来（避免后端读文件）


class AlertsReq(BaseModel):
    repo_name: str
    month: str | None = None
    latest: dict[str, Any]
    series: list[dict[str, Any]] | None = None  # 近期序列（建议 6 个月）
    rule_alerts: list[dict[str, Any]] | None = None  # 前端规则引擎产物（可选）


class IntroReq(BaseModel):
    repo_name: str
    month: str | None = None
    meta: dict[str, Any] | None = None
    latest: dict[str, Any] | None = None


def _num(x: Any) -> float | None:
    if isinstance(x, (int, float)) and not isinstance(x, bool):
        if x != x:  # NaN
            return None
        return float(x)
    return None


def _avg(vals: list[float | None]) -> float | None:
    v = [x for x in vals if x is not None]
    if not v:
        return None
    return sum(v) / len(v)


def _pct_change(now: float | None, prev: float | None) -> float | None:
    if now is None or prev is None:
        return None
    if prev == 0:
        return None
    return (now - prev) / abs(prev)


def _safe_slice_last(series: list[dict[str, Any]] | None, n: int) -> list[dict[str, Any]]:
    s = series or []
    if not isinstance(s, list):
        return []
    return s[-n:] if len(s) > n else s


def _series_metric(row: dict[str, Any], key: str, fallback_key: str | None = None) -> float | None:
    v = _num(row.get(key))
    if v is not None:
        return v
    if fallback_key:
        return _num(row.get(fallback_key))
    return None


def _compute_time_window_comparisons(
    series: list[dict[str, Any]] | None,
    metrics: list[tuple[str, str, str | None]],
) -> dict[str, Any]:
    """
    复用前端 riskRules 的口径：
    - last1：最近 1 个月
    - prev3_avg：最近 1 个月之前的 3 个月均值
    - last3_avg：最近 3 个月均值
    - prev3_before_last3_avg：最近 3 个月之前的 3 个月均值
    """
    s6 = _safe_slice_last(series, 6)
    if len(s6) < 4:
        return {"available": False, "last_month": (s6[-1].get("month") if s6 else None), "items": []}

    last_month = s6[-1].get("month")
    last1 = s6[-1:]
    prev3 = s6[-4:-1]  # 3 months before last1
    last3 = s6[-3:]
    prev3_before_last3 = s6[:3] if len(s6) >= 6 else []

    items: list[dict[str, Any]] = []
    for label, key, fallback in metrics:
        last1_v = _avg([_series_metric(d, key, fallback) for d in last1])
        prev3_v = _avg([_series_metric(d, key, fallback) for d in prev3])
        last3_v = _avg([_series_metric(d, key, fallback) for d in last3])
        prev3b_v = _avg([_series_metric(d, key, fallback) for d in prev3_before_last3]) if prev3_before_last3 else None
        items.append(
            {
                "label": label,
                "metric": key if not fallback else f"{key}|{fallback}",
                "last1": last1_v,
                "prev3_avg": prev3_v,
                "last1_vs_prev3_pct": _pct_change(last1_v, prev3_v),
                "last3_avg": last3_v,
                "prev3_before_last3_avg": prev3b_v,
                "last3_vs_prev3_pct": _pct_change(last3_v, prev3b_v),
            }
        )
    return {"available": True, "last_month": last_month, "items": items}


class StructuredAlertAction(BaseModel):
    owner: str
    cadence: str
    sla: str
    success: str


class StructuredAlertRisk(BaseModel):
    id: str
    level: str  # high|medium|low
    title: str
    risk: str
    impact: str
    evidence: list[str]
    actions: list[StructuredAlertAction]


class AlertsV2Req(BaseModel):
    repo_name: str
    month: str | None = None
    latest: dict[str, Any] | None = None
    series: list[dict[str, Any]] | None = None  # 建议 6 个月（前端已 slice）
    rule_alerts: list[dict[str, Any]] | None = None


class AlertsV2Resp(BaseModel):
    schema: str = "openpulse.alerts.v2"
    repo_name: str
    month: str | None = None
    summary: str
    next_metrics: list[str]
    comparisons: dict[str, Any]
    why_triggered: list[str]
    why_not_triggered: list[str]
    risks: list[StructuredAlertRisk]


class ReportV2Req(BaseModel):
    repo_name: str
    month: str | None = None
    latest: dict[str, Any] | None = None
    meta: dict[str, Any] | None = None
    series: list[dict[str, Any]] | None = None
    rule_alerts: list[dict[str, Any]] | None = None


class ReportV2Resp(BaseModel):
    schema: str = "openpulse.report.v2"
    repo_name: str
    month: str | None = None
    title: str
    executive_summary: list[str]
    comparisons: dict[str, Any]
    risks: list[StructuredAlertRisk]
    governance_actions: list[StructuredAlertAction]
    next_metrics: list[str]


class IntroV2Req(BaseModel):
    repo_name: str
    month: str | None = None
    meta: dict[str, Any] | None = None
    latest: dict[str, Any] | None = None


class IntroV2Resp(BaseModel):
    schema: str = "openpulse.intro.v2"
    repo_name: str
    month: str | None = None
    intro: str


def _render_alerts_v2_markdown(obj: AlertsV2Resp) -> str:
    def pct(p: float | None) -> str:
        if p is None:
            return "—"
        return f"{p * 100:.0f}%"

    lines: list[str] = []
    lines.append("## 近期预警与建议（结构化）")
    lines.append(f"- **摘要**：{obj.summary}")
    if obj.next_metrics:
        lines.append(f"- **下一步关注指标**：{', '.join(obj.next_metrics)}")
    lines.append("")
    if obj.comparisons.get("available"):
        lines.append("## 时间窗口对比（口径：last1 vs prev3、last3 vs prev3）")
        for it in obj.comparisons.get("items", [])[:8]:
            lines.append(
                f"- **{it.get('label')}**："
                f"last1={it.get('last1')}, prev3_avg={it.get('prev3_avg')}（{pct(it.get('last1_vs_prev3_pct'))}）"
                f"；last3_avg={it.get('last3_avg')}, prev3_before_last3_avg={it.get('prev3_before_last3_avg')}（{pct(it.get('last3_vs_prev3_pct'))}）"
            )
        lines.append("")
    if obj.why_triggered:
        lines.append("## 为什么触发")
        for s in obj.why_triggered:
            lines.append(f"- {s}")
        lines.append("")
    if obj.why_not_triggered:
        lines.append("## 为什么没触发（或未观察到）")
        for s in obj.why_not_triggered:
            lines.append(f"- {s}")
        lines.append("")
    if obj.risks:
        lines.append("## 风险清单与行动建议")
        for r in obj.risks:
            lines.append(f"### [{r.level.upper()}] {r.title}")
            lines.append(f"- **风险点**：{r.risk}")
            lines.append(f"- **影响**：{r.impact}")
            if r.evidence:
                lines.append("- **证据**：")
                for e in r.evidence:
                    lines.append(f"  - {e}")
            if r.actions:
                lines.append("- **建议动作（可执行）**：")
                for a in r.actions:
                    lines.append(f"  - **负责人**：{a.owner}；**节奏**：{a.cadence}；**SLA**：{a.sla}；**成功判据**：{a.success}")
            lines.append("")
    return "\n".join(lines).strip()


def _fallback_alerts_v2(req: AlertsV2Req) -> AlertsV2Resp:
    # 兜底：用规则告警 + 时间窗口对比生成“可读且结构化”的内容（不依赖外部事实）
    comparisons = _compute_time_window_comparisons(
        req.series,
        metrics=[
            ("Activity", "kpi_activity", None),
            ("New PRs / mo", "kpi_new_prs_month", "kpi_new_prs_month_log"),
            ("New Issues / mo", "kpi_new_issues_month", "kpi_new_issues_month_log"),
            ("PR Response Median (h)", "lat_pr_response_median", None),
            ("PR Resolution Median (h)", "lat_pr_resolution_median", None),
            ("Issue Response Median (h)", "lat_issue_response_median", None),
            ("Bus Factor", "bus_factor", None),
            ("Active Contributors / mo", "kpi_active_contributors_month", None),
        ],
    )

    ra = req.rule_alerts or []
    risks: list[StructuredAlertRisk] = []
    why_triggered: list[str] = []
    for a in ra[:5]:
        rid = str(a.get("id") or a.get("title") or "alert")
        level = str(a.get("level") or "low")
        title = str(a.get("title") or "Alert")
        detail = str(a.get("detail") or "")
        metric = str(a.get("metric") or "")
        why_triggered.append(f"{title}（{level}）：{detail}".strip())
        risks.append(
            StructuredAlertRisk(
                id=rid,
                level=level,
                title=title,
                risk=detail or "触发了规则预警项，建议进一步确认。",
                impact="可能增加维护者负担、降低协作效率或影响项目可持续性（建议结合指标确认）。",
                evidence=[f"规则告警：{title}（metric={metric}）"],
                actions=[
                    StructuredAlertAction(
                        owner="Maintainer / Triage Owner",
                        cadence="每周",
                        sla="为高/中风险项设定响应/处理时限",
                        success="相关时延/积压指标在 2~4 周内出现可观改善",
                    )
                ],
            )
        )

    if not risks:
        summary = "当前未触发规则告警，整体状态偏稳健；建议持续关注趋势变化与关键人风险。"
        why_not = [
            "近期窗口内未观察到明显的规则触发信号（仍建议结合趋势查看）。",
        ]
    else:
        summary = "检测到若干风险信号，建议按严重程度优先处理，并用明确 SLA/成功判据闭环。"
        why_not = []

    next_metrics = [
        "lat_pr_response_median",
        "lat_pr_resolution_median",
        "kpi_activity",
    ]

    return AlertsV2Resp(
        repo_name=req.repo_name,
        month=req.month,
        summary=summary,
        next_metrics=next_metrics,
        comparisons=comparisons,
        why_triggered=why_triggered,
        why_not_triggered=why_not,
        risks=risks,
    )


def _sse_event(data: str, event: str = "message") -> str:
    # SSE 格式：event + data（data 可多行）
    data = (data or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [f"event: {event}"]
    for ln in data.split("\n"):
        lines.append(f"data: {ln}")
    lines.append("")  # end of event
    return "\n".join(lines) + "\n"


@app.post("/api/report")
async def gen_report(req: ReportReq):
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Missing OPENAI_API_KEY env var")

    client = OpenAI(
        api_key=api_key,
        base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    )

    prompt = f"""
你是开源项目治理分析专家。请基于以下项目数据生成一份“项目健康分析报告”。
**输出必须为 Markdown**（使用 `##`/`###` 标题与列表），排版要适合大屏弹窗阅读；不要输出代码块；不要编造具体事实。

【项目】
- repo_name: {req.repo_name}
- month: {req.month}

【关键指标（可能为空）】
{req.latest}

请按以下结构输出：
## 项目健康分析报告
### 1) 项目简介
（2~4 句，允许“可能/用于/建议进一步确认”的表达）
### 2) 现状概览
- **活跃度**：...
- **响应效率**：...
- **贡献结构**：...
- **关注度/影响力**：...
- **可持续性**：...
### 3) 风险点（3-5 条）
- **风险**：... **影响**：... **证据**：（引用指标名与大致方向即可）
### 4) 治理建议
- **短期（1-4 周）**：...
- **中期（1-3 月）**：...
### 5) 结论
（1-2 句）

请避免输出任何敏感信息。
""".strip()

    try:
        resp = client.chat.completions.create(
            model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.4,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Upstream LLM error: {type(e).__name__}: {e}")

    text = (resp.choices[0].message.content or "").strip()
    return {"report": text}


def _fallback_alert_summary(req: AlertsReq) -> str:
    # 离线可用兜底：把规则告警压缩成 3~5 条建议
    ra = req.rule_alerts or []
    if not ra:
        return (
            "## 近期预警与建议\n"
            "- **总体状态**：当前未触发规则告警，项目整体状态较为稳健。\n"
            "- **建议关注**：活跃度变化、PR/Issue 处理时延、关键人风险（Bus Factor）、积压趋势与关注度变化。\n"
        )

    items = ra[:5]
    lines: list[str] = []
    for a in items:
        title = str(a.get("title") or "Alert")
        level = str(a.get("level") or "").upper()
        detail = str(a.get("detail") or "")
        lines.append(f"- [{level}] {title}: {detail}")

    tail = [
        "",
        "## 通用治理建议",
        "- 为高/中风险项设定 **SLA 与负责人**（triage / review / release）。",
        "- 对关键人风险：提升 **Bus Factor**（轮值、文档化、权限下放、引导新贡献者）。",
        "- 对积压/时延：优化标签与流程、自动分流、减少长尾 PR/Issue。",
    ]
    return "## 近期预警与建议\n" + "\n".join(lines + tail)


@app.post("/api/alerts")
async def gen_alerts(req: AlertsReq):
    api_key = os.environ.get("OPENAI_API_KEY")
    # 没有 key 也要可用：直接返回兜底摘要（保证离线稳定）
    if not api_key:
        return {"summary": _fallback_alert_summary(req), "mode": "fallback"}

    client = OpenAI(
        api_key=api_key,
        base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    )

    prompt = f"""
你是开源项目治理风险预警分析助手。请基于以下输入，生成 3~5 条“近期预警”与建议。
**输出必须为 Markdown**，以 `## 近期预警与建议` 开头，随后用列表输出；不要输出代码块；不要编造具体事实。

【项目】
- repo_name: {req.repo_name}
- month: {req.month}

【规则告警（优先参考，可解释、可信）】
{req.rule_alerts}

【近期指标序列（可能为空）】
{req.series}

【latest（可能为空）】
{req.latest}

输出要求：
1) 每条包含：**风险点** + **影响** + **建议（可执行）**
2) 优先覆盖规则告警中 `level=high/medium` 的项
3) 信息不足时用“可能/建议进一步确认”表达
""".strip()

    try:
        resp = client.chat.completions.create(
            model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
        )
    except Exception as e:
        # 上游异常也要兜底，不让前端空白
        return {
            "summary": _fallback_alert_summary(req),
            "mode": "fallback",
            "detail": f"Upstream LLM error: {type(e).__name__}: {e}",
        }

    text = (resp.choices[0].message.content or "").strip()
    return {"summary": text, "mode": "llm"}


def _fallback_intro(req: IntroReq) -> str:
    # 离线兜底：不依赖外部事实，只给“可能/用途”描述
    name = req.repo_name or "该项目"
    lang = (req.meta or {}).get("repo_language")
    parts = [f"“{name}” 是一个开源仓库。"]
    if lang:
        parts.append(f"从元数据看，它可能主要使用 {lang} 语言。")
    parts.append("在缺少更多上下文时，可以将其视为一个需要持续监控活跃度、响应效率与关键人风险的项目。")
    return "".join(parts)


@app.post("/api/intro")
async def gen_intro(req: IntroReq):
    api_key = os.environ.get("OPENAI_API_KEY")
    # 没有 key 也要可用：直接兜底
    if not api_key:
        return {"intro": _fallback_intro(req), "mode": "fallback"}

    client = OpenAI(
        api_key=api_key,
        base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    )

    prompt = f"""
你是开源项目大屏展示的文案助手。请为该仓库生成一段“简短项目简介”，用于大屏弹窗展示：

【项目】
- repo_name: {req.repo_name}
- month: {req.month}

【元数据（可能为空）】
{req.meta}

【关键指标（可能为空）】
{req.latest}

要求：
1) 中文输出，2~4 句，总字数控制在 60~120 字
2) 不要编造具体事实（如用户数/公司/下载量等）；只做可能性的描述
3) 语气专业、克制、适合大屏
""".strip()

    try:
        resp = client.chat.completions.create(
            model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.4,
        )
    except Exception as e:
        return {
            "intro": _fallback_intro(req),
            "mode": "fallback",
            "detail": f"Upstream LLM error: {type(e).__name__}: {e}",
        }

    text = (resp.choices[0].message.content or "").strip()
    return {"intro": text, "mode": "llm"}


@app.post("/api/alerts_v2")
async def gen_alerts_v2(req: AlertsV2Req):
    """
    v2：返回结构化 JSON（便于前端卡片化/高亮/配色/摘要置顶）。
    非流式版本：一次性返回解析后的 JSON。
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    # 无 key：返回结构化兜底
    if not api_key:
        obj = _fallback_alerts_v2(req)
        md = _render_alerts_v2_markdown(obj)
        return {"data": obj.model_dump(), "markdown": md, "mode": "fallback"}

    # 计算时间窗口对比（供模型引用，禁止编造）
    comparisons = _compute_time_window_comparisons(
        req.series,
        metrics=[
            ("Activity", "kpi_activity", None),
            ("New PRs / mo", "kpi_new_prs_month", "kpi_new_prs_month_log"),
            ("New Issues / mo", "kpi_new_issues_month", "kpi_new_issues_month_log"),
            ("PR Response Median (h)", "lat_pr_response_median", None),
            ("PR Resolution Median (h)", "lat_pr_resolution_median", None),
            ("Issue Response Median (h)", "lat_issue_response_median", None),
            ("Bus Factor", "bus_factor", None),
            ("Active Contributors / mo", "kpi_active_contributors_month", None),
        ],
    )

    client = OpenAI(
        api_key=api_key,
        base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    )

    # 让模型只输出 JSON（严格 schema），前端再渲染；并要求“为什么触发/没触发”、更具体的行动项。
    prompt = f"""
你是开源项目治理风险预警分析助手。请基于提供的数据，输出一个“结构化 JSON”，供前端做卡片化展示。
要求：
1) 必须中文输出（除 metric 名可保留原字段名）。
2) 不得编造外部事实；数值只能引用输入中给出的 comparisons 或 latest/series。
3) 必须包含：时间窗口对比（last1 vs prev3、last3 vs prev3）、为什么触发/为什么没触发、具体行动建议（负责人/节奏/SLA/成功判据）、最后给 3 个“下一步关注指标”。
4) 只输出 JSON，不要 Markdown，不要代码块。

【项目】
- repo_name: {req.repo_name}
- month: {req.month}

【规则告警（优先参考，可解释、可信）】
{req.rule_alerts}

【时间窗口对比（已由系统计算，允许引用；禁止编造）】
{comparisons}

【latest（可能为空）】
{req.latest}

JSON Schema（字段必须齐全）：
{{
  "schema": "openpulse.alerts.v2",
  "repo_name": "...",
  "month": "...",
  "summary": "1-2 句摘要（适合大屏）",
  "next_metrics": ["metric_a","metric_b","metric_c"],
  "comparisons": <原样透传 comparisons>,
  "why_triggered": ["...","..."],
  "why_not_triggered": ["...","..."],
  "risks": [
    {{
      "id": "rule_id_or_custom",
      "level": "high|medium|low",
      "title": "短标题",
      "risk": "风险点（具体）",
      "impact": "影响（具体）",
      "evidence": ["证据1（含指标名/变化口径）", "证据2..."],
      "actions": [
        {{"owner":"负责人角色","cadence":"节奏/频率","sla":"SLA/时限","success":"成功判据（可量化）"}}
      ]
    }}
  ]
}}
""".strip()

    try:
        resp = client.chat.completions.create(
            model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
        )
    except Exception as e:
        obj = _fallback_alerts_v2(req)
        md = _render_alerts_v2_markdown(obj)
        return {
            "data": obj.model_dump(),
            "markdown": md,
            "mode": "fallback",
            "detail": f"Upstream LLM error: {type(e).__name__}: {e}",
        }

    text = (resp.choices[0].message.content or "").strip()
    # 解析失败也要兜底：前端至少有可用结构
    try:
        import json as _json

        raw = _json.loads(text)
        obj = AlertsV2Resp.model_validate(raw)
    except Exception:
        obj = _fallback_alerts_v2(req)
    md = _render_alerts_v2_markdown(obj)
    return {"data": obj.model_dump(), "markdown": md, "mode": "llm"}


@app.post("/api/alerts_v2/stream")
async def gen_alerts_v2_stream(req: AlertsV2Req):
    """
    v2：SSE 流式输出。
    事件：
      - event: meta   data: {"mode": "..."}
      - event: delta  data: <文本增量>（模型生成的 JSON 字符串片段）
      - event: done   data: <完整 JSON 字符串>
      - event: error  data: <错误信息>
    前端可边显示 delta（提升观感），done 后再 JSON.parse 做结构化渲染。
    """
    api_key = os.environ.get("OPENAI_API_KEY")

    async def gen():
        # meta
        yield _sse_event('{"schema":"openpulse.stream.v1"}', event="meta")

        if not api_key:
            obj = _fallback_alerts_v2(req)
            import json as _json

            full = _json.dumps(obj.model_dump(), ensure_ascii=False)
            # 兜底也“流式”切片输出，保证观感一致
            for i in range(0, len(full), 240):
                yield _sse_event(full[i : i + 240], event="delta")
            yield _sse_event(full, event="done")
            return

        comparisons = _compute_time_window_comparisons(
            req.series,
            metrics=[
                ("Activity", "kpi_activity", None),
                ("New PRs / mo", "kpi_new_prs_month", "kpi_new_prs_month_log"),
                ("New Issues / mo", "kpi_new_issues_month", "kpi_new_issues_month_log"),
                ("PR Response Median (h)", "lat_pr_response_median", None),
                ("PR Resolution Median (h)", "lat_pr_resolution_median", None),
                ("Issue Response Median (h)", "lat_issue_response_median", None),
                ("Bus Factor", "bus_factor", None),
                ("Active Contributors / mo", "kpi_active_contributors_month", None),
            ],
        )

        client = OpenAI(
            api_key=api_key,
            base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        )

        prompt = f"""
你是开源项目治理风险预警分析助手。请基于提供的数据，输出一个“结构化 JSON”，供前端做卡片化展示。
要求：中文输出；不得编造外部事实；数值只能引用输入中的 comparisons/latest/series；只输出 JSON（不要 Markdown/代码块）。
必须包含：时间窗口对比、为什么触发/为什么没触发、具体行动建议（负责人/节奏/SLA/成功判据）、下一步关注指标（3 个）。

【项目】repo_name={req.repo_name} month={req.month}
【规则告警】{req.rule_alerts}
【时间窗口对比】{comparisons}
【latest】{req.latest}

JSON Schema（字段必须齐全）：
{{
  "schema":"openpulse.alerts.v2",
  "repo_name":"...",
  "month":"...",
  "summary":"...",
  "next_metrics":["...","...","..."],
  "comparisons": {comparisons},
  "why_triggered":["..."],
  "why_not_triggered":["..."],
  "risks":[
    {{"id":"...","level":"high|medium|low","title":"...","risk":"...","impact":"...","evidence":["..."],"actions":[{{"owner":"...","cadence":"...","sla":"...","success":"..."}}]}}
  ]
}}
""".strip()

        full_buf: list[str] = []
        try:
            stream = client.chat.completions.create(
                model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
                messages=[
                    {"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.2,
                stream=True,
            )
            for ev in stream:
                delta = ev.choices[0].delta.content if ev.choices else None
                if not delta:
                    continue
                full_buf.append(delta)
                yield _sse_event(delta, event="delta")
        except Exception as e:
            # 上游失败：直接输出兜底（仍然用流式）
            obj = _fallback_alerts_v2(req)
            import json as _json

            full = _json.dumps(obj.model_dump(), ensure_ascii=False)
            yield _sse_event(f"Upstream LLM error: {type(e).__name__}: {e}", event="error")
            for i in range(0, len(full), 240):
                yield _sse_event(full[i : i + 240], event="delta")
            yield _sse_event(full, event="done")
            return

        full_text = "".join(full_buf).strip()
        yield _sse_event(full_text, event="done")

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/report_v2/stream")
async def gen_report_v2_stream(req: ReportV2Req):
    """
    v2：报告同样提供 SSE 流式结构化 JSON（前端可渲染摘要/章节/行动项）。
    目前以 alerts_v2 同样的模式实现，便于前端复用解析逻辑。
    """
    api_key = os.environ.get("OPENAI_API_KEY")

    async def gen():
        yield _sse_event('{"schema":"openpulse.stream.v1"}', event="meta")

        # 统一 comparisons，供报告也引用“时间窗口对比”
        comparisons = _compute_time_window_comparisons(
            req.series,
            metrics=[
                ("Activity", "kpi_activity", None),
                ("New PRs / mo", "kpi_new_prs_month", "kpi_new_prs_month_log"),
                ("New Issues / mo", "kpi_new_issues_month", "kpi_new_issues_month_log"),
                ("PR Response Median (h)", "lat_pr_response_median", None),
                ("PR Resolution Median (h)", "lat_pr_resolution_median", None),
                ("Issue Response Median (h)", "lat_issue_response_median", None),
                ("Bus Factor", "bus_factor", None),
                ("Active Contributors / mo", "kpi_active_contributors_month", None),
                ("Stars Δ / mo", "kpi_stars_delta_month", None),
                ("OpenRank", "kpi_openrank", None),
            ],
        )

        if not api_key:
            # 离线兜底：用规则告警 + comparisons 拼出一个最小可用的结构化报告
            base = _fallback_alerts_v2(
                AlertsV2Req(
                    repo_name=req.repo_name,
                    month=req.month,
                    latest=req.latest or {},
                    series=req.series,
                    rule_alerts=req.rule_alerts or [],
                )
            )
            obj = ReportV2Resp(
                repo_name=req.repo_name,
                month=req.month,
                title="项目健康分析报告（离线兜底）",
                executive_summary=[
                    "本报告基于近期指标与规则预警生成，未接入外部事实。",
                    base.summary,
                ],
                comparisons=comparisons,
                risks=base.risks,
                governance_actions=[
                    StructuredAlertAction(
                        owner="Maintainer / PM / Triage Owner",
                        cadence="每周",
                        sla="建立 triage / review / release 的最小闭环",
                        success="2~4 周内关键时延/积压指标出现改善趋势",
                    )
                ],
                next_metrics=base.next_metrics,
            )
            import json as _json

            full = _json.dumps(obj.model_dump(), ensure_ascii=False)
            for i in range(0, len(full), 240):
                yield _sse_event(full[i : i + 240], event="delta")
            yield _sse_event(full, event="done")
            return

        client = OpenAI(
            api_key=api_key,
            base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        )

        prompt = f"""
你是开源项目治理分析专家。请基于输入数据生成一份“结构化 JSON 报告”，用于前端大屏弹窗卡片化渲染。
要求：
1) 中文输出；不得编造外部事实；数值只能引用输入中的 comparisons/latest/series。
2) 必须包含：Executive Summary（3-5 条）、风险项（含证据与行动）、治理行动清单（负责人/节奏/SLA/成功判据）、下一步关注指标（3 个）。
3) 只输出 JSON（不要 Markdown/代码块）。

【项目】repo_name={req.repo_name} month={req.month}
【meta】{req.meta}
【latest】{req.latest}
【规则告警】{req.rule_alerts}
【时间窗口对比】{comparisons}

JSON Schema（字段必须齐全）：
{{
  "schema":"openpulse.report.v2",
  "repo_name":"...",
  "month":"...",
  "title":"...",
  "executive_summary":["...","...","..."],
  "comparisons": {comparisons},
  "risks":[
    {{"id":"...","level":"high|medium|low","title":"...","risk":"...","impact":"...","evidence":["..."],"actions":[{{"owner":"...","cadence":"...","sla":"...","success":"..."}}]}}
  ],
  "governance_actions":[{{"owner":"...","cadence":"...","sla":"...","success":"..."}}],
  "next_metrics":["...","...","..."]
}}
""".strip()

        full_buf: list[str] = []
        try:
            stream = client.chat.completions.create(
                model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
                messages=[
                    {"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.2,
                stream=True,
            )
            for ev in stream:
                delta = ev.choices[0].delta.content if ev.choices else None
                if not delta:
                    continue
                full_buf.append(delta)
                yield _sse_event(delta, event="delta")
        except Exception as e:
            yield _sse_event(f"Upstream LLM error: {type(e).__name__}: {e}", event="error")
            # fallback：仍输出一个离线报告结构
            base = _fallback_alerts_v2(
                AlertsV2Req(
                    repo_name=req.repo_name,
                    month=req.month,
                    latest=req.latest or {},
                    series=req.series,
                    rule_alerts=req.rule_alerts or [],
                )
            )
            obj = ReportV2Resp(
                repo_name=req.repo_name,
                month=req.month,
                title="项目健康分析报告（兜底）",
                executive_summary=[base.summary],
                comparisons=comparisons,
                risks=base.risks,
                governance_actions=base.risks[0].actions if base.risks else [],
                next_metrics=base.next_metrics,
            )
            import json as _json

            full = _json.dumps(obj.model_dump(), ensure_ascii=False)
            for i in range(0, len(full), 240):
                yield _sse_event(full[i : i + 240], event="delta")
            yield _sse_event(full, event="done")
            return

        full_text = "".join(full_buf).strip()
        yield _sse_event(full_text, event="done")

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/intro_v2/stream")
async def gen_intro_v2_stream(req: IntroV2Req):
    """
    v2：简介也支持 SSE（短文本，主要是为了统一交互体验）。
    done 事件 data 为 JSON 字符串：{"schema":"openpulse.intro.v2",...}
    """
    api_key = os.environ.get("OPENAI_API_KEY")

    async def gen():
        yield _sse_event('{"schema":"openpulse.stream.v1"}', event="meta")

        if not api_key:
            obj = IntroV2Resp(repo_name=req.repo_name, month=req.month, intro=_fallback_intro(IntroReq(**req.model_dump())))
            import json as _json

            full = _json.dumps(obj.model_dump(), ensure_ascii=False)
            for i in range(0, len(full), 240):
                yield _sse_event(full[i : i + 240], event="delta")
            yield _sse_event(full, event="done")
            return

        client = OpenAI(
            api_key=api_key,
            base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        )

        prompt = f"""
你是开源项目大屏展示的文案助手。请生成“结构化 JSON”，只包含一个 intro 字段（中文 60~120 字，2~4 句），用于弹窗展示。
不得编造外部事实；只做可能性描述；只输出 JSON（不要 Markdown/代码块）。

输入：
repo_name={req.repo_name}
month={req.month}
meta={req.meta}
latest={req.latest}

JSON Schema：
{{"schema":"openpulse.intro.v2","repo_name":"...","month":"...","intro":"..."}}
""".strip()

        full_buf: list[str] = []
        try:
            stream = client.chat.completions.create(
                model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
                messages=[
                    {"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.3,
                stream=True,
            )
            for ev in stream:
                delta = ev.choices[0].delta.content if ev.choices else None
                if not delta:
                    continue
                full_buf.append(delta)
                yield _sse_event(delta, event="delta")
        except Exception as e:
            yield _sse_event(f"Upstream LLM error: {type(e).__name__}: {e}", event="error")
            obj = IntroV2Resp(repo_name=req.repo_name, month=req.month, intro=_fallback_intro(IntroReq(**req.model_dump())))
            import json as _json

            full = _json.dumps(obj.model_dump(), ensure_ascii=False)
            for i in range(0, len(full), 240):
                yield _sse_event(full[i : i + 240], event="delta")
            yield _sse_event(full, event="done")
            return

        full_text = "".join(full_buf).strip()
        yield _sse_event(full_text, event="done")

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
