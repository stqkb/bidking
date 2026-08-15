import { useEffect, useRef } from "react";

interface Props {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  className?: string;
}

/**
 * 数字滚动动画：从上一值缓动到目标值（easeOutCubic）。
 * 尊重 prefers-reduced-motion：直接渲染终值，不做动画。
 */
export function AnimatedNumber({ value, format, duration = 800, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const render = (n: number) => {
      if (ref.current) ref.current.textContent = format ? format(n) : Math.round(n).toString();
    };

    if (reduce) {
      prev.current = value;
      render(value);
      return;
    }

    const start = prev.current;
    const end = value;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min((now - t0) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      render(start + (end - start) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = end;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, format]);

  return <span ref={ref} className={className} />;
}
