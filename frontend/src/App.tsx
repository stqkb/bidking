import { useEffect, useState, Suspense, lazy } from "react";
import { api } from "./api";
import { Sidebar, type PageKey } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { ToastProvider } from "./components/Toast";
import { navigateTo } from "./nav";

/* ── 页面懒加载（code splitting，减少首屏 JS 体积） ── */
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const EstimatePage = lazy(() => import("./pages/EstimatePage"));
const CatalogPage = lazy(() => import("./pages/CatalogPage"));
const RecordsPage = lazy(() => import("./pages/RecordsPage"));
const AnnotatePage = lazy(() => import("./pages/AnnotatePage"));
const ModelPage = lazy(() => import("./pages/ModelPage"));

/* ── 页面骨架屏（懒加载时显示） ── */
function PageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="skeleton h-8 w-48" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton h-28" />
        ))}
      </div>
      <div className="skeleton h-72" />
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<PageKey>("estimate");
  const [collapsed, setCollapsed] = useState(false);
  const [health, setHealth] = useState<{ catalog: number; games: number } | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [mlTrained, setMlTrained] = useState<boolean | null>(null);
  const [ocrPending, setOcrPending] = useState(0);

  /* ── 健康检查轮询（20s） ── */
  useEffect(() => {
    const check = async () => {
      try {
        const h = await api.health();
        setHealth(h);
        setOnline(true);
      } catch {
        setOnline(false);
      }
    };
    check();
    const t = setInterval(check, 20000);
    return () => clearInterval(t);
  }, []);

  /* ── ML 模型状态轮询（30s） ── */
  useEffect(() => {
    const check = async () => {
      try {
        const m = await api.modelStatus();
        setMlTrained(m.trained);
      } catch {
        /* ignore */
      }
    };
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);

  /* ── OCR 待确认任务轮询（15s） ── */
  useEffect(() => {
    const check = async () => {
      try {
        const r = await api.ocrStatus();
        setOcrPending(r.pending_count ?? 0);
      } catch {
        /* ignore */
      }
    };
    check();
    const t = setInterval(check, 15000);
    return () => clearInterval(t);
  }, []);

  /* ── 页面切换动画 key ── */
  const [animKey, setAnimKey] = useState(0);
  const handleNavigate = (p: PageKey) => {
    if (p !== page) {
      setPage(p);
      setAnimKey((k) => k + 1);
    }
  };

  /* ── 跨页面导航事件（navigateTo 派发，用于 URL query 闭环） ── */
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ page: PageKey }>).detail;
      if (detail?.page) handleNavigate(detail.page);
    };
    window.addEventListener("app-navigate", onNav as EventListener);
    return () => window.removeEventListener("app-navigate", onNav as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  return (
    <ToastProvider>
      <div className="flex h-full">
        {/* ── 侧边栏 ── */}
      <Sidebar
        current={page}
        onNavigate={handleNavigate}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        health={health}
        online={online ?? false}
        mlTrained={mlTrained}
      />

      {/* ── 主区域 ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          currentPage={page}
          online={online ?? false}
          ocrPending={ocrPending}
          health={health}
        />

        {/* ── 离线警告条 ── */}
        {online === false && (
          <div
            className="flex items-center gap-2 px-6 py-2.5 text-sm"
            style={{
              background: "var(--vermilion-soft)",
              borderBottom: "1px solid var(--border-subtle)",
              color: "var(--vermilion-400)",
            }}
          >
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="6.5" />
              <path d="M8 5V9M8 11V11.01" strokeLinecap="round" />
            </svg>
            未连接到后端服务。请双击项目根目录的「启动.bat」启动后刷新（地址 http://127.0.0.1:8000）。
          </div>
        )}

        {/* ── 页面内容 ── */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div
            key={animKey}
            className="mx-auto max-w-[1400px] animate-fade-up px-6 py-8 lg:px-8"
          >
            <Suspense fallback={<PageSkeleton />}>
              {page === "dashboard" && <DashboardPage onNavigate={handleNavigate} />}
              {page === "estimate" && <EstimatePage />}
              {page === "catalog" && <CatalogPage />}
              {page === "records" && <RecordsPage />}
              {page === "annotate" && <AnnotatePage />}
              {page === "model" && <ModelPage />}
            </Suspense>
          </div>
        </main>
      </div>
    </div>
    </ToastProvider>
  );
}
