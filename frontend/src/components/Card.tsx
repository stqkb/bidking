import type { ReactNode } from "react";

interface Props {
  title?: string;
  desc?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Card({ title, desc, right, children, className = "" }: Props) {
  return (
    <section className={`card p-6 ${className}`}>
      {(title || right) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && (
              <h3
                className="text-[13px] font-medium uppercase tracking-[0.05em]"
                style={{ color: "var(--text-secondary)" }}
              >
                {title}
              </h3>
            )}
            {desc && (
              <p className="mt-0.5 text-xs" style={{ color: "var(--text-tertiary)" }}>
                {desc}
              </p>
            )}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "accent" | "money" | "danger" | "ok";
}) {
  const toneColor: Record<string, string> = {
    default: "var(--text-primary)",
    accent: "var(--gold-400)",
    money: "var(--jade-400)",
    danger: "var(--vermilion-400)",
    ok: "var(--jade-400)",
  };
  return (
    <div
      className="rounded-xl border px-4 py-3"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}
    >
      <div className="text-xs" style={{ color: "var(--text-secondary)" }}>{label}</div>
      <div
        className="mt-1 font-mono text-xl font-medium tabular-nums"
        style={{ color: toneColor[tone] }}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs" style={{ color: "var(--text-tertiary)" }}>{sub}</div>}
    </div>
  );
}

export function Badge({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}
