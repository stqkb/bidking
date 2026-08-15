import { useEffect, useState, useCallback } from "react";
import { api } from "../api";
import { fmtWan, fmtPct } from "../utils";
import Chart from "../components/Chart";
import { CHART } from "../theme/chartTokens";
import { AnimatedNumber } from "../components/AnimatedNumber";
import type { PageKey } from "../components/layout/Sidebar";
import type { GameRecord, ModelStatus } from "../types";

/* ════════════════════════════════════════════════════════════
   DashboardPage — 总览页
   一屏掌握全局：KPI 指标、准确率趋势、最近对局、快捷操作
   ════════════════════════════════════════════════════════════ */

interface AccuracyRow {
  game_no: number;
  red_avg: number;
  item: string;
  pred: number;
  actual: number;
  ratio: number;
}

interface DashboardPageProps {
  onNavigate: (page: PageKey) => void;
}

export default function DashboardPage({ onNavigate }: DashboardPageProps) {
  const [health, setHealth] = useState<{ catalog: number; games: number } | null>(null);
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [games, setGames] = useState<GameRecord[]>([]);
  const [accuracy, setAccuracy] = useState<AccuracyRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [h, m, g, acc] = await Promise.all([
        api.health(),
        api.modelStatus().catch(() => null),
        api.games().catch(() => ({ games: [] })),
        api.gameAccuracy().catch(() => ({ accuracy: [] })),
      ]);
      setHealth(h);
      setModel(m);
      setGames(g.games?.slice(-6).reverse() ?? []);
      setAccuracy(acc.accuracy ?? []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* ── KPI 指标卡数据 ── */
  const kpis = [
    {
      label: "历史对局",
      value: health?.games ?? "—",
      unit: "局",
      sub: "累计记录",
      tone: "default" as const,
    },
    {
      label: "图鉴藏品",
      value: health?.catalog ?? "—",
      unit: "件",
      sub: "红色品质",
      tone: "accent" as const,
    },
    {
      label: "LOOCV 误差",
      value: model?.loocv ? fmtPct(model.loocv.full.mape_pct) : "—",
      unit: "",
      sub: model?.loocv ? `R² = ${model.loocv.full.r2_log.toFixed(2)}` : "未训练",
      tone: model?.loocv && model.loocv.full.mape_pct < 25 ? "ok" : "danger",
    },
    {
      label: "训练样本",
      value: model?.n ?? "—",
      unit: "条",
      sub: model?.trained ? "已训练" : "未训练",
      tone: model?.trained ? "ok" : "default",
    },
  ];

  /* ── 准确率趋势图配置 ── */
  const chartOption = accuracy.length > 0
    ? {
        grid: { left: 55, right: 20, top: 30, bottom: 35 },
        tooltip: {
          trigger: "axis" as const,
          formatter: (params: any[]) => {
            const p = params[0];
            const row = accuracy[p.dataIndex];
            if (!row) return "";
            return `<div style="font-size:12px">
              <div style="color:${CHART.textPrimary};font-weight:600;margin-bottom:4px">对局 #${row.game_no}</div>
              <div style="color:${CHART.textSecondary}">均格: ${row.red_avg.toFixed(1)}</div>
              <div style="color:${CHART.gold}">预测: ${fmtWan(row.pred)}</div>
              <div style="color:${CHART.jade}">实际: ${fmtWan(row.actual)}</div>
              <div style="color:${CHART.amber}">偏差: ${fmtPct(Math.abs(1 - row.ratio) * 100)}</div>
            </div>`;
          },
        },
        xAxis: {
          type: "category" as const,
          data: accuracy.map((a) => `#${a.game_no}`),
          axisLabel: { color: CHART.textTertiary, fontSize: 11 },
          axisLine: { lineStyle: { color: CHART.border } },
        },
        yAxis: {
          type: "value" as const,
          axisLabel: {
            color: CHART.textTertiary,
            fontSize: 11,
            formatter: (v: number) => `${(v / 10000).toFixed(0)}万`,
          },
          splitLine: { lineStyle: { color: CHART.splitLine, type: "dashed" as const } },
          axisLine: { show: false },
        },
        series: [
          {
            name: "预测值",
            type: "line" as const,
            data: accuracy.map((a) => a.pred),
            smooth: true,
            symbol: "circle",
            symbolSize: 5,
            lineStyle: { color: CHART.gold, width: 2 },
            itemStyle: { color: CHART.gold },
          },
          {
            name: "实际值",
            type: "line" as const,
            data: accuracy.map((a) => a.actual),
            smooth: true,
            symbol: "circle",
            symbolSize: 5,
            lineStyle: { color: CHART.jade, width: 2 },
            itemStyle: { color: CHART.jade },
          },
        ],
        legend: {
          data: ["预测值", "实际值"],
          textStyle: { color: CHART.textSecondary, fontSize: 12 },
          top: 0,
          right: 0,
        },
      }
    : null;

  /* ── 快捷操作 ── */
  const quickActions: { label: string; desc: string; page: PageKey; icon: React.ReactNode }[] = [
    {
      label: "开始新对局估值",
      desc: "输入参数获取出价建议",
      page: "estimate",
      icon: (
        <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="10" cy="10" r="7.5" /><circle cx="10" cy="10" r="4" />
          <circle cx="10" cy="10" r="1" fill="currentColor" />
        </svg>
      ),
    },
    {
      label: "截图标注新对局",
      desc: "OCR 识别 + 红品检测",
      page: "annotate",
      icon: (
        <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2.5" y="4" width="15" height="12" rx="2" /><circle cx="10" cy="10" r="3" />
        </svg>
      ),
    },
    {
      label: "管理图鉴",
      desc: "藏品列表与学习样本",
      page: "catalog",
      icon: (
        <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 4.5C3 3.67 3.67 3 4.5 3H9v14H4.5C3.67 17 3 16.33 3 15.5V4.5Z" />
          <path d="M11 3H15.5C16.33 3 17 3.67 17 4.5V15.5C17 16.33 16.33 17 15.5 17H11V3Z" />
        </svg>
      ),
    },
    {
      label: "模型诊断",
      desc: "查看 ML 状态与指标",
      page: "model",
      icon: (
        <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="10" cy="10" r="2.5" />
          <path d="M10 2.5V4.5M10 15.5V17.5M17.5 10H15.5M4.5 10H2.5"
            strokeLinecap="round" />
        </svg>
      ),
    },
  ];

  /* ── 加载态 ── */
  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton h-28" />
          ))}
        </div>
        <div className="skeleton h-72" />
        <div className="skeleton h-48" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── KPI 指标卡 ── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((kpi, i) => {
          const toneColors: Record<string, string> = {
            default: "var(--text-primary)",
            accent: "var(--gold-400)",
            ok: "var(--jade-400)",
            danger: "var(--vermilion-400)",
          };
          return (
            <div
              key={i}
              className="stagger-item rounded-xl p-5"
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div
                className="text-xs font-medium tracking-wide"
                style={{ color: "var(--text-secondary)" }}
              >
                {kpi.label}
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span
                  className="font-mono text-2xl font-semibold tabular-nums"
                  style={{ color: toneColors[kpi.tone] }}
                >
                  {typeof kpi.value === "number" ? (
                    <AnimatedNumber value={kpi.value} format={(v) => Math.round(v).toLocaleString()} />
                  ) : (
                    kpi.value
                  )}
                </span>
                {kpi.unit && (
                  <span
                    className="text-sm"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {kpi.unit}
                  </span>
                )}
              </div>
              <div
                className="mt-1 text-xs"
                style={{ color: "var(--text-tertiary)" }}
              >
                {kpi.sub}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 准确率趋势 + 快捷操作 ── */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* 准确率趋势 */}
        <div
          className="rounded-xl p-5 lg:col-span-2"
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          <div className="mb-4 flex items-center justify-between">
            <h3
              className="text-sm font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              预测准确率趋势
            </h3>
            <span
              className="text-xs"
              style={{ color: "var(--text-tertiary)" }}
            >
              预测值 vs 实际值
            </span>
          </div>
          {chartOption ? (
            <Chart option={chartOption} height={260} ariaLabel="折线图：预测值与实际值准确率趋势" />
          ) : (
            <div
              className="flex h-[260px] items-center justify-center text-sm"
              style={{ color: "var(--text-tertiary)" }}
            >
              暂无准确率数据
            </div>
          )}
        </div>

        {/* 快捷操作 */}
        <div
          className="rounded-xl p-5"
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          <h3
            className="mb-4 text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            快捷操作
          </h3>
          <div className="space-y-2">
            {quickActions.map((action, i) => (
              <button
                key={i}
                onClick={() => onNavigate(action.page)}
                className="group flex w-full items-center gap-3 rounded-lg p-3 text-left transition-all duration-150 ease-out"
                style={{ background: "var(--bg-input)" }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-elevated)";
                  e.currentTarget.style.transform = "translateX(2px)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-input)";
                  e.currentTarget.style.transform = "translateX(0)";
                }}
              >
                <span style={{ color: "var(--gold-400)" }}>{action.icon}</span>
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-sm font-medium"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {action.label}
                  </div>
                  <div
                    className="truncate text-xs"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    {action.desc}
                  </div>
                </div>
                <svg
                  className="h-4 w-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  style={{ color: "var(--text-tertiary)" }}
                >
                  <path d="M6 4L10 8L6 12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── 最近对局 ── */}
      <div
        className="rounded-xl"
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
        }}
      >
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: "1px solid var(--border-subtle)" }}
        >
          <h3
            className="text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            最近对局
          </h3>
          <button
            onClick={() => onNavigate("records")}
            className="flex items-center gap-1 text-xs transition-colors"
            style={{ color: "var(--text-secondary)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gold-400)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
          >
            查看全部
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4.5 3L7.5 6L4.5 9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        {games.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="最近对局列表">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                  {["局号", "红品", "均格", "红品价值", "全场价值", "成交价", "收益"].map(
                    (h) => (
                      <th
                        key={h}
                        className="px-5 py-3 text-left text-xs font-medium tracking-wide"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {games.map((g) => {
                  const profit = g.profit;
                  const profitColor =
                    profit === null
                      ? "var(--text-tertiary)"
                      : profit > 0
                        ? "var(--jade-400)"
                        : profit < 0
                          ? "var(--vermilion-400)"
                          : "var(--text-secondary)";
                  return (
                    <tr
                      key={g.game_no}
                      style={{ borderBottom: "1px solid var(--bg-input)" }}
                    >
                      <td className="px-5 py-3 font-mono" style={{ color: "var(--text-secondary)" }}>
                        #{g.game_no}
                      </td>
                      <td className="px-5 py-3 font-mono tabular-nums" style={{ color: "var(--text-secondary)" }}>
                        {g.red_count} 件
                      </td>
                      <td className="px-5 py-3 font-mono tabular-nums" style={{ color: "var(--text-secondary)" }}>
                        {g.red_avg?.toFixed(1) ?? "—"}
                      </td>
                      <td className="px-5 py-3 font-mono tabular-nums" style={{ color: "var(--text-money)" }}>
                        {fmtWan(g.red_value)}
                      </td>
                      <td className="px-5 py-3 font-mono tabular-nums" style={{ color: "var(--text-money)" }}>
                        {fmtWan(g.full_value)}
                      </td>
                      <td className="px-5 py-3 font-mono tabular-nums" style={{ color: "var(--text-secondary)" }}>
                        {fmtWan(g.deal_price)}
                      </td>
                      <td className="px-5 py-3 font-mono tabular-nums" style={{ color: profitColor }}>
                        {profit !== null ? (profit > 0 ? "+" : "") + fmtWan(profit) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div
            className="flex h-32 items-center justify-center text-sm"
            style={{ color: "var(--text-tertiary)" }}
          >
            暂无对局记录
          </div>
        )}
      </div>
    </div>
  );
}
