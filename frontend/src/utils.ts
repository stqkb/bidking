export function fmtMoney(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return "¥" + Math.round(v).toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

export function fmtWan(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const w = v / 10000;
  if (w >= 10000) return (w / 10000).toFixed(2) + " 亿";
  if (w >= 100) return w.toFixed(0) + " 万";
  if (w >= 1) return w.toFixed(1) + " 万";
  return Math.round(v).toLocaleString("zh-CN");
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toFixed(1) + "%";
}

export function riskColor(risk: string): string {
  if (risk === "低") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (risk === "中") return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return "bg-rose-500/15 text-rose-300 border-rose-500/30";
}

export function clampNum(v: string, min: number, max: number): number | null {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return null;
  return Math.min(max, Math.max(min, n));
}
