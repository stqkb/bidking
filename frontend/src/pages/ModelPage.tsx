import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Card, Stat } from "../components/Card";
import Chart from "../components/Chart";
import { useToast } from "../components/Toast";
import { CHART } from "../theme/chartTokens";
import type { ModelStatus } from "../types";
import { fmtMoney, fmtPct } from "../utils";

/* ════════════════════════════════════════════════════════════
   硬编码指标 — 后端 /api/model/status 更新后替换为 API 数据
   ════════════════════════════════════════════════════════════ */
const HC = {
  fullMape: 20.9,
  redMape: 36.9,
  fullCoverage: 90.9,
  redCoverage: 97.0,
  retrainSeconds: 78,
  intervalMethod: "GP σ + Conformal",
  fusionStrategy: "等权平均",
  gpKernel: "ARD Matern(ν=2.5)",
  gpRestarts: 5,
  hgbConfig: { maxDepth: 4, maxLeafNodes: 16, maxIter: 200, earlyStopping: true },
  calibrationStrategy: "4 桶 median",
  // ARD 长度尺度倒数 → 特征重要性（值越大越重要）
  ardImportance: [
    { name: "规则红品估值(log)", value: 0.92 },
    { name: "已知红品价值(log)", value: 0.85 },
    { name: "已知价值/图鉴均值比", value: 0.68 },
    { name: "规则全场估值(log)", value: 0.61 },
    { name: "红品均格", value: 0.45 },
    { name: "已知红品格数", value: 0.38 },
    { name: "红品件数", value: 0.29 },
    { name: "场次(时间漂移)", value: 0.12 },
  ],
  // 4 桶校准详情
  buckets: [
    { range: "≤ 2.0", samples: 18, kRed: 0.85, kFull: 1.12 },
    { range: "2.0 – 3.0", samples: 35, kRed: 0.92, kFull: 1.05 },
    { range: "3.0 – 4.0", samples: 31, kRed: 1.08, kFull: 0.95 },
    { range: "> 4.0", samples: 23, kRed: 1.25, kFull: 0.88 },
  ],
  // 被否决方案
  rejected: [
    {
      name: "BMA 融合权重",
      summary: "权重 collapse 到 bayes=1.0，MAPE 20.4% → 22.2%",
      reason:
        "BIC 计算后 BayesRidge 的边际似然远高于 GP 和 HGB，导致 softmax 权重几乎坍缩为 bayes=1.0。实际效果是丢弃了 GP 和 HGB 的贡献，MAPE 从 20.4% 恶化到 22.2%。小样本下 BMA 的复杂度惩罚过于激进。",
      metrics: [
        { label: "融合策略", before: "等权平均", after: "BMA (bayes=1.0)" },
        { label: "全场 MAPE", before: "20.4%", after: "22.2%" },
        { label: "红品 MAPE", before: "36.9%", after: "38.1%" },
      ],
    },
    {
      name: "特征 v2（4 个交互特征）",
      summary: "107 样本过拟合，红品 MAPE 36.9% → 49.2%",
      reason:
        "新增 known_size×log_value、avg_dispersion、information_ratio、rule_autocorr 四个交互特征。训练集 R² 提升 0.04，但 LOOCV 红品 MAPE 从 36.9% 恶化到 49.2%。交互特征在高维低样本场景下需要更多正则化，当前样本量不足以支撑。",
      metrics: [
        { label: "特征数", before: "9", after: "13" },
        { label: "训练 R²", before: "0.50", after: "0.54" },
        { label: "红品 MAPE", before: "36.9%", after: "49.2%" },
      ],
    },
    {
      name: "LOESS 连续校准",
      summary: "插值出 nan，11% 预测无法输出区间",
      reason:
        "用 lowess(frac=0.4) 替代 4 桶 median 做连续校准曲线。在样本稀疏区域（均格 >4.0），LOESS 插值产生 nan，导致 11% 的预测无法输出区间。4 桶 median 虽然粗糙但保证 100% 覆盖。建议 n>200 后重试。",
      metrics: [
        { label: "校准方式", before: "4 桶 median", after: "LOESS frac=0.4" },
        { label: "nan 占比", before: "0%", after: "11%" },
        { label: "区间覆盖率", before: "90.9%", after: "80.8%" },
      ],
    },
  ],
};

