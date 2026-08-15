import type { ReactNode } from "react";
import { AnimatedNumber } from "../../components/AnimatedNumber";

interface ResultCardProps {
  label: string;
  /** 静态值（字符串/节点） */
  value?: ReactNode;
  /** 动态滚动数值：与 format 搭配使用，渲染为数字滚动动画 */
  valueNum?: number;
  format?: (n: number) => string;
  sub?: ReactNode;
  tone?: "default" | "gold" | "jade" | "vermilion" | "amber";
  icon?: ReactNode;
  className?: string;
}

const toneStyles: Record<string, { value: string; border: string; bg: string }> = {
  default: {
    value: "var(--text-primary)",
    border: "var(--border-subtle)",
    bg: "var(--bg-surface)",
  },
  gold: {
    value: "var(--gold-300)",
    border: "rgba(201, 169, 98, 0.35)",
    bg: "var(--gold-soft)",
  },
  jade: {
    value: "var(--jade-400)",
    border: "rgba(74, 154, 106, 0.35)",
    bg: "var(--jade-soft)",
  },
  vermilion: {
    value: "var(--vermilion-400)",
    border: "rgba(196, 74, 74, 0.35)",
    bg: "var(--vermilion-soft)",
  },
  amber: {
    value: "var(--amber-400)",
    border: "rgba(201, 154, 62, 0.35)",
    bg: "var(--amber-soft)",
  },
};

export function ResultCard({ label, value, valueNum, format, sub, tone = "default", icon, className = "" }: ResultCardProps) {
  const s = toneStyles[tone];
  return (
    <div
      className={`rounded-xl border p-5 transition-all duration-300 ${className}`}
      style={{ borderColor: s.border, background: s.bg }}
    >
      <div className="flex items-center gap-2 text-xs font-medium tracking-wide" style={{ color: "var(--text-secondary)" }}>
        {icon}
        <span>{label}</span>
      </div>
      <div
        className="mt-2 font-mono text-2xl font-semibold tabular-nums lg:text-3xl"
        style={{ color: s.value, fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace" }}
      >
        {valueNum !== undefined ? (
          <AnimatedNumber value={valueNum} format={format} />
        ) : (
          value
        )}
      </div>
      {sub && (
        <div className="mt-1.5 text-xs" style={{ color: "var(--text-tertiary)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}
