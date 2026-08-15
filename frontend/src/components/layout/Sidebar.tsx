import { memo } from "react";

/* ════════════════════════════════════════════════════════════
   Sidebar — 侧边栏导航
   可折叠：展开 240px / 折叠 64px
   ════════════════════════════════════════════════════════════ */

export type PageKey =
  | "dashboard"
  | "estimate"
  | "catalog"
  | "records"
  | "annotate"
  | "model";

interface NavItem {
  key: PageKey;
  label: string;
  icon: React.ReactNode;
}

/* ── 图标（inline SVG，无外部依赖） ── */

const iconClass = "w-5 h-5 shrink-0";

const ICONS: Record<PageKey, React.ReactNode> = {
  dashboard: (
    <svg className={iconClass} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" />
      <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" />
    </svg>
  ),
  estimate: (
    <svg className={iconClass} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="10" r="7.5" />
      <circle cx="10" cy="10" r="4" />
      <circle cx="10" cy="10" r="1" fill="currentColor" />
    </svg>
  ),
  catalog: (
    <svg className={iconClass} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 4.5C3 3.67 3.67 3 4.5 3H9v14H4.5C3.67 17 3 16.33 3 15.5V4.5Z" />
      <path d="M11 3H15.5C16.33 3 17 3.67 17 4.5V15.5C17 16.33 16.33 17 15.5 17H11V3Z" />
    </svg>
  ),
  records: (
    <svg className={iconClass} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 10C3 6.13 6.13 3 10 3C13.87 3 17 6.13 17 10C17 13.87 13.87 17 10 17" />
      <path d="M3 10L5 8M3 10L5 12" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 6.5V10L12.5 12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  annotate: (
    <svg className={iconClass} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2.5" y="4" width="15" height="12" rx="2" />
      <circle cx="10" cy="10" r="3" />
      <path d="M6.5 4L7.5 2H12.5L13.5 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  model: (
    <svg className={iconClass} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5V4.5M10 15.5V17.5M17.5 10H15.5M4.5 10H2.5M15.3 4.7L13.9 6.1M6.1 13.9L4.7 15.3M15.3 15.3L13.9 13.9M6.1 6.1L4.7 4.7"
        strokeLinecap="round" />
    </svg>
  ),
};

const NAV_ITEMS: NavItem[] = [
  { key: "dashboard", label: "总览", icon: ICONS.dashboard },
  { key: "estimate", label: "新对局估值", icon: ICONS.estimate },
  { key: "catalog", label: "图鉴管理", icon: ICONS.catalog },
  { key: "records", label: "历史复盘", icon: ICONS.records },
  { key: "annotate", label: "标注校准", icon: ICONS.annotate },
  { key: "model", label: "模型面板", icon: ICONS.model },
];

interface SidebarProps {
  current: PageKey;
  onNavigate: (page: PageKey) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  health: { catalog: number; games: number } | null;
  online: boolean;
  mlTrained: boolean | null;
}

function SidebarImpl({
  current,
  onNavigate,
  collapsed,
  onToggleCollapse,
  health,
  online,
  mlTrained,
}: SidebarProps) {
  return (
    <aside
      className="flex h-full shrink-0 flex-col transition-all duration-300 ease-out"
      style={{
        width: collapsed ? 64 : 240,
        background: "var(--bg-surface)",
        borderRight: "1px solid var(--border-subtle)",
      }}
    >
      {/* ── Logo 区 ── */}
      <div
        className="flex h-14 shrink-0 items-center gap-3 px-4"
        style={{ borderBottom: "1px solid var(--border-subtle)" }}
      >
        <svg
          className="h-7 w-7 shrink-0"
          viewBox="0 0 28 28"
          fill="none"
        >
          <rect width="28" height="28" rx="6" fill="var(--gold-500)" />
          <path
            d="M8 9.5C8 8.67 8.67 8 9.5 8H18.5C19.33 8 20 8.67 20 9.5V11C20 14.87 16.87 18 13 18H9.5C8.67 18 8 17.33 8 16.5V9.5Z"
            fill="var(--text-inverse)"
          />
          <circle cx="14" cy="13" r="2" fill="var(--gold-500)" />
        </svg>
        {!collapsed && (
          <div className="min-w-0">
            <div
              className="truncate font-display text-sm font-bold tracking-wide"
              style={{ color: "var(--text-primary)" }}
            >
              竞拍之王
            </div>
            <div
              className="text-[10px] uppercase tracking-wider"
              style={{ color: "var(--text-tertiary)" }}
            >
              BidKing
            </div>
          </div>
        )}
      </div>

      {/* ── 导航项 ── */}
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {NAV_ITEMS.map((item) => {
          const active = current === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              className="group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-150 ease-out"
              style={{
                background: active ? "var(--gold-soft)" : "transparent",
                color: active ? "var(--gold-400)" : "var(--text-secondary)",
                fontWeight: active ? 500 : 400,
              }}
              onMouseEnter={(e) => {
                if (!active)
                  e.currentTarget.style.background = "var(--bg-input)";
              }}
              onMouseLeave={(e) => {
                if (!active)
                  e.currentTarget.style.background = "transparent";
              }}
              title={collapsed ? item.label : undefined}
            >
              {/* 选中态左侧金条 */}
              {active && (
                <span
                  className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full"
                  style={{ background: "var(--gold-500)" }}
                />
              )}
              {item.icon}
              {!collapsed && (
                <span className="truncate">{item.label}</span>
              )}
            </button>
          );
        })}
      </nav>

      {/* ── 底部状态区 ── */}
      {!collapsed && (
        <div
          className="shrink-0 space-y-2.5 p-4"
          style={{ borderTop: "1px solid var(--border-subtle)" }}
        >
          {/* 后端状态 */}
          <div className="flex items-center gap-2 text-xs">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{
                background: online ? "var(--jade-500)" : "var(--vermilion-500)",
                boxShadow: online
                  ? "0 0 6px rgba(74, 154, 106, 0.6)"
                  : "0 0 6px rgba(196, 74, 74, 0.6)",
              }}
            />
            <span style={{ color: "var(--text-secondary)" }}>
              {online ? "后端在线" : "后端离线"}
            </span>
          </div>

          {/* 数据统计 */}
          <div className="space-y-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
            <div className="flex justify-between">
              <span>图鉴</span>
              <span className="font-mono tabular-nums" style={{ color: "var(--text-secondary)" }}>
                {health?.catalog ?? "—"} 件
              </span>
            </div>
            <div className="flex justify-between">
              <span>对局</span>
              <span className="font-mono tabular-nums" style={{ color: "var(--text-secondary)" }}>
                {health?.games ?? "—"} 局
              </span>
            </div>
            <div className="flex justify-between">
              <span>ML 模型</span>
              <span style={{ color: mlTrained ? "var(--jade-400)" : "var(--amber-400)" }}>
                {mlTrained === null ? "—" : mlTrained ? "已训练" : "未训练"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── 折叠/展开按钮 ── */}
      <button
        onClick={onToggleCollapse}
        className="flex h-10 shrink-0 items-center justify-center transition-colors duration-150"
        style={{
          borderTop: "1px solid var(--border-subtle)",
          color: "var(--text-tertiary)",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-input)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        title={collapsed ? "展开侧边栏" : "折叠侧边栏"}
      >
        <svg
          className={`h-4 w-4 transition-transform duration-300 ${collapsed ? "rotate-180" : ""}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M10 4L6 8L10 12" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </aside>
  );
}

export const Sidebar = memo(SidebarImpl);
