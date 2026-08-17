export interface GridStat {
  grid_cells: number;
  count: number;
  mean: number;
  median: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
}

export interface CatalogItem {
  id: number;
  name: string;
  grid_cells: number;
  value: number;
}

export interface IdentifyMatch {
  name: string;
  grid_cells: number;
  value: number | null;
  current_value: number | null;
  source: string;
  match: string;
  diff: number;
}

export interface KnownItemInput {
  name?: string | null;
  size: number | null;
  value?: number | null;
}

export interface CatalogResp {
  total: number;
  grids: GridStat[];
}

export interface Candidate {
  red_grids: number;
  red_count: number;
  score: number;
  composition_count?: number;
  compositions?: number[][];
  estimate?: {
    ev: number;
    p10: number;
    p50: number;
    p90: number;
    n_compositions?: number;
    remaining_ev?: number;
  };
}

export interface EstimateResp {
  calibration: { factor: number; known_size: number | null; known_value: number | null };
  red: { ev: number; p10: number; p50: number; p90: number; min: number; max: number; factor?: number };
  full: { ev: number; p10: number; p50: number; p90: number; min: number; max: number; mode?: string };
  bid: {
    recommended: number;
    max_bid: number;
    min_price: number;
    margin: number;
    risk: string;
    risk_score: number;
    should_bid: boolean;
    bid_reason: string;
    uncertainty_ratio: number;
    worst_case_profit: number;
    expected_profit: number;
    /** 收益展示（/api/estimate 后续新增；未返回时前端预留位置不显示） */
    profit?: number | null;        // 预计收益
    profit_rate?: number | null;   // 收益率（百分比数值，如 11.1；亦可传 0~1 小数，前端自动 ×100）
    profit_p10?: number | null;    // 最差收益（p10）
    profit_p90?: number | null;    // 最好收益（p90）
  };
  candidates: Candidate[];
  similar_games: SimilarGame[];
  warnings: string[];
  known?: { sizes: number[]; value_total: number; count: number };
  ml?: { available: boolean; n?: number };
  cnn?: { ok: boolean; value?: number; count?: number; error?: string; calibrated?: boolean };
  precision_tol?: number;
}

export interface SimilarGame {
  game_no: number;
  grid_combo: string;
  red_count: number;
  red_grids: number;
  red_avg: number;
  red_value: number;
  full_value: number;
  deal_price: number;
  min_bid: number | null;
  profit: number | null;
  winner: string | null;
}

export interface GameRecord {
  game_no: number;
  grid_combo: string;
  red_count: number;
  red_grids: number;
  red_avg: number;
  red_value: number;
  full_value: number;
  deal_price: number;
  min_bid: number | null;
  profit: number | null;
  winner: string | null;
  won: number | null;  // 本人是否竞拍成功：1 成功 / 0 未成功 / null 未标记
  profit_ok?: number | null;  // 收益核验：1 通过 / 0 不通过(收益≠成交价−总价值，不进训练) / null 未核验
  predicted_full?: number | null;  // 归档时的估值预测（全场），供「预测 vs 实际」对比
  predicted_red?: number | null;   // 归档时的估值预测（红品）
  actual_full?: number | null;     // full_value 别名，便于复盘页统一命名
  items: { name: string; grid_cells: number; sys_price?: number | null; trade_price?: number | null }[];
}

export interface UserRecord {
  id: string;
  game_no: number | null;
  created_at: string;
  updated_at: string;
  inputs: Record<string, unknown>;
  prediction: EstimateResp | null;
  bid: number | null;
  actual: Record<string, unknown> | null;
  status: string;
  note: string | null;
}

export interface ModelStatus {
  trained: boolean;
  n: number;
  trained_at?: string;
  loocv?: {
    mode: string;
    n: number;
    full: { mae_log: number; mape_pct: number; r2_log: number; mae_orig: number };
    red: { mae_log: number; mape_pct: number; r2_log: number; mae_orig: number };
    coverage_pct: number;
  };
  chrono?: { full: { mape_pct: number; r2_log: number }; coverage_pct: number };
  importance?: Record<string, number>;
  calibration_curve?: { bins: number[]; pred: number[]; actual: number[]; pred_lo: number[]; actual_lo: number[] };
}

export interface CnnStatus {
  trained: boolean;
  torch: boolean;
  n_synth?: number;
  epochs?: number;
  te_loss?: number;
  trained_at?: string;
  calib?: { ok: boolean; n?: number; slope?: number; intercept?: number; corr?: number; error?: string };
}

export interface OcrMatch {
  name: string;
  grid_cells: number;
  value: number;
  current_value: number | null;
  score: number;
  price_diff: number;
  price_ok: boolean;
  by_price: boolean;
}

export interface OcrItem {
  name: string;
  price: number;
  grid_cells: number;
  matches: OcrMatch[];
  matched: boolean;
  matched_by_price?: boolean;
  price_mismatch?: boolean;
  price_suspect?: boolean;
  name_conf: number;
  visual?: { name: string; grid_cells: number; score: number; gallery: string }[];
}

export interface OcrTask {
  id: number;
  path: string;
  kind: string;
  shape: string;
  status: string;
  created_at: string;
  result: {
    items?: OcrItem[];
    settlement?: { total_value?: number; deal_price?: number; profit?: number };
    red_count?: number;
    total_cells?: number;
    red_avg?: number | null;
    error?: string;
    image_size?: number[];
  };
}

export interface EstimateInput {
  red_avg: number | null;
  red_count_est?: number | null;
  red_count?: number | null;
  red_grids?: number | null;
  selected_red_grids?: number | null;
  selected_red_count?: number | null;
  known_name?: string | null;
  known_size?: number | null;
  known_value?: number | null;
  known_items?: KnownItemInput[] | null;
  total_grids?: number | null;
  blue_grids?: number | null;
  wg_grids?: number | null;
  purple_grids?: number | null;
  gold_grids?: number | null;
  min_bid?: number | null;
  margin: number;
  use_calibration: boolean;
  board?: number[][] | null;
}

export interface VisionItem {
  cat_id: number;
  id: number | null;
  image_path: string | null;
  name: string;
  grid_cells: number;
  value: number;
  current_value: number | null;
  source: string;
  has_image: boolean;
  n_images: number;
  images?: { id: number; path: string; source?: string; variant?: boolean }[];
  has_learn?: boolean;
  has_manual?: boolean;  // 手动补录的漏检红品（视觉识别加强样本）
}
