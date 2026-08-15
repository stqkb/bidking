import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

type Tone = "gold" | "jade" | "vermilion" | "amber";

interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
}

interface ToastContextValue {
  notify: (message: string, tone?: Tone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** 在组件内调用以获取 notify；无 Provider 时静默降级。 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) return { notify: () => {} };
  return ctx;
}

const toneMap: Record<Tone, { bg: string; color: string; border: string }> = {
  gold: { bg: "var(--gold-soft)", color: "var(--gold-400)", border: "rgba(201,169,98,0.4)" },
  jade: { bg: "var(--jade-soft)", color: "var(--jade-400)", border: "rgba(74,154,106,0.4)" },
  vermilion: { bg: "var(--vermilion-soft)", color: "var(--vermilion-400)", border: "rgba(196,74,74,0.4)" },
  amber: { bg: "var(--amber-soft)", color: "var(--amber-400)", border: "rgba(201,154,62,0.4)" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const notify = useCallback((message: string, tone: Tone = "gold") => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, message, tone }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      {/* 右上角通知栈：滑入 3s 后自动滑出（由 .toast-enter 动画驱动） */}
      <div
        className="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(92vw,360px)] flex-col gap-2"
        aria-live="polite"
        aria-atomic="false"
      >
        {items.map((t) => (
          <ToastCard key={t.id} item={t} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ item }: { item: ToastItem }) {
  const s = toneMap[item.tone];
  return (
    <div
      className="toast-enter pointer-events-auto flex items-start gap-2 rounded-xl border px-4 py-2.5 text-sm shadow-lg"
      style={{ background: s.bg, color: s.color, borderColor: s.border }}
      role="status"
    >
      <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M5.5 8l1.8 1.8L10.5 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span style={{ color: "var(--text-primary)" }}>{item.message}</span>
    </div>
  );
}
