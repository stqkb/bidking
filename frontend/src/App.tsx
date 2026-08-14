import { useEffect, useState } from "react";
import { api } from "./api";
import AnnotatePage from "./pages/AnnotatePage";
import CatalogPage from "./pages/CatalogPage";
import EstimatePage from "./pages/EstimatePage";
import ModelPage from "./pages/ModelPage";
import RecordsPage from "./pages/RecordsPage";

type PageKey = "estimate" | "records" | "model" | "catalog" | "annotate";

const NAV: { key: PageKey; label: string }[] = [
  { key: "estimate", label: "新对局估值" },
  { key: "records", label: "历史复盘" },
  { key: "model", label: "模型面板" },
  { key: "catalog", label: "图鉴管理" },
  { key: "annotate", label: "标注校准" },
];

export default function App() {
  const [page, setPage] = useState<PageKey>("estimate");
  const [health, setHealth] = useState<{ catalog: number; games: number } | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    const check = () => {
      api.health().then((h) => {
        setHealth(h);
        setOnline(true);
      }).catch(() => {
        setOnline(false);
      });
    };
    check();
    const t = setInterval(check, 20000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header
        className="flex h-14 shrink-0 items-center justify-between gap-4 border-b px-6"
        style={{ background: "var(--bg-primary)", borderColor: "var(--border-subtle)" }}
      >
        <div className="flex items-center gap-6">
          <div className="font-display text-[15px] font-semibold tracking-wide" style={{ color: "var(--text-primary)" }}>
            竞拍之王
          </div>
          <nav className="flex h-full items-center gap-5">
            {NAV.map((n) => {
              const active = page === n.key;
              return (
                <button
                  key={n.key}
                  onClick={() => setPage(n.key)}
                  className="relative flex h-full items-center text-[13px] transition"
                  style={{
                    color: active ? "var(--accent)" : "var(--text-secondary)",
                    fontWeight: active ? 500 : 400,
                  }}
                >
                  <span className="transition hover:opacity-80">{n.label}</span>
                  {active && (
                    <span
                      className="absolute inset-x-0 bottom-0 h-0.5"
                      style={{ background: "var(--accent)" }}
                    />
                  )}
                </button>
              );
            })}
          </nav>
        </div>
        <div className="hidden items-center gap-4 text-xs md:flex" style={{ color: "var(--text-tertiary)" }}>
          <span>图鉴 {health?.catalog ?? "—"} 件</span>
          <span>对局 {health?.games ?? "—"} 局</span>
        </div>
      </header>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-8">
          {online === false && (
            <div className="mb-5 rounded-lg border px-4 py-3 text-sm"
              style={{ borderColor: "rgba(154,74,74,0.4)", background: "rgba(154,74,74,0.1)", color: "var(--danger)" }}>
              未连接到后端服务。请关闭本页面，双击项目根目录的「启动.bat」启动后刷新（地址 http://127.0.0.1:8000）。
            </div>
          )}
          <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="font-display text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
                {NAV.find((n) => n.key === page)?.label}
              </h1>
              <p className="mt-0.5 text-sm" style={{ color: "var(--text-secondary)" }}>
                手动输入 → 规则反推 → 机器学习修正 → 出价建议
              </p>
            </div>
          </header>
          {page === "estimate" && <EstimatePage />}
          {page === "records" && <RecordsPage />}
          {page === "model" && <ModelPage />}
          {page === "catalog" && <CatalogPage />}
          {page === "annotate" && <AnnotatePage />}
        </div>
      </main>
    </div>
  );
}
