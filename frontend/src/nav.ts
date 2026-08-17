import type { PageKey } from "./components/layout/Sidebar";

/**
 * 跨页面导航 + URL query 闭环。
 *
 * 应用主框架用内部 `page` 状态切换页面（非 react-router），但「估值 → 标注校准」
 * 工作流需要通过 URL query 传递参数（red_avg / red_count / total_grids）。
 *
 * navigateTo 同时：
 *   1. 更新 location.search（保留 / 清空 query）
 *   2. 派发 app-navigate 事件，App 监听后切换 page 状态
 *
 * 页面用 `new URLSearchParams(window.location.search)` 读取传入参数。
 */
export function navigateTo(page: PageKey, query?: Record<string, string | number | null | undefined>): void {
  const sp = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
    }
  }
  const search = sp.toString();
  const base = window.location.pathname;
  window.history.replaceState(null, "", search ? `?${search}` : base);
  window.dispatchEvent(new CustomEvent("app-navigate", { detail: { page } }));
}

export type AppNavigateEvent = { page: PageKey };
