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
    <section className={`card p-5 ${className}`}>
      {(title || right) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h3 className="text-sm font-semibold text-slate-800">{title}</h3>}
            {desc && <p className="mt-0.5 text-xs text-slate-500">{desc}</p>}
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
  const tones: Record<string, string> = {
    default: "text-slate-800",
    accent: "text-indigo-600",
    money: "text-emerald-600",
    danger: "text-rose-600",
    ok: "text-teal-600",
  };
  return (
    <div className="rounded-xl border border-ink-700/70 bg-ink-900/60 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tones[tone]}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
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
