import { fmtWan } from "../../utils";

interface IntervalBarProps {
  p10: number;
  p50: number;
  ev: number;
  p90: number;
  /** uncertainty_ratio = p10 / ev. Higher = tighter interval = more confident */
  uncertaintyRatio: number;
  label?: string;
}

/**
 * Horizontal interval visualization:
 * p10 ──────●──── p50 ──●── p90
 *
 * Confidence color derived from uncertainty_ratio:
 *   >= 0.85 → jade (green, high confidence)
 *   >= 0.70 → amber (medium confidence)
 *   <  0.70 → vermilion (red, low confidence)
 */
export function IntervalBar({ p10, p50, ev, p90, uncertaintyRatio, label = "预测区间" }: IntervalBarProps) {
  const confidence = uncertaintyRatio;
  const confidencePct = Math.round(confidence * 100);

  let barColor: string;
  let glowColor: string;
  let labelColor: string;
  let bgColor: string;

  if (confidence >= 0.85) {
    barColor = "var(--jade-400)";
    glowColor = "rgba(91, 186, 138, 0.25)";
    labelColor = "var(--jade-400)";
    bgColor = "var(--jade-soft)";
  } else if (confidence >= 0.7) {
    barColor = "var(--amber-400)";
    glowColor = "rgba(224, 176, 86, 0.25)";
    labelColor = "var(--amber-400)";
    bgColor = "var(--amber-soft)";
  } else {
    barColor = "var(--vermilion-400)";
    glowColor = "rgba(224, 107, 107, 0.25)";
    labelColor = "var(--vermilion-400)";
    bgColor = "var(--vermilion-soft)";
  }

  // Compute positions (0-100%)
  const range = p90 - p10 || 1;
  const p50Pos = ((p50 - p10) / range) * 100;
  const evPos = ((ev - p10) / range) * 100;

  return (
    <div className="w-full">
      {/* Labels above bar */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium tracking-wide" style={{ color: "var(--text-secondary)" }}>
          {label}
        </span>
        <span
          className="rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums"
          style={{ color: labelColor, background: bgColor, border: `1px solid ${barColor}` }}
        >
          置信度 {confidencePct}%
        </span>
      </div>

      {/* The bar */}
      <div className="relative h-10 rounded-lg" style={{ background: "var(--bg-input)" }}>
        {/* Filled portion with gradient */}
        <div
          className="absolute inset-y-0 left-0 rounded-lg transition-all duration-500"
          style={{
            width: "100%",
            background: `linear-gradient(90deg, ${glowColor} 0%, ${barColor}22 50%, ${glowColor} 100%)`,
          }}
        />

        {/* p50 marker (diamond) */}
        <div
          className="absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 transition-all duration-500"
          style={{ left: `${Math.max(0, Math.min(100, p50Pos))}%` }}
        >
          <div
            className="h-3.5 w-3.5 rotate-45 rounded-[2px] border-2"
            style={{ borderColor: barColor, background: "var(--bg-surface)" }}
            title={`p50: ${fmtWan(p50)}`}
          />
        </div>

        {/* EV marker (circle) */}
        <div
          className="absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 transition-all duration-500"
          style={{ left: `${Math.max(0, Math.min(100, evPos))}%` }}
        >
          <div
            className="h-4 w-4 rounded-full border-2 shadow-md"
            style={{ borderColor: barColor, background: barColor, boxShadow: `0 0 8px ${glowColor}` }}
            title={`期望值: ${fmtWan(ev)}`}
          />
        </div>
      </div>

      {/* Labels below bar */}
      <div className="mt-2 flex items-center justify-between font-mono text-xs tabular-nums" style={{ color: "var(--text-tertiary)" }}>
        <span>p10 {fmtWan(p10)}</span>
        <span style={{ color: "var(--text-secondary)" }}>EV {fmtWan(ev)}</span>
        <span>p90 {fmtWan(p90)}</span>
      </div>
    </div>
  );
}
