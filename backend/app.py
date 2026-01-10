import os
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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
