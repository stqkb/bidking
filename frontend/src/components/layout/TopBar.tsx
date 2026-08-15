import { memo } from "react";
import type { PageKey } from "./Sidebar";

/* ════════════════════════════════════════════════════════════
   TopBar — 顶栏
   左：折叠按钮 + 页面标题
   右：通知铃铛 + 数据统计徽章
   ════════════════════════════════════════════════════════════ */

interface TopBarProps {
  currentPage: PageKey;
  online: boolean;
  ocrPending: number;
  health: { catalog: number; games: number } | null;
}

const PAGE_TITLES: Record<PageKey, { title: string; subtitle: string }> = {
  dashboard: { title: "总览", subtitle: "全局状态一览" },
  estimate: { title: "新对局估值", subtitle: "输入参数 → 规则反推 → ML 修正 → 出价建议" },
  catalog: { title: "图鉴管理", subtitle: "红色品质藏品图鉴与学习样本管理" },
  records: { title: "历史复盘", subtitle: "对局记录、估值准确率与校准分析" },
  annotate: { title: "标注校准", subtitle: "截图红品检测、OCR 识别与人工标注" },
  model: { title: "模型面板", subtitle: "ML/CNN/视觉模型状态与诊断" },
};

function TopBarImpl({
  currentPage,
  online,
  ocrPending,
  health,
}: TopBarProps) {
  const { title, subtitle } = PAGE_TITLES[currentPage];

  return (
    <header
      className="flex h-14 shrink-0 items-center justify-between gap-4 px-6"
      style={{
        background: "var(--bg-surface)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      {/* ── 左：页面标题 ── */}
      <div className="min-w-0">
        <h1
          className="truncate font-display text-base font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          {title}
        </h1>
        <p
          className="truncate text-xs"
          style={{ color: "var(--text-tertiary)" }}
        >
          {subtitle}
        </p>
      </div>

      {/* ── 右：状态区 ── */}
      <div className="flex shrink-0 items-center gap-4">
        {/* OCR 待确认通知 */}
        {ocrPending > 0 && (
          <button
            className="relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-150"
            style={{
              background: "var(--bg-input)",
              color: "var(--text-secondary)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-elevated)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-input)")}
            title={`${ocrPending} 个待确认 OCR 任务`}
          >
            <svg className="h-4 w-4" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3.5 7.5C3.5 5.01 5.51 3 8 3H10C12.49 3 14.5 5.01 14.5 7.5V11L15.5 13H2.5L3.5 11V7.5Z"
                strokeLinecap="round" strokeLinejoin="round" />
              <path d="M7.5 15.5C7.5 16.05 7.95 16.5 8.5 16.5C9.05 16.5 9.5 16.05 9.5 15.5"
                strokeLinecap="round" />
            </svg>
            <span
              className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold"
              style={{
                background: "var(--vermilion-500)",
                color: "var(--text-inverse)",
              }}
            >
              {ocrPending}
            </span>
          </button>
        )}

        {/* 后端在线指示 */}
        <div className="hidden items-center gap-2 text-xs md:flex">
          <span
            className="h-2 w-2 rounded-full"
            style={{
              background: online ? "var(--jade-500)" : "var(--vermilion-500)",
            }}
          />
          <span style={{ color: "var(--text-tertiary)" }}>
            {online ? "在线" : "离线"}
          </span>
        </div>

        {/* 数据统计 */}
        <div
          className="hidden items-center gap-3 rounded-lg px-3 py-1.5 text-xs lg:flex"
          style={{
            background: "var(--bg-input)",
            color: "var(--text-tertiary)",
          }}
        >
          <span>
            图鉴{" "}
            <span className="font-mono tabular-nums" style={{ color: "var(--text-secondary)" }}>
              {health?.catalog ?? "—"}
            </span>
          </span>
          <span style={{ color: "var(--border-default)" }}>·</span>
          <span>
            对局{" "}
            <span className="font-mono tabular-nums" style={{ color: "var(--text-secondary)" }}>
              {health?.games ?? "—"}
            </span>
          </span>
        </div>
      </div>
    </header>
  );
}

export const TopBar = memo(TopBarImpl);
