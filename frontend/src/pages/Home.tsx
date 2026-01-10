import { useEffect, useMemo, useState } from "react";
import Globe from "../components/Globe";
import { motion } from "framer-motion";

type RepoRow = { repo_name: string };

export default function Home() {
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [latestMap, setLatestMap] = useState<Record<string, any>>({});
  const [repo, setRepo] = useState("");
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await fetch("/data/repos.json").then((res) => res.json());
      const l = await fetch("/data/latest.json").then((res) => res.json());

      const isUsefulRepo = (latestObj: any) => {
        const commits = latestObj?.kpi_commits_month ?? latestObj?.kpi_commits_month_log ?? 0;
        const issues = latestObj?.kpi_new_issues_month ?? latestObj?.kpi_new_issues_month_log ?? 0;
        const prs = latestObj?.kpi_new_prs_month ?? latestObj?.kpi_new_prs_month_log ?? 0;
        const activity = latestObj?.kpi_activity ?? 0;
        return commits + issues + prs + activity > 0;
      };

      const arr = Array.isArray(r) ? r : [];
      const filtered = arr.filter((x) => isUsefulRepo((l || {})?.[x?.repo_name] ?? {}));
      setRepos(filtered);
      setLatestMap(l || {});

      const urlRepo = new URLSearchParams(window.location.hash.split("?")[1] || "").get("repo") || "";
      const first = filtered?.[0]?.repo_name || "";
      const pick = filtered.some((x) => x.repo_name === urlRepo) ? urlRepo : first;
      if (pick) setRepo(pick);
    })();
  }, []);

  // 预留：后续可在首页展示一些 repo 概览信息
  const selectedLatest = useMemo(() => (repo ? latestMap?.[repo] ?? {} : {}), [latestMap, repo]);
  void selectedLatest;

  const goDashboard = () => {
    if (!repo) return;
    setLeaving(true);
    window.setTimeout(() => {
      window.location.hash = `/dashboard?repo=${encodeURIComponent(repo)}`;
    }, 220);
  };

  return (
    <motion.div
      className="min-h-screen bg-slate-950 text-slate-100"
      animate={leaving ? { opacity: 0, y: -10 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
    >
      <div className="max-w-[1400px] mx-auto px-4 py-8">
        <div className="rounded-2xl border border-slate-700/60 bg-slate-900/40 shadow-[0_0_60px_rgba(59,130,246,0.10)] overflow-hidden">
          <div className="grid grid-cols-12 gap-0">
            <div className="col-span-12 lg:col-span-7 p-8 lg:p-10">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 backdrop-blur">
                <BoltIcon className="h-3.5 w-3.5 text-sky-300" />
                <span>Open Source Intelligence · Metrics · AI Governance</span>
              </div>

              <div className="mt-4 leading-tight">
                <div className="text-4xl lg:text-6xl font-extrabold tracking-tight text-slate-100">
                  OpenPulse
                </div>
                <div className="mt-1 text-lg lg:text-2xl font-semibold tracking-wide text-slate-300/85">
                  Project Health Monitoring &amp; Governance Decision Support
                </div>
                <div className="mt-3 h-[2px] w-[420px] max-w-full bg-gradient-to-r from-transparent via-sky-400/70 to-transparent" />
              </div>

              <div className="mt-4 text-slate-300 text-base lg:text-lg leading-relaxed max-w-2xl">
                用开源行为数据 + 指标体系 + AI 分析，给出健康度与治理建议
              </div>

              <div className="mt-8 max-w-2xl rounded-2xl border border-white/10 bg-white/5 backdrop-blur px-4 py-4 shadow-[0_0_60px_rgba(56,189,248,0.08)]">
                <div className="text-slate-200 font-semibold text-sm mb-3 flex items-center gap-2">
                  <RepoIcon className="h-4 w-4 text-slate-300" />
                  <span>Select Repository</span>
                </div>

                <div className="grid grid-cols-10 gap-3 items-stretch">
                  <div className="col-span-10 sm:col-span-7">
                    <div className="relative">
                      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                        <RepoIcon className="h-4 w-4 text-slate-400" />
                      </div>
                      <select
                        className="w-full rounded-xl bg-slate-950/60 border border-slate-700/60 pl-10 pr-4 py-3 text-slate-100 focus:outline-none focus:ring-1 focus:ring-sky-400/60"
                        value={repo}
                        onChange={(e) => setRepo(e.target.value)}
                      >
                        {repos.map((r) => (
                          <option key={r.repo_name} value={r.repo_name}>
                            {r.repo_name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="col-span-10 sm:col-span-3">
                    <button
                      onClick={goDashboard}
                      disabled={!repo || leaving}
                      className={`w-full h-full rounded-xl px-4 py-3 text-sm font-semibold transition transform ${
                        repo && !leaving
                          ? "bg-sky-600 hover:bg-sky-500 text-white shadow-[0_0_28px_rgba(56,189,248,0.28)] hover:shadow-[0_0_40px_rgba(56,189,248,0.36)] active:scale-[0.98]"
                          : "bg-slate-700 cursor-not-allowed text-slate-300"
                      }`}
                    >
                      开始使用 →
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-4 max-w-3xl">
                <Feature
                  icon={<ChartIcon className="h-5 w-5 text-sky-300" />}
                  title="指标体系"
                  desc="可解释的健康度维度：活跃度、响应效率、贡献结构、关注度与可持续性。"
                />
                <Feature
                  icon={<ShieldIcon className="h-5 w-5 text-emerald-300" />}
                  title="规则预警"
                  desc="稳定、可离线：基于历史窗口与阈值的风险提示，支持 AI 文字化解读。"
                />
                <Feature
                  icon={<SparkIcon className="h-5 w-5 text-violet-300" />}
                  title="治理建议"
                  desc="将指标与告警转为可执行建议：短期动作 + 中期治理路径。"
                />
              </div>
            </div>

            <div className="relative col-span-12 lg:col-span-5 p-8 lg:p-10 bg-gradient-to-b from-slate-950/40 to-slate-900/20">
              {/* 渐变分割线：中间亮，两边暗 */}
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sky-400/25 to-transparent lg:hidden" />
              <div className="absolute inset-y-0 left-0 w-px bg-gradient-to-b from-transparent via-sky-400/25 to-transparent hidden lg:block" />
              <div className="flex items-center justify-between">
                <div className="text-slate-200 font-semibold">Global Open Source</div>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 backdrop-blur">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                  </span>
                  Live • Global View
                </div>
              </div>
              <div className="mt-6 flex items-center justify-center">
                <div className="w-[320px] h-[320px] lg:w-[380px] lg:h-[380px]">
                  <Globe className="w-full h-full" />
                </div>
              </div>
              <div className="mt-6 text-slate-400 text-sm leading-relaxed">
                以全球视角观察开源生态：用数据把握趋势，用治理提升韧性。
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 text-center text-xs text-slate-500">
          GitHub:{" "}
          <a
            className="text-sky-300 hover:text-sky-200 underline"
            href="https://github.com/Owen2005-brilliant/OpenPulse"
            target="_blank"
            rel="noreferrer"
          >
            Owen2005-brilliant/OpenPulse
          </a>
        </div>
      </div>
    </motion.div>
  );
}

function Feature({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-4 backdrop-blur min-h-[132px]">
      <div className="flex items-center gap-2">
        <div className="h-9 w-9 rounded-lg border border-white/10 bg-black/20 flex items-center justify-center">
          {icon}
        </div>
        <div className="text-slate-100 font-semibold">{title}</div>
      </div>
      <div className="mt-3 text-sm text-slate-300 leading-relaxed">{desc}</div>
    </div>
  );
}

function BoltIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M13 2L3 14h8l-1 8 11-14h-8l0-6Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RepoIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M4 4h11a3 3 0 0 1 3 3v13"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M4 20h12a3 3 0 0 0 3-3V7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M7 7h6M7 11h6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChartIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M4 19V5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M4 19h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M7 15l3-4 3 2 4-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShieldIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 2l8 4v6c0 5-3.5 9.5-8 10-4.5-.5-8-5-8-10V6l8-4Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M9 12l2 2 4-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SparkIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 2l1.6 5.2L19 9l-5.4 1.8L12 16l-1.6-5.2L5 9l5.4-1.8L12 2Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M5 14l.9 2.9L9 18l-3.1 1.1L5 22l-.9-2.9L1 18l3.1-1.1L5 14Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

