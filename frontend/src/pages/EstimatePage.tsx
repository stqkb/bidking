import EstimateWorkbench from "./EstimateWorkbench";

/**
 * EstimatePage — 单页估值工作台。
 *
 * 旧版 3 步向导保留在 estimate/EstimateWizard.tsx（含 StepParameters / StepKnownItems /
 * StepResults），供回退使用；本页现直接渲染 EstimateWorkbench（左右两栏 + 底部固定操作栏）。
 */
export default function EstimatePage() {
  return <EstimateWorkbench />;
}
