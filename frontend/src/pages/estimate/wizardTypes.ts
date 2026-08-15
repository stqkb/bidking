import type { EstimateInput, EstimateResp, IdentifyMatch } from "../../types";

/* ════════════════════════════════════════════════════════════
   Known item row (form-level, strings for input binding)
   ════════════════════════════════════════════════════════════ */
export interface KnownItemRow {
  key: number;
  id: number | "";
  name: string | null;
  size: string;
  value: string;
}

/* ════════════════════════════════════════════════════════════
   Wizard state — single source of truth for all 3 steps
   ════════════════════════════════════════════════════════════ */
export interface WizardState {
  step: 1 | 2 | 3;

  /* ── Step 1: Parameters ── */
  avg: string;
  countEst: string;
  advanced: boolean;
  redCount: string;
  redGrids: string;
  totalGrids: string;
  blueGrids: string;
  wgGrids: string;
  purpleGrids: string;
  goldGrids: string;
  minBid: string;
  margin: number;
  useCalib: boolean;
  useBoard: boolean;
  board: number[][];

  /* ── Step 2: Known items ── */
  knownItems: KnownItemRow[];

  /* ── Step 3: Results ── */
  result: EstimateResp | null;
  loading: boolean;
  error: string;
  lockedCand: { red_grids: number; red_count: number } | null;
  lastInput: EstimateInput | null;
  bidInput: string;
  saving: boolean;
  savedMsg: string;
}

/* ════════════════════════════════════════════════════════════
   Wizard actions
   ════════════════════════════════════════════════════════════ */
export type WizardAction =
  | { type: "NEXT_STEP" }
  | { type: "PREV_STEP" }
  | { type: "GO_STEP"; step: 1 | 2 | 3 }
  | { type: "SET_FIELD"; field: keyof WizardState; value: unknown }
  | { type: "TOGGLE_ADVANCED" }
  | { type: "ADD_KNOWN" }
  | { type: "REMOVE_KNOWN"; key: number }
  | { type: "UPDATE_KNOWN"; key: number; patch: Partial<KnownItemRow> }
  | { type: "SET_KNOWN_ITEMS"; items: KnownItemRow[] }
  | { type: "SET_RESULT"; result: EstimateResp; input: EstimateInput }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_ERROR"; error: string }
  | { type: "SET_LOCKED_CAND"; cand: { red_grids: number; red_count: number } | null }
  | { type: "SET_BID_INPUT"; value: string }
  | { type: "SET_SAVING"; saving: boolean }
  | { type: "SET_SAVED_MSG"; msg: string }
  | { type: "RESET" };

/* ════════════════════════════════════════════════════════════
   Shared context type — passed to all step components
   ════════════════════════════════════════════════════════════ */
export interface WizardContext {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;

  /* ── Catalog data (loaded once) ── */
  items: { id: number; name: string; grid_cells: number; value: number }[];
  gridStats: Record<number, import("../../types").GridStat>;

  /* ── Identify logic ── */
  identifyFor: number | null;
  identifyHits: IdentifyMatch[] | null;
  identifyBusy: boolean;
  onIdentify: (key: number) => void;
  onPickIdentify: (key: number, m: IdentifyMatch) => void;

  /* ── Clipboard OCR ── */
  clipBusy: boolean;
  clipCandidates: { name: string; grid_cells: number; score: number; box: number[]; path: string }[];
  clipSettle: { total_value: number | null; deal_price: number | null; profit: number | null } | null;
  ocrMsg: string;
  ocrWarn: boolean;
  autoClipOn: boolean;
  onSetAutoClip: (on: boolean) => void;
  onSampleClip: () => void;
  onFillFromClip: (cand: { name: string; grid_cells: number; score: number; box: number[]; path: string }) => void;
  onImportAllClip: () => void;

  /* ── OCR tasks ── */
  ocrTasks: import("../../types").OcrTask[];
  onApplyOcr: (task: import("../../types").OcrTask) => void;

  /* ── Estimate execution ── */
  onRunEstimate: (lock?: { red_grids: number; red_count: number } | null) => void;
  onSaveRecord: () => void;

  /* ── Grid stats popup ── */
  sizePop: number | null;
  onSizePop: (s: number | null) => void;
  onFillKnownSize: (s: number) => void;
}

/* ════════════════════════════════════════════════════════════
   Helper: parse string to number | null
   ════════════════════════════════════════════════════════════ */
export function parseNum(s: string): number | null {
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

/* ════════════════════════════════════════════════════════════
   Helper: format input with thousands separators
   ════════════════════════════════════════════════════════════ */
export function fmtInputNum(raw: string): string {
  const s = raw.replace(/[^\d.]/g, "");
  const dot = s.indexOf(".");
  const intPart = dot >= 0 ? s.slice(0, dot) : s;
  const decPart = dot >= 0 ? s.slice(dot + 1).replace(/\./g, "") : "";
  const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dot >= 0 ? `${intFmt}.${decPart}` : intFmt;
}