/* ════════════════════════════════════════════════════════════
   小组件
   ════════════════════════════════════════════════════════════ */

function MetricCard({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "gold" | "jade" | "amber" | "vermilion";
}) {
  const toneMap: Record<string, string> = {
    default: "var(--text-primary)",
    gold: "var(--gold-400)",
    jade: "var(--jade-400)",
    amber: "var(--amber-400)",
    vermilion: "var(--vermilion-400)",
  };
  return (
    <div
      className="rounded-xl border px-5 py-4"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}
    >
      <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
        {label}
      </div>
      <div
        className="mt-1.5 font-mono text-2xl font-semibold tabular-nums"
        style={{ color: toneMap[tone], fontFamily: "'JetBrains Mono', monospace" }}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
      <span
        className="font-mono text-sm tabular-nums"
        style={{ color: "var(--text-primary)" }}
      >
        {value}
      </span>
    </div>
  );
}

function Tag({
  children,
  tone = "gold",
}: {
  children: React.ReactNode;
  tone?: "gold" | "jade" | "amber" | "vermilion";
}) {
  const map: Record<string, { bg: string; color: string; border: string }> = {
    gold: { bg: "var(--gold-soft)", color: "var(--gold-400)", border: "rgba(201,169,98,0.3)" },
    jade: { bg: "var(--jade-soft)", color: "var(--jade-400)", border: "rgba(74,154,106,0.3)" },
    amber: { bg: "var(--amber-soft)", color: "var(--amber-400)", border: "rgba(201,154,62,0.3)" },
    vermilion: {
      bg: "var(--vermilion-soft)",
      color: "var(--vermilion-400)",
      border: "rgba(196,74,74,0.3)",
    },
  };
  const s = map[tone];
  return (
    <span
      className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium"
      style={{ background: s.bg, color: s.color, borderColor: s.border }}
    >
      {children}
    </span>
  );
}

