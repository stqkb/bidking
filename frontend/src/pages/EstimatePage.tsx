import { EstimateWizard } from "./estimate/EstimateWizard";

/**
 * EstimatePage — thin wrapper around the 3-step wizard.
 *
 * The wizard is split into:
 *   Step 1: Parameters (game params, advanced fields, screenshot OCR)
 *   Step 2: Known items (optional enrichment, info density bar)
 *   Step 3: Results (bid recommendation, interval bar, candidates, similar games)
 *
 * State is managed via useReducer in EstimateWizard.tsx.
 */
export default function EstimatePage() {
  return <EstimateWizard />;
}
