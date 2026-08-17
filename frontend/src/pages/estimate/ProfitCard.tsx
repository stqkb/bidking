import type { EstimateResp } from "../../types";
import { fmtMoney, fmtPct } from "../../utils";

/**
 * 收益展示卡：预计收益 / 收益率 / 最差收益(p10) / 最好收益(p90)。
 * 正收益用 jade（绿） + "+"，负收益用 vermilion（红） + "-"；金额用系统等宽字体栈 + tabular-nums。
 * should_bid 为 false 时：整卡灰显，显示「不建议出价」。
 * |profit_rate| > 100 视为异常（多为缺 known_items 导致校准失真），不显示具体数字，改为 ">100%" 避免误导。
 */

const MONO = "ui-monospace, SFMono-Regular, 'Cascadia Mono', 'Segoe UI Mono', monospace";
const RATE_LIMIT = 100; // |profit_rate| 超过此值视为异常

function profitColor(v: number | null | undefined): string {
  if (v == null) return "var(--text-tertiary)";
  return v >= 0 ? "var(--jade-400)" : "var(--vermilion-400)";
}

function signedMoney(v: number | null | undefined): string {
  if (v == null) return "—";
  return (v >= 0 ? "+" : "") + fmtMoney(v);
}

/** 收益率：兼容百分比数值(11.1)与小数(0.111)两种后端返回形式。越界返回 ">100%" 占位。 */
function fmtRate(v: number | null | undefined): string {
  if (v == null) return "";
  const pct = Math.abs(v) <= 1 ? v * 100 : v;
  if (Math.abs(pct) > RATE_LIMIT) return ">100%";
  return fmtPct(pct);
}

function isRateAnomaly(v: number | null | undefined): boolean {
  if (v == null) return false;
  const pct = Math.abs(v) <= 1 ? v * 100 : v;
  return Math.abs(pct) > RATE_LIMIT;
}

export function ProfitCard({
  bid,
  shouldBid = true,
}: {
  bid: EstimateResp["bid"];
  shouldBid?: boolean;
}) {
  // ── 不建议出价：收益区灰显，提示不展示具体收益 ──
  if (!shouldBid) {
    return (
      <div
        className="rounded-xl border p-5"
        style={{
          borderColor: "var(--border-subtle)",
          background: "var(--bg-input)",
          opacity: 0.6,
        }}
      >
        <div
          className="flex items-center gap-2 text-xs font-medium tracking-wide"
          style={{ color: "var(--text-tertiary)" }}
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 11L6 7L9 10L14 4" />
            <path d="M11 4H14V7" />
          </svg>
          <span>预计收益</span>
        </div>
        <div
          className="mt-2 flex h-[3.25rem] items-center text-base font-semibold"
          style={{ color: "var(--text-tertiary)" }}
        >
          不建议出价
        </div>
      </div>
    );
  }

  const positive = (bid.profit ?? 0) >= 0;
  const mainColor = profitColor(bid.profit);
  const rateStr = fmtRate(bid.profit_rate);
  const rateAnomaly = isRateAnomaly(bid.profit_rate);
  const rateColor = rateAnomaly
    ? "var(--amber-400)"
    : bid.profit_rate == null
    ? "var(--text-tertiary)"
    : mainColor;

  return (
    <div
      className="rounded-xl border p-5"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
    >
      <div
        className="flex items-center gap-2 text-xs font-medium tracking-wide"
        style={{ color: "var(--text-secondary)" }}
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 11L6 7L9 10L14 4" />
          <path d="M11 4H14V7" />
        </svg>
        <span>预计收益</span>
      </div>

      {/* 主数值：预计收益 + 收益率（±X.X% 带符号展示） */}
      <div
        className="mt-2 font-mono text-2xl font-semibold tabular-nums lg:text-3xl"
        style={{ color: mainColor, fontFamily: MONO }}
      >
        {signedMoney(bid.profit)}
        {rateStr && (
          <span className="ml-1.5 text-base font-medium lg:text-xl" style={{ color: rateColor }}>
            {!rateAnomaly && positive ? "+" : ""}
            {rateStr}
          </span>
        )}
      </div>

      {/* 区间：最差(p10) / 最好(p90) */}
      <div className="mt-2 space-y-1 text-sm">
        <div className="flex items-center justify-between">
          <span style={{ color: "var(--text-tertiary)" }}>最差</span>
          <span className="font-mono font-semibold tabular-nums" style={{ color: profitColor(bid.profit_p10) }}>
            {signedMoney(bid.profit_p10)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span style={{ color: "var(--text-tertiary)" }}>最好</span>
          <span className="font-mono font-semibold tabular-nums" style={{ color: profitColor(bid.profit_p90) }}>
            {signedMoney(bid.profit_p90)}
          </span>
        </div>
      </div>
    </div>
  );
}
