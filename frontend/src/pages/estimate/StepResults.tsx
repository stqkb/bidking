import { useMemo, useState } from "react";
import { api } from "../../api";
import Chart from "../../components/Chart";
import { CHART } from "../../theme/chartTokens";
import { useToast } from "../../components/Toast";
import type { GridStat } from "../../types";
import { fmtWan, fmtMoney, riskColor } from "../../utils";
import type { WizardContext } from "./wizardTypes";
import { ResultCard } from "./ResultCard";
import { IntervalBar } from "./IntervalBar";
import { ProfitCard } from "./ProfitCard";
import { CandidateList } from "./CandidateList";

export function StepResults({ ctx }: { ctx: WizardContext }) {
  const { state, dispatch } = ctx;
  const result = state.result;
  const { notify } = useToast();
  const [archiving, setArchiving] = useState(false);

  const hasKnown = state.knownItems.some((k) => {
    const s = parseFloat(k.size);
    return !Number.isNaN(s);
  });

  /* ── 一键归档：POST /api/quick-archive（参数 + 结果）。
       后端未开放该端点或失败时，Toast 提示「后端接口待开放」 ── */
  const onQuickArchive = async () => {
    if (!result || !state.lastInput) return;
    setArchiving(true);
    try {
      const r = await api.quickArchive({ input: state.lastInput, result });
      notify(`已归档 #对局${r.game_no}`, "gold");
    } catch {
      notify("后端接口待开放", "amber");
    } finally {
      setArchiving(false);
    }
  };

  /* ── Chart option (reuse existing pattern) ── */
  const chartOption = useMemo(() => {
    if (!result) return {};
    const mk = (
      catIdx: number,
      _name: string,
      d: { p10: number; p50: number; p90: number; ev: number },
      color: string,
    ) => [
      {
        type: "bar",
        data: [[catIdx, d.p10]],
        stack: "v",
        itemStyle: { color, opacity: 0.18, borderRadius: [6, 6, 0, 0] },
        barWidth: 26,
      },
      {
        type: "bar",
        data: [[catIdx, d.p90 - d.p10]],
        stack: "v",
        itemStyle: { color, opacity: 0.55, borderRadius: [0, 0, 6, 6] },
        barWidth: 26,
        label: {
          show: true,
          position: "top",
          color: CHART.textSecondary,
          fontSize: 11,
          formatter: () => `${fmtWan(d.p10)} ~ ${fmtWan(d.p90)}`,
        },
      },
      {
        type: "scatter",
        symbol: "diamond",
        symbolSize: 10,
        data: [[catIdx, d.ev]],
        itemStyle: { color: CHART.textPrimary },
        tooltip: { formatter: () => `期望 ${fmtWan(d.ev)}` },
      },
    ];
    return {
      tooltip: { trigger: "item" },
      grid: { left: 46, right: 18, top: 34, bottom: 30 },
      xAxis: { type: "category", data: ["红品价值", "全场总价值"], axisLabel: { color: CHART.textSecondary } },
      yAxis: {
        type: "value",
        axisLabel: { color: CHART.textSecondary, formatter: (v: number) => fmtWan(v) },
        splitLine: { lineStyle: { color: CHART.border } },
      },
      series: [
        ...mk(0, "红品", result.red, CHART.goldDim),
        ...mk(1, "全场", result.full, CHART.jade),
      ],
    };
  }, [result]);

  if (!result) {
    return (
      <div
        className="flex h-64 items-center justify-center rounded-xl text-sm"
        style={{ color: "var(--text-tertiary)" }}
      >
        正在计算估值…
      </div>
    );
  }

  const shouldBid = result.bid.should_bid;
  const uncertaintyRatio = result.bid.uncertainty_ratio;

  return (
    <div className="space-y-5">
      {/* ════════════════════════════════════════════════════════════
          Core result row: Bid recommendation + Profit display
          （ProfitCard 在后端返回 bid.profit 前条件渲染 → 预留位置不显示，返回后自动生效）
          ════════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Recommended bid */}
        <ResultCard
          label={shouldBid ? "推荐出价" : "建议不出价"}
          valueNum={result.bid.recommended}
          format={fmtWan}
          sub={
            <>
              <span style={{ color: "var(--text-secondary)" }}>
                p10 × {(result.bid.margin * 100).toFixed(0)}%
              </span>
              {" · "}
              <span>天花板 {fmtWan(result.bid.max_bid)}</span>
            </>
          }
          tone={shouldBid ? "gold" : "vermilion"}
          icon={
            <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 1L10.5 5.5L15 6.5L11.5 10L12.5 14.5L8 12L3.5 14.5L4.5 10L1 6.5L5.5 5.5L8 1Z" />
            </svg>
          }
        />

        {/* Profit display — 后端返回 bid.profit 后自动显示；should_bid=false 时灰显「不建议出价」 */}
        {(result.bid.profit != null || !shouldBid) && <ProfitCard bid={result.bid} shouldBid={shouldBid} />}
      </div>

      {/* Interval bar (full width, below the core row) */}
      <div
        className="rounded-xl border p-5"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <IntervalBar
          p10={result.red.p10}
          p50={result.red.p50}
          ev={result.red.ev}
          p90={result.red.p90}
          uncertaintyRatio={uncertaintyRatio}
          label="红品价值区间"
        />
      </div>

      {/* ════════════════════════════════════════════════════════════
          Bid / no-bid banner + risk
          ════════════════════════════════════════════════════════════ */}
      <div
        className="rounded-xl border p-4"
        style={{
          borderColor: shouldBid ? "rgba(74, 154, 106, 0.4)" : "rgba(196, 74, 74, 0.5)",
          background: shouldBid ? "var(--jade-soft)" : "var(--vermilion-soft)",
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="text-lg font-bold"
            style={{ color: shouldBid ? "var(--jade-400)" : "var(--vermilion-400)" }}
          >
            {shouldBid ? "✓ 可以出价" : "✗ 不建议出价"}
          </span>
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${riskColor(result.bid.risk)}`}
          >
            {result.bid.risk}（区间倍数 ×{result.bid.risk_score.toFixed(1)}）
          </span>
          <span className="ml-auto text-xs" style={{ color: "var(--text-tertiary)" }}>
            全场估值模式：{result.full.mode === "细分" ? "逐品质细分" : "红品 × 实测倍率"}
          </span>
        </div>
        <p
          className="mt-2 text-sm"
          style={{ color: shouldBid ? "var(--jade-400)" : "var(--vermilion-400)" }}
        >
          {result.bid.bid_reason}
        </p>

        {/* Profit analysis */}
        {shouldBid && (
          <div
            className="mt-2 flex flex-wrap gap-4 rounded-lg p-3 text-sm"
            style={{ background: "var(--bg-input)" }}
          >
            <span style={{ color: "var(--text-secondary)" }}>
              最坏情况利润:{" "}
              <span className="font-semibold" style={{ color: "var(--jade-400)" }}>
                {fmtWan(result.bid.worst_case_profit)}
              </span>
            </span>
            <span style={{ color: "var(--text-secondary)" }}>
              期望利润:{" "}
              <span className="font-semibold" style={{ color: "var(--gold-300)" }}>
                {fmtWan(result.bid.expected_profit)}
              </span>
            </span>
            <span style={{ color: "var(--text-secondary)" }}>
              不确定性: p10/ev ={" "}
              <span className="font-semibold" style={{ color: "var(--text-primary)" }}>
                {(uncertaintyRatio * 100).toFixed(0)}%
              </span>
            </span>
          </div>
        )}
      </div>

      {/* ════════════════════════════════════════════════════════════
          Secondary metrics row
          ════════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ResultCard
          label="全场总价值（期望）"
          valueNum={result.full.ev}
          format={fmtWan}
          sub={`区间 ${fmtWan(result.full.p10)} ~ ${fmtWan(result.full.p90)}`}
          tone="jade"
        />
        <ResultCard
          label="红品期望价值"
          valueNum={result.red.ev}
          format={fmtWan}
          sub={`区间 ${fmtWan(result.red.p10)} ~ ${fmtWan(result.red.p90)}`}
          tone="gold"
        />
        <ResultCard
          label="绝对天花板"
          valueNum={result.bid.max_bid}
          format={fmtWan}
          sub="超过此价坚决放弃"
          tone={shouldBid ? "default" : "vermilion"}
        />
      </div>

      {/* ── Model badges ── */}
      <div className="flex flex-wrap gap-2">
        {result.ml?.available && (
          <span
            className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium"
            style={{ borderColor: "rgba(201, 169, 98, 0.4)", background: "var(--gold-soft)", color: "var(--gold-300)" }}
          >
            ML 修正 (n={result.ml.n})
          </span>
        )}
        {result.cnn?.ok && (
          <span
            className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium"
            style={{ borderColor: "rgba(201, 169, 98, 0.4)", background: "var(--gold-soft)", color: "var(--gold-300)" }}
          >
            CNN 融合
          </span>
        )}
        {result.calibration.factor !== 1 && (
          <span
            className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium"
            style={{ borderColor: "rgba(201, 169, 98, 0.4)", background: "var(--gold-soft)", color: "var(--gold-300)" }}
          >
            校准 ×{result.calibration.factor.toFixed(2)}
          </span>
        )}
      </div>

      {/* ════════════════════════════════════════════════════════════
          Save record section
          ════════════════════════════════════════════════════════════ */}
      <div
        className="flex flex-wrap items-end gap-3 rounded-xl border p-3"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}
      >
        <div className="w-40">
          <label className="field-label">我的出价（可选）</label>
          <input
            className="input"
            type="number"
            placeholder="如 800000"
            value={state.bidInput}
            onChange={(e) => dispatch({ type: "SET_BID_INPUT", value: e.target.value })}
          />
        </div>
        <button className="btn-ghost" onClick={ctx.onSaveRecord} disabled={state.saving}>
          {state.saving ? "保存中…" : "保存本场记录"}
        </button>
        <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          保存后到「历史复盘」录入结算，模型会自动重训
        </span>
        {state.savedMsg && (
          <span className="text-xs" style={{ color: "var(--jade-400)" }}>
            {state.savedMsg}
          </span>
        )}
      </div>

      {/* ════════════════════════════════════════════════════════════
          Value interval chart
          ════════════════════════════════════════════════════════════ */}
      <div className="card p-6">
        <h3 className="mb-1 text-sm font-medium tracking-wide" style={{ color: "var(--text-secondary)" }}>
          价值区间可视化
        </h3>
        <p className="mb-3 text-xs" style={{ color: "var(--text-tertiary)" }}>
          柱体为 p10–p90，◇ 为期望值
        </p>
        <Chart option={chartOption} height={240} ariaLabel="柱状图：红品与全场价值区间 p10 至 p90，菱形为期望值" />
      </div>

      {/* ════════════════════════════════════════════════════════════
          Candidate combinations
          ════════════════════════════════════════════════════════════ */}
      <div className="card p-6">
        <h3 className="mb-1 text-sm font-medium tracking-wide" style={{ color: "var(--text-secondary)" }}>
          格数组合候选
        </h3>
        <CandidateList
          candidates={result.candidates}
          lockedCand={state.lockedCand}
          avg={state.avg}
          hasKnown={hasKnown}
          onSelect={(cand) => ctx.onRunEstimate(cand)}
          onSizePop={(s) => ctx.onSizePop(s)}
        />

        {/* Size popup */}
        {ctx.sizePop !== null && ctx.gridStats[ctx.sizePop] && (
          <SizePopupContent
            size={ctx.sizePop}
            stat={ctx.gridStats[ctx.sizePop]}
            onClose={() => ctx.onSizePop(null)}
            onFill={() => ctx.onFillKnownSize(ctx.sizePop!)}
          />
        )}

        {/* Warnings */}
        {result.warnings.length > 0 && (
          <div
            className="mt-3 space-y-1 rounded-xl border px-3 py-2 text-xs"
            style={{
              borderColor: "rgba(201, 154, 62, 0.2)",
              background: "var(--amber-soft)",
              color: "var(--amber-400)",
            }}
          >
            {result.warnings.map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
          </div>
        )}
      </div>

      {/* ════════════════════════════════════════════════════════════
          Similar games reference
          ════════════════════════════════════════════════════════════ */}
      <div className="card p-6">
        <h3 className="mb-1 text-sm font-medium tracking-wide" style={{ color: "var(--text-secondary)" }}>
          历史同类局参考
        </h3>
        <p className="mb-3 text-xs" style={{ color: "var(--text-tertiary)" }}>
          均格接近的历史对局与成交结果
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="历史同类对局参考列表">
            <thead>
              <tr className="text-left text-xs" style={{ color: "var(--text-tertiary)" }}>
                <th className="py-1.5 pr-3">局</th>
                <th className="py-1.5 pr-3">格数组合</th>
                <th className="py-1.5 pr-3">红品总价值</th>
                <th className="py-1.5 pr-3">全场总价值</th>
                <th className="py-1.5 pr-3">成交价</th>
                <th className="py-1.5">结果</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {result.similar_games.map((g) => (
                <tr key={g.game_no} className="border-t" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
                  <td className="py-2 pr-3">{g.game_no}</td>
                  <td className="py-2 pr-3" style={{ color: "var(--text-tertiary)" }}>{g.grid_combo}</td>
                  <td className="py-2 pr-3">{fmtMoney(g.red_value)}</td>
                  <td className="py-2 pr-3">{fmtMoney(g.full_value)}</td>
                  <td className="py-2 pr-3">{fmtMoney(g.deal_price)}</td>
                  <td className="py-2">
                    {g.profit === null ? (
                      <span style={{ color: "var(--text-tertiary)" }}>—</span>
                    ) : g.profit >= 0 ? (
                      <span style={{ color: "var(--jade-400)" }}>+{fmtMoney(g.profit)}</span>
                    ) : (
                      <span style={{ color: "var(--vermilion-400)" }}>{fmtMoney(g.profit)}</span>
                    )}
                  </td>
                </tr>
              ))}
              {result.similar_games.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-3 text-center" style={{ color: "var(--text-tertiary)" }}>
                    暂无相近均格的历史对局
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════
          Navigation
          ════════════════════════════════════════════════════════════ */}
      <div className="flex items-center justify-between">
        <button className="btn-ghost" onClick={() => dispatch({ type: "PREV_STEP" })}>
          ← 调整参数
        </button>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => dispatch({ type: "RESET" })}>
            ↺ 新对局
          </button>
          <button className="btn-accent" onClick={onQuickArchive} disabled={archiving}>
            {archiving ? "归档中…" : "一键归档"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Size popup content (extracted for clarity) ── */
function SizePopupContent({
  size,
  stat,
  onClose,
  onFill,
}: {
  size: number;
  stat: GridStat;
  onClose: () => void;
  onFill: () => void;
}) {
  return (
    <div
      className="mt-3 rounded-xl border p-3"
      style={{ borderColor: "rgba(201, 169, 98, 0.4)", background: "var(--gold-soft)" }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold" style={{ color: "var(--gold-300)" }}>
          {size} 格藏品预期价格
        </span>
        <button
          className="rounded-lg px-2 py-0.5 text-sm transition hover:opacity-80"
          style={{ color: "var(--text-tertiary)" }}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div
        className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm tabular-nums md:grid-cols-3"
        style={{ color: "var(--text-secondary)" }}
      >
        <div>图鉴数量：{stat.count} 件</div>
        <div style={{ color: "var(--gold-300)" }}>期望（均值）：{fmtMoney(stat.mean)}</div>
        <div>中位数：{fmtMoney(stat.median)}</div>
        <div>区间 p10–p90：{fmtMoney(stat.p10)} ~ {fmtMoney(stat.p90)}</div>
        <div>最低：{fmtMoney(stat.min)}</div>
        <div>最高：{fmtMoney(stat.max)}</div>
      </div>
      <div className="mt-2">
        <button className="btn-ghost !h-7 !px-3 text-xs" onClick={onFill}>
          填入已知红品格数
        </button>
      </div>
    </div>
  );
}
