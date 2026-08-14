import type {
  CatalogItem,
  CatalogResp,
  CnnStatus,
  EstimateInput,
  EstimateResp,
  GameRecord,
  IdentifyMatch,
  ModelStatus,
  OcrTask,
  UserRecord,
  VisionItem,
} from "./types";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => req<{ ok: boolean; catalog: number; games: number }>("GET", "/api/health"),
  catalog: () => req<CatalogResp>("GET", "/api/catalog"),
  catalogItems: () => req<{ items: CatalogItem[] }>("GET", "/api/catalog/items"),
  identify: (grid_cells: number, price: number | null) =>
    req<{ matches: IdentifyMatch[] }>("POST", "/api/catalog/identify", { grid_cells, price }),
  importCatalog: () => req<{ imported: number }>("POST", "/api/catalog/import", {}),
  catalogDelete: (ids: number[]) => req<{ ok: boolean; deleted?: number; error?: string }>("POST", "/api/catalog/delete", { ids }),
  games: () => req<{ games: GameRecord[] }>("GET", "/api/games"),
  updateGameWon: (game_no: number, won: boolean) =>
    req<{ ok: boolean; game_no: number; won: boolean }>("PATCH", `/api/games/${game_no}`, { won }),
  updateGamePrices: (game_no: number, body: { total_value?: number | null; deal_price?: number | null; profit?: number | null }) =>
    req<{ ok: boolean; game_no: number; won: number | null; profit_ok: number | null }>("PATCH", `/api/games/${game_no}`, body),
  deleteGame: (game_no: number) =>
    req<{ ok: boolean; deleted: number; games: number }>("DELETE", `/api/games/${game_no}`),
  gameAccuracy: () =>
    req<{ accuracy: { game_no: number; red_avg: number; item: string; pred: number; actual: number; ratio: number }[] }>(
      "GET",
      "/api/games/accuracy",
    ),
  records: () => req<{ records: UserRecord[] }>("GET", "/api/records"),
  createRecord: (body: unknown) => req<{ id: string }>("POST", "/api/records", body),
  updateRecord: (id: string, body: unknown) => req<{ id: string; status: string }>("PATCH", `/api/records/${id}`, body),
  deleteRecord: (id: string) => req<{ ok: boolean }>("DELETE", `/api/records/${id}`),
  estimate: (input: EstimateInput) => req<EstimateResp>("POST", "/api/estimate", input),
  modelStatus: () => req<ModelStatus>("GET", "/api/model/status"),
  retrain: () => req<{ started: boolean }>("POST", "/api/model/retrain", {}),
  cnnStatus: () => req<CnnStatus>("GET", "/api/cnn/status"),
  cnnTrain: () => req<{ started: boolean }>("POST", "/api/cnn/train", {}),
  cnnPredict: (board: number[][]) => req<{ ok: boolean; value?: number; count?: number; error?: string; calibrated?: boolean }>("POST", "/api/cnn/predict", { board }),
  ocrStatus: () => req<{ tasks: OcrTask[] }>("GET", "/api/ocr/status"),
  ocrScan: () => req<{ added: number; failed: number; total: number }>("POST", "/api/ocr/scan", {}),
  ocrConfirm: (taskId: number, items: unknown[], settlement?: Record<string, number | null>) =>
    req<{ ok: boolean; added_catalog?: number; updated_catalog?: number; game_no?: number; error?: string }>("POST", `/api/ocr/confirm/${taskId}`, { items, settlement }),
  ocrDelete: (taskId: number) => req<{ ok: boolean }>("DELETE", `/api/ocr/task/${taskId}`),
  ocrProcessCapture: (path: string) =>
    req<{ ok: boolean; task_id?: number; items?: number; error?: string }>("POST", "/api/ocr/process_capture", { path }),
  ocrRecognize: (path: string) =>
    req<any>("POST", "/api/ocr/recognize", { path }),
  ocrRecognizeMulti: (paths: string[]) =>
    req<any>("POST", "/api/ocr/recognize_multi", { paths }),
  ocrSaveMulti: (paths: string[]) =>
    req<any>("POST", "/api/ocr/save_multi", { paths }),
  visionGallery: () => req<{ items: VisionItem[]; total: number; with_image: number }>("GET", "/api/vision/gallery"),
  visionModelStatus: () => req<any>("GET", "/api/vision/model_status"),
  visionModelRebuild: () => req<any>("POST", "/api/vision/model_rebuild", {}),
  visionLearn: (image_path: string, box: number[], name: string, grid_cells: number) =>
    req<{ ok: boolean; name: string; grid_cells: number }>("POST", "/api/vision/learn", { image_path, box, name, grid_cells }),
  visionDeleteLearn: (names: string[]) =>
    req<{ ok: boolean; deleted_files?: number; items_affected?: number }>("POST", "/api/vision/delete_learn", { names }),
  visionDeleteImages: (paths: string[]) =>
    req<{ ok: boolean; deleted?: number }>("POST", "/api/vision/delete_images", { paths }),
};
