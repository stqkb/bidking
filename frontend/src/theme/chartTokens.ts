/* ════════════════════════════════════════════════════════════
   ECharts 统一色板 — Canvas 无法读取 CSS 变量，故图表色值集中于此
   所有 hex 与 src/index.css 设计令牌一一对应（canvas 渲染所需）
   旧页面内的局部 C 常量已统一改为从此处导入，杜绝散落硬编码
   ════════════════════════════════════════════════════════════ */
export const CHART = {
  textPrimary: "#ECE9E4", // --text-primary
  textSecondary: "#A8A4A0", // --text-secondary
  textTertiary: "#6E6B68", // --text-tertiary
  gold: "#D4B978", // --gold-400
  goldDim: "#C9A962", // --gold-500
  goldLight: "#E8D4A0", // --gold-300 / --text-money
  jade: "#5BBA8A", // --jade-400
  jade500: "#4A9A6A", // --jade-500
  vermilion: "#E06B6B", // --vermilion-400
  amber: "#E0B056", // --amber-400
  border: "#2E2E38", // --border-subtle
  borderDef: "#3A3A48", // --border-default
  splitLine: "#1C1C24", // --bg-elevated
  gridLine: "#22222B", // --bg-input
  surface: "#22222B", // --bg-input
  bgSurface: "#16161C", // --bg-surface
  bgInput: "#22222B", // --bg-input
  tooltipBg: "#1C1C24", // --bg-elevated
  tooltipBorder: "#3A3A48", // --border-default
} as const;