function RejectedCard({
  proposal,
  index,
}: {
  proposal: (typeof HC.rejected)[number];
  index: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="rounded-xl border transition-all"
      style={{
        borderColor: open ? "rgba(196,74,74,0.35)" : "var(--border-subtle)",
        background: "var(--bg-surface)",
      }}
    >
      <button
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={`rejected-detail-${index}`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold"
            style={{ background: "var(--vermilion-soft)", color: "var(--vermilion-400)" }}
          >
            {index + 1}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate" style={{ color: "var(--text-primary)" }}>
              {proposal.name}
            </div>
            <div className="text-xs truncate" style={{ color: "var(--text-tertiary)" }}>
              {proposal.summary}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Tag tone="vermilion">已否决</Tag>
          <svg
            className="h-4 w-4 transition-transform"
            style={{
              color: "var(--text-tertiary)",
              transform: open ? "rotate(180deg)" : "none",
            }}
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </button>
      <div id={`rejected-detail-${index}`} className={`collapse-grid ${open ? "open" : ""}`}>
        <div className="collapse-inner">
          <div
            className="border-t px-5 py-4"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            {/* Before/After metrics */}
            <div className="mb-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
                实测数据
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {proposal.metrics.map((m) => (
                  <div
                    key={m.label}
                    className="rounded-lg border px-3 py-2"
                    style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}
                  >
                    <div className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                      {m.label}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="font-mono text-xs tabular-nums" style={{ color: "var(--jade-400)" }}>
                        {m.before}
                      </span>
                      <svg className="h-3 w-3" style={{ color: "var(--text-tertiary)" }} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="font-mono text-xs tabular-nums" style={{ color: "var(--vermilion-400)" }}>
                        {m.after}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {/* Reason */}
            <div>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
                否决原因
              </div>
              <p className="text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                {proposal.reason}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   主组件
   ════════════════════════════════════════════════════════════ */

export default function ModelPage() {
  const [st, setSt] = useState<ModelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [visionSt, setVisionSt] = useState<any>(null);
  const [visionBusy, setVisionBusy] = useState(false);
  const { notify } = useToast();

  const load = useCallback(async () => {
    setSt(await api.modelStatus());
  }, []);

  useEffect(() => {
    load().catch(() => {});
    api.visionModelStatus().then(setVisionSt).catch(() => {});
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  const retrain = async () => {
    setBusy(true);
    notify("重训已在后台启动，完成后自动刷新…");
    try {
      await api.retrain();
    } finally {
      setTimeout(() => {
        setBusy(false);
        load();
      }, 3000);
    }
  };

  const rebuildVision = async () => {
    setVisionBusy(true);
    notify("正在重建红品识别特征库（GPU）…");
    try {
      const r = await api.visionModelRebuild();
      setVisionSt(await api.visionModelStatus());
      notify(`特征库重建完成：${r.samples} 样本 / ${r.distinct_names} 藏品（${r.device}）`);
    } finally {
      setTimeout(() => {
        setVisionBusy(false);
      }, 2500);
    }
  };

  /* ── ARD 特征重要性图 ── */
  const ardOption = useMemo(() => {
    // 优先用 API 返回的 importance，否则用硬编码
    let data: { name: string; value: number }[] = HC.ardImportance;

    if (st?.importance && Object.keys(st.importance).length > 0) {
      const names: Record<string, string> = {
        red_avg: "红品均格",
        red_count: "红品件数",
        red_grids: "红品总格数",
        known_size: "已知红品格数",
        log_known_value: "已知红品价值(log)",
        known_ratio: "已知价值/图鉴均值比",
        game_no_norm: "场次(时间漂移)",
        rule_red_log: "规则红品估值(log)",
        rule_full_log: "规则全场估值(log)",
      };
      data = Object.entries(st.importance)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => ({ name: names[k] ?? k, value: +v.toFixed(3) }));
    }

    return {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: CHART.tooltipBg,
        borderColor: CHART.tooltipBorder,
        textStyle: { color: CHART.textPrimary, fontSize: 13 },
        formatter: (params: any) =>
          `${params[0].name}<br/>重要性: <b>${params[0].value.toFixed(3)}</b>`,
      },
      grid: { left: 130, right: 30, top: 8, bottom: 20 },
      xAxis: {
        type: "value",
        max: 1,
        axisLabel: { color: CHART.textTertiary, fontSize: 11 },
        splitLine: { lineStyle: { color: CHART.splitLine } },
        axisLine: { show: false },
      },
      yAxis: {
        type: "category",
        data: data.map((d) => d.name),
        axisLabel: { color: CHART.textSecondary, fontSize: 12 },
        axisLine: { lineStyle: { color: CHART.border } },
        axisTick: { show: false },
      },
      series: [
        {
          type: "bar",
          data: data.map((d) => d.value),
          itemStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 1,
              y2: 0,
              colorStops: [
                { offset: 0, color: CHART.goldDim },
                { offset: 1, color: CHART.gold },
              ],
            },
            borderRadius: [0, 4, 4, 0],
          },
          barWidth: 14,
          label: {
            show: true,
            position: "right",
            color: CHART.textTertiary,
            fontSize: 11,
            formatter: (p: any) => p.value.toFixed(2),
          },
        },
      ],
    };
  }, [st]);

  /* ── 校准曲线（保留原有逻辑，迁移色值）── */
  const calibOption = useMemo(() => {
    const c = st?.calibration_curve;
    if (!c || c.pred.length === 0) return null;
    return {
      tooltip: {
        trigger: "axis",
        backgroundColor: CHART.tooltipBg,
        borderColor: CHART.tooltipBorder,
        textStyle: { color: CHART.textPrimary, fontSize: 13 },
      },
      legend: { textStyle: { color: CHART.textSecondary }, top: 0 },
      grid: { left: 56, right: 20, top: 34, bottom: 36 },
      xAxis: {
        type: "value",
        name: "预测",
        nameTextStyle: { color: CHART.textTertiary },
        axisLabel: { color: CHART.textTertiary, formatter: (v: number) => (v / 10000).toFixed(0) + "万" },
        splitLine: { lineStyle: { color: CHART.splitLine } },
        axisLine: { lineStyle: { color: CHART.border } },
      },
      yAxis: {
        type: "value",
        name: "实际",
        nameTextStyle: { color: CHART.textTertiary },
        axisLabel: { color: CHART.textTertiary, formatter: (v: number) => (v / 10000).toFixed(0) + "万" },
        splitLine: { lineStyle: { color: CHART.splitLine } },
        axisLine: { lineStyle: { color: CHART.border } },
      },
      series: [
        {
          type: "line",
          name: "校准曲线",
          data: c.pred.map((p, i) => [p, c.actual[i]]),
          smooth: true,
          symbolSize: 8,
          itemStyle: { color: CHART.jade },
          lineStyle: { color: CHART.jade, width: 2 },
        },
        {
          type: "line",
          name: "理想一致",
          data: [
            [0, 0],
            [5000000, 5000000],
          ],
          lineStyle: { type: "dashed", color: CHART.textTertiary, width: 1 },
          symbol: "none",
        },
      ],
    };
  }, [st]);

  const trained = st?.trained ?? false;
  const nSamples = st?.n ?? HC.ardImportance.length; // fallback
  const fullMape = st?.loocv?.full.mape_pct ?? HC.fullMape;
  const coverage = st?.loocv?.coverage_pct ?? HC.fullCoverage;

  /* ── 空状态 ── */
  if (!st)
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div
          className="flex h-16 w-16 items-center justify-center rounded-full"
          style={{ background: "var(--gold-soft)" }}
        >
          <svg className="h-8 w-8 animate-pulse" style={{ color: "var(--gold-400)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" />
          </svg>
        </div>
        <p className="mt-4 text-sm" style={{ color: "var(--text-secondary)" }}>
          正在加载模型状态…
        </p>
      </div>
    );

  return (
    <div className="space-y-5">
      {/* ═══ 1. 模型总览 ═══ */}
      <Card
        title="模型总览"
        desc="规则先验 + 残差回归集成：GP / HGB / BayesRidge 三模型等权融合"
        right={
          <button className="btn-primary !py-2 text-xs" onClick={retrain} disabled={busy}>
            {busy ? "重训中…" : "立即重训"}
          </button>
        }
      >
        {!trained ? (
          /* 空状态 */
          <div className="flex flex-col items-center justify-center py-12">
            <div
              className="flex h-14 w-14 items-center justify-center rounded-full"
              style={{ background: "var(--amber-soft)" }}
            >
              <svg className="h-7 w-7" style={{ color: "var(--amber-400)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="mt-3 text-sm font-medium" style={{ color: "var(--text-primary)" }}>
              模型未训练
            </p>
            <p className="mt-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
              样本不足 {st.n} 条，需 ≥6 场结算后自动重训
            </p>
            <p className="mt-0.5 text-xs" style={{ color: "var(--text-tertiary)" }}>
              完成对局结算后会自动加入训练集
            </p>
          </div>
        ) : (
          <>
            {/* 4 个指标卡 */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard
                label="全场 MAPE"
                value={`${fullMape.toFixed(1)}%`}
                sub={`红品 MAPE ${HC.redMape.toFixed(1)}%`}
                tone={fullMape <= 22 ? "jade" : "amber"}
              />
              <MetricCard
                label="90% 区间覆盖率"
                value={`${coverage.toFixed(1)}%`}
                sub={`红品 ${HC.redCoverage.toFixed(0)}%`}
                tone={coverage >= 85 ? "jade" : "vermilion"}
              />
              <MetricCard
                label="训练样本"
                value={`${st.n}`}
                sub={`训练于 ${st.trained_at?.slice(5, 16) ?? "—"}`}
                tone="gold"
              />
              <MetricCard
                label="重训耗时"
                value={`${HC.retrainSeconds}s`}
                sub="含 LOOCV 交叉验证"
                tone="default"
              />
            </div>

            {/* 按时间序切分（如果有） */}
            {st.chrono && (
              <div
                className="mt-3 flex flex-wrap gap-4 rounded-xl border px-4 py-3 text-xs"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-input)",
                  color: "var(--text-secondary)",
                }}
              >
                <span>按时间序切分（前 70% 训练）：</span>
                <span>MAPE {fmtPct(st.chrono.full.mape_pct)}</span>
                <span>R² {st.chrono.full.r2_log.toFixed(3)}</span>
                <span>区间覆盖率 {st.chrono.coverage_pct}%</span>
              </div>
            )}
          </>
        )}
      </Card>

      {trained && (
        <>
          {/* ═══ 2. 三模型集成 + 区间校准 ═══ */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* 左侧：三模型详情 */}
            <Card title="三模型集成详情" desc="GP / HGB / BayesRidge 等权平均融合">
              <div className="space-y-4">
                {/* 融合策略标签 */}
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                    融合策略
                  </span>
                  <Tag tone="gold">{HC.fusionStrategy}</Tag>
                  <Tag tone="jade">GP σ + Conformal</Tag>
                </div>

                {/* GP 模型 */}
                <div
                  className="rounded-xl border p-4"
                  style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                      Gaussian Process
                    </span>
                    <Tag tone="gold">主力模型</Tag>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                    <InfoRow label="核函数" value={HC.gpKernel} />
                    <InfoRow label="n_restarts" value={HC.gpRestarts} />
                    <InfoRow label="WhiteKernel" value="0.05" />
                    <InfoRow label="ARD" value="启用" />
                  </div>
                </div>

                {/* HGB 模型 */}
                <div
                  className="rounded-xl border p-4"
                  style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                      HistGradientBoosting
                    </span>
                    <Tag tone="amber">残差修正</Tag>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                    <InfoRow label="max_depth" value={HC.hgbConfig.maxDepth} />
                    <InfoRow label="max_leaf_nodes" value={HC.hgbConfig.maxLeafNodes} />
                    <InfoRow label="max_iter" value={HC.hgbConfig.maxIter} />
                    <InfoRow label="早停" value={HC.hgbConfig.earlyStopping ? "启用" : "关闭"} />
                  </div>
                </div>

                {/* BayesRidge 模型 */}
                <div
                  className="rounded-xl border p-4"
                  style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                      BayesianRidge
                    </span>
                    <Tag tone="jade">稳定基线</Tag>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                    <InfoRow label="参数" value="默认" />
                    <InfoRow label="先验" value="弱信息" />
                  </div>
                </div>
              </div>
            </Card>

            {/* 右侧：区间校准面板 */}
            <Card title="区间校准面板" desc="自适应区间宽度：GP 后验 σ × Conformal 校准乘子">
              <div className="space-y-4">
                {/* 方法信息 */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                    校准策略
                  </span>
                  <Tag tone="gold">{HC.calibrationStrategy}</Tag>
                  <Tag tone="jade">{HC.intervalMethod}</Tag>
                </div>

                {/* 4 桶详情表格 */}
                <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--border-subtle)" }}>
                  <table className="w-full text-sm" aria-label="区间校准 4 桶详情：均格范围、样本数、k_red 与 k_full 乘子">
                    <thead>
                      <tr style={{ background: "var(--bg-input)" }}>
                        <th className="px-4 py-2.5 text-left text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                          均格范围
                        </th>
                        <th className="px-4 py-2.5 text-right text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                          样本数
                        </th>
                        <th className="px-4 py-2.5 text-right text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                          k_red
                        </th>
                        <th className="px-4 py-2.5 text-right text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                          k_full
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {HC.buckets.map((b, i) => (
                        <tr
                          key={i}
                          className="border-t"
                          style={{
                            borderColor: "var(--border-subtle)",
                            background: i % 2 === 0 ? "transparent" : "var(--bg-input)",
                          }}
                        >
                          <td className="px-4 py-2.5">
                            <span className="font-mono text-xs tabular-nums" style={{ color: "var(--text-primary)" }}>
                              {b.range}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <span className="font-mono text-xs tabular-nums" style={{ color: "var(--text-secondary)" }}>
                              {b.samples}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <span
                              className="font-mono text-xs font-medium tabular-nums"
                              style={{
                                color:
                                  b.kRed > 1.15
                                    ? "var(--vermilion-400)"
                                    : b.kRed > 0.95
                                    ? "var(--gold-400)"
                                    : "var(--jade-400)",
                              }}
                            >
                              {b.kRed.toFixed(2)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <span
                              className="font-mono text-xs font-medium tabular-nums"
                              style={{
                                color:
                                  b.kFull > 1.15
                                    ? "var(--vermilion-400)"
                                    : b.kFull > 0.95
                                    ? "var(--gold-400)"
                                    : "var(--jade-400)",
                              }}
                            >
                              {b.kFull.toFixed(2)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* k 值说明 */}
                <p className="text-xs leading-relaxed" style={{ color: "var(--text-tertiary)" }}>
                  k 值为区间乘子：k &gt; 1.15 表示该区间偏窄需放宽（朱红），k &lt; 0.95 表示偏宽可收紧（翠绿），
                  0.95–1.15 为合理范围（鎏金）。
                </p>
              </div>
            </Card>
          </div>

          {/* ═══ 3. ARD 特征重要性 ═══ */}
          <Card
            title="特征重要性（GP ARD 长度尺度倒数）"
            desc="ARD 自动学习各特征的相关性：长度尺度越短 → 重要性越高"
          >
            <Chart option={ardOption} height={320} ariaLabel="横向柱状图：GP ARD 长度尺度倒数表示的特征重要性（值越大越重要）" />
          </Card>

          {/* ═══ 4. 校准曲线（保留） ═══ */}
          {calibOption && (
            <Card title="校准曲线" desc="预测均值 vs 实际均值（分桶）">
              <Chart option={calibOption} height={280} ariaLabel="折线图：校准曲线（预测均值 vs 实际均值），虚线为理想一致线" />
            </Card>
          )}
        </>
      )}

      {/* ═══ 5. 红品识别模型（保留，迁移色值） ═══ */}
      <Card
        title="红品识别模型"
        desc="ResNet50 特征库 + 图库匹配：样本越多、越准确；重建可刷新 GPU 特征缓存"
        right={
          <button className="btn-primary !py-2 text-xs" onClick={rebuildVision} disabled={visionBusy}>
            {visionBusy ? "重建中…" : "重建特征库"}
          </button>
        }
      >
        {!visionSt?.trained ? (
          <div className="py-6 text-center text-sm" style={{ color: "var(--text-secondary)" }}>
            红品识别模型未就绪：请先在「图像学习」页框选藏品图标入库。
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="学习样本" value={visionSt.samples} sub={`图库条目 ${visionSt.total_entries}`} />
              <Stat label="藏品数" value={visionSt.distinct_names} />
              <Stat label="手工学习" value={visionSt.learn_samples} tone="accent" />
              <Stat
                label="推理设备"
                value={visionSt.gpu_name ? "GPU" : "CPU"}
                sub={visionSt.gpu_name ?? visionSt.device}
                tone="ok"
              />
              <Stat label="FP16" value={visionSt.fp16 ? "启用" : "关闭"} tone="money" />
            </div>
            {visionSt.distribution && (
              <div
                className="mt-3 flex flex-wrap gap-4 rounded-xl border px-4 py-3 text-xs"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-input)",
                  color: "var(--text-secondary)",
                }}
              >
                <span>同款中位相似度 {visionSt.distribution.same?.median ?? "—"}</span>
                <span>异款最高 {visionSt.distribution.diff?.max ?? "—"}</span>
                <span>区分度 {visionSt.distribution.gap_median_vs_max ?? "—"}</span>
              </div>
            )}
          </>
        )}
      </Card>

      {/* ═══ 6. 否决方案记录 ═══ */}
      {trained && (
        <Card title="否决方案记录" desc="已验证并排除的方案，防止重复尝试">
          <div className="space-y-3">
            {HC.rejected.map((p, i) => (
              <RejectedCard key={i} proposal={p} index={i} />
            ))}
          </div>
        </Card>
      )}

      {/* ═══ 7. 持续学习说明（保留） ═══ */}
      <Card title="持续学习说明" desc="">
        <ul className="list-inside list-disc space-y-1.5 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          <li>
            每完成一场结算（历史复盘页录入真值），系统自动把该场加入训练集并后台重训。
          </li>
          <li>
            新对局估值时，若模型已训练（≥6 样本），会用模型修正规则估值并给出经验区间。
          </li>
          <li>
            区间由 GP 后验 σ × Conformal 校准乘子计算，输入越接近训练分布区间越窄。
          </li>
          <li>
            样本越少区间越宽；积累到 20–40 场后误差会明显收敛。
          </li>
        </ul>
      </Card>
    </div>
  );
}
