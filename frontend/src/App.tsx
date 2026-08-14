import { useEffect, useState } from "react";
import { api } from "./api";
import AnnotatePage from "./pages/AnnotatePage";
import CatalogPage from "./pages/CatalogPage";
import EstimatePage from "./pages/EstimatePage";
import ModelPage from "./pages/ModelPage";
import RecordsPage from "./pages/RecordsPage";

type PageKey = "estimate" | "records" | "model" | "catalog" | "annotate";

const NAV: { key: PageKey; label: string; icon: string }[] = [
  { key: "estimate", label: "新对局估值", icon: "⚡" },
  { key: "records", label: "历史复盘", icon: "📚" },
  { key: "model", label: "模型面板", icon: "🧠" },
  { key: "catalog", label: "图鉴管理", icon: "🗂️" },
  { key: "annotate", label: "标注校准", icon: "🎯" },
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
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-ink-700/70 bg-ink-900/60 p-4 md:flex">
        <div className="mb-6 flex items-center gap-2.5 px-1">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-lg shadow-lg shadow-indigo-500/30">
            🔨
          </div>
          <div>
            <div className="text-sm font-bold text-slate-800">竞拍之王</div>
            <div className="text-[11px] text-slate-500">红品估值 · 出价助手</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1">
          {NAV.map((n) => (
            <button
              key={n.key}
              onClick={() => setPage(n.key)}
              className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition ${
                page === n.key
                  ? "bg-indigo-500/15 font-semibold text-indigo-700 shadow-inner"
                  : "text-slate-500 hover:bg-ink-800 hover:text-slate-700"
              }`}
            >
              <span>{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
        <footer className="rounded-xl border border-ink-700/70 bg-ink-850 p-3 text-[11px] leading-relaxed text-slate-500">
          <div>图鉴 {health?.catalog ?? "—"} 件</div>
          <div>历史对局 {health?.games ?? "—"} 局</div>
          <div className="mt-1 text-slate-400">数据存于本机 · 自动学习</div>
        </footer>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
          {online === false && (
            <div className="mb-5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-700">
              未连接到后端服务。请关闭本页面，双击项目根目录的「启动.bat」启动后刷新（地址 http://127.0.0.1:8000）。
            </div>
          )}
          <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-slate-800">
                {NAV.find((n) => n.key === page)?.label}
              </h1>
              <p className="mt-0.5 text-sm text-slate-500">
                手动输入 → 规则反推 → 机器学习修正 → 出价建议
              </p>
            </div>
            <div className="flex gap-2 md:hidden">
              {NAV.map((n) => (
                <button
                  key={n.key}
                  onClick={() => setPage(n.key)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs ${
                    page === n.key ? "bg-indigo-500/20 text-indigo-700" : "text-slate-500"
                  }`}
                >
                  {n.label}
                </button>
              ))}
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
