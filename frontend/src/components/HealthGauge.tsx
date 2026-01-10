import ReactECharts from "echarts-for-react";

type Props = {
  score: number | null | undefined; // 0-100
  dims?: {
    activity?: number | null;
    responsiveness?: number | null;
    contributors?: number | null;
    attention?: number | null;
    sustainability?: number | null;
  };
};

function clamp01(x: number) {
  return Math.max(0, Math.min(100, x));
}

function levelText(score: number) {
  if (score >= 80) return { text: "Good", color: "#22c55e" };
  if (score >= 60) return { text: "Fair", color: "#eab308" };
  if (score >= 40) return { text: "Warning", color: "#f97316" };
  return { text: "Risk", color: "#ef4444" };
}

export default function HealthGauge({ score, dims }: Props) {
  const s = typeof score === "number" && !Number.isNaN(score) ? clamp01(score) : null;
  const lv = s === null ? { text: "—", color: "#94a3b8" } : levelText(s);

  const option = {
    backgroundColor: "transparent",
    series: [
      {
        type: "gauge",
        startAngle: 180,
        endAngle: 0,
        center: ["50%", "62%"],
        radius: "92%",
        min: 0,
        max: 100,
        splitNumber: 5,
        progress: {
          show: true,
          width: 14,
          roundCap: true,
        },
        axisLine: {
          lineStyle: {
            width: 14,
            roundCap: true,
            // 颜色分段（红-橙-黄-绿）
            color: [
              [0.4, "#ef4444"],
              [0.6, "#f97316"],
              [0.8, "#eab308"],
              [1.0, "#22c55e"],
            ],
          },
        },
        axisTick: { show: false },
        splitLine: {
          show: true,
          length: 10,
          lineStyle: { color: "rgba(148,163,184,0.35)", width: 2 },
        },
        axisLabel: {
          color: "rgba(203,213,225,0.85)",
          fontSize: 11,
          distance: -34,
        },
        pointer: {
          show: true,
          length: "65%",
          width: 4,
        },
        itemStyle: {
          color: "rgba(226,232,240,0.95)",
        },
        anchor: {
          show: true,
          showAbove: true,
          size: 10,
          itemStyle: { color: "#0ea5e9" },
        },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, "-8%"],
          fontSize: 54,
          fontWeight: 700,
          color: "rgba(226,232,240,0.95)",
          formatter: (v: number) => (typeof v === "number" ? Math.round(v).toString() : "—"),
        },
        title: {
          show: true,
          offsetCenter: [0, "20%"],
          fontSize: 16,
          color: lv.color,
          fontWeight: 600,
        },
        data: [
          {
            value: s ?? 0,
            name: lv.text,
          },
        ],
      },
    ],
  };

  return (
    <div className="h-full w-full">
      <div className="flex items-center justify-between">
        <div className="text-slate-100 font-semibold">Health Score</div>
        <div className="text-xs text-slate-400">Computed (A/R/C/T/S)</div>
      </div>

      <div className="mt-2 h-[190px]">
        <ReactECharts option={option} style={{ height: "100%", width: "100%" }} />
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2">
        <DimRow label="Activity" value={dims?.activity} icon="▲" />
        <DimRow label="Responsiveness" value={dims?.responsiveness} icon="◆" />
        <DimRow label="Contributors" value={dims?.contributors} icon="●" />
        <DimRow label="Attention" value={dims?.attention} icon="◆" />
        <DimRow label="Sustainability" value={dims?.sustainability} icon="●" />
      </div>
    </div>
  );
}

function DimRow({ label, value, icon }: { label: string; value?: number | null; icon: string }) {
  const v = typeof value === "number" && !Number.isNaN(value) ? Math.round(value).toString() : "—";
  return (
    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2">
      <div className="flex items-center gap-2 text-slate-200">
        <span className="text-sky-400">{icon}</span>
        <span className="text-sm">{label}</span>
      </div>
      <div className="text-slate-100 font-semibold tabular-nums">{v}</div>
    </div>
  );
}

