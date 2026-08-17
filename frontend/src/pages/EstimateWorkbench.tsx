import { useEffect, useMemo, useReducer, useRef, useState, useCallback, type Dispatch, type ReactNode } from "react";
import { api } from "../api";
import type {
  CatalogItem,
  EstimateInput,
  EstimateResp,
  GridStat,
  IdentifyMatch,
  OcrTask,
} from "../types";
import { estimateReducer, initialState } from "./estimate/useEstimateReducer";
import type { WizardAction, WizardState, KnownItemRow } from "./estimate/wizardTypes";
import { fmtInputNum, parseNum } from "./estimate/wizardTypes";
import { fmtWan, fmtMoney, riskColor } from "../utils";
import { useToast } from "../components/Toast";
import { navigateTo } from "../nav";
import { ResultCard } from "./estimate/ResultCard";
import { IntervalBar } from "./estimate/IntervalBar";
import { ProfitCard } from "./estimate/ProfitCard";
import { CandidateList } from "./estimate/CandidateList";
import Chart from "../components/Chart";
import { CHART } from "../theme/chartTokens";

/* ════════════════════════════════════════════════════════════
   EstimateWorkbench — 单页工作台（替代 3 步向导）
   左栏(40%) 输入区 | 右栏(60%) 结果区 | 底部固定操作栏
   ════════════════════════════════════════════════════════════ */

function paramSig(s: WizardState): string {
  return JSON.stringify([
    s.avg, s.countEst, s.redCount, s.redGrids, s.totalGrids,
    s.blueGrids, s.wgGrids, s.purpleGrids, s.goldGrids, s.minBid,
    s.margin, s.useCalib, s.useBoard,
    s.knownItems.map((k) => [k.name, k.size, k.value]),
  ]);
}

export default function EstimateWorkbench() {
  const [state, dispatch] = useReducer(estimateReducer, initialState);
  const { notify } = useToast();

  const [items, setItems] = useState<CatalogItem[]>([]);
  const [gridStats, setGridStats] = useState<Record<number, GridStat>>({});
  const [ocrTasks, setOcrTasks] = useState<OcrTask[]>([]);

  const [identifyFor, setIdentifyFor] = useState<number | null>(null);
  const [identifyHits, setIdentifyHits] = useState<IdentifyMatch[] | null>(null);
  const [identifyBusy, setIdentifyBusy] = useState(false);

  const [clipBusy, setClipBusy] = useState(false);
  const [clipCandidates, setClipCandidates] = useState<
    { name: string; grid_cells: number; score: number; box: number[]; path: string }[]
  >([]);
  const [clipSettle, setClipSettle] = useState<{
    total_value: number | null;
    deal_price: number | null;
    profit: number | null;
  } | null>(null);
  const [ocrMsg, setOcrMsg] = useState("");
  const [ocrWarn, setOcrWarn] = useState(false);
  const [autoClipOn, setAutoClipOn] = useState(true);
  const lastClipHash = useRef("");
  const firstPeek = useRef(true);
  const clipPathRef = useRef("");

  const [sizePop, setSizePop] = useState<number | null>(null);
  const [knownOpen, setKnownOpen] = useState<boolean | null>(null); // null=auto
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  /* ── Load catalog ── */
  useEffect(() => {
    api.catalogItems().then((r) => setItems(r.items)).catch(() => {});
    api.catalog().then((r) => {
      const m: Record<number, GridStat> = {};
      r.grids.forEach((g) => { m[g.grid_cells] = g; });
      setGridStats(m);
    }).catch(() => {});
    api.ocrStatus().then((r) => {
      setOcrTasks(r.tasks.filter((t) => t.status === "pending"));
    }).catch(() => {});
  }, []);

  /* ── Clipboard auto-poll ── */
  useEffect(() => {
    if (!autoClipOn) return;
    firstPeek.current = true;
    const loadClip = async () => {
      try {
        const r = await fetch("/api/clipboard", { method: "POST" });
        const j = await r.json();
        if (!j.ok) return;
        if (firstPeek.current) {
          firstPeek.current = false;
          lastClipHash.current = j.hash;
          return;
        }
        if (j.hash && j.hash !== lastClipHash.current) {
          lastClipHash.current = j.hash;
          await detectClipboard(j.path);
        }
      } catch { /* ignore */ }
    };
    loadClip();
    const timer = setInterval(loadClip, 2000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoClipOn]);

  const detectClipboard = useCallback(async (path: string) => {
    setClipBusy(true);
    setClipCandidates([]);
    setClipSettle(null);
    setOcrWarn(false);
    setOcrMsg("正在识别剪贴板截图中的红品…");
    try {
      const [detRes, ocrRes] = await Promise.allSettled([
        fetch("/api/vision/auto_detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_path: path }),
        }),
        fetch("/api/ocr/recognize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        }),
      ]);
      let j: { cells?: any[] } | null = null;
      let oj: { settlement?: any; red_avg?: number | null } = {};
      if (detRes.status === "fulfilled") {
        const r = detRes.value;
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.detail ?? `红品识别接口错误（HTTP ${r.status}）`);
        }
        j = await r.json().catch(() => null);
      }
      if (ocrRes.status === "fulfilled" && ocrRes.value.ok) {
        oj = await ocrRes.value.json().catch(() => ({}));
      }
      const s = oj.settlement ?? {};
      // 后端 OCR 响应已带 red_avg（float|null）→ 自动回填"红品平均格数"
      if (oj.red_avg != null) {
        dispatch({ type: "SET_FIELD", field: "avg", value: Number(oj.red_avg).toFixed(1) });
      }
      setClipSettle({
        total_value: s.total_value ?? null,
        deal_price: s.deal_price ?? null,
        profit: s.profit ?? null,
      });
      const cands = (j?.cells ?? [])
        .map((c: any) => {
          const top = c.matches?.[0];
          if (!top) return null;
          return { name: top.name, grid_cells: top.grid_cells, score: top.score, box: c.icon, path };
        })
        .filter(
          (c): c is { name: string; grid_cells: number; score: number; box: number[]; path: string } =>
            c !== null,
        );
      setClipCandidates(cands);
      clipPathRef.current = path;
      const parts: string[] = [];
      if (cands.length > 0) parts.push(`识别到 ${cands.length} 件红品候选`);
      else {
        setOcrWarn(true);
        parts.push("未识别到藏品：请确认截图包含红品（单件截图或红底棋盘均可）");
      }
      if (s.total_value != null) parts.push(`总价值 ${s.total_value.toLocaleString()}`);
      if (s.deal_price != null) parts.push(`成交价 ${s.deal_price.toLocaleString()}`);
      if (s.profit != null) parts.push(`收益 ${s.profit.toLocaleString()}`);
      if (oj.red_avg != null) parts.push(`红品均格 ${Number(oj.red_avg).toFixed(1)}（截图自动填入）`);
      if (s.total_value == null && s.deal_price == null && cands.length > 0) {
        setOcrWarn(true);
        parts.push("未识别到结算信息（总价值/成交价），可手动填写或重新截图");
      }
      setOcrMsg(parts.join(" · "));
    } catch (e) {
      setOcrWarn(true);
      setOcrMsg(e instanceof Error ? `识别失败：${e.message}` : String(e));
    } finally {
      setClipBusy(false);
    }
  }, []);

  const sampleClipForKnown = useCallback(async () => {
    try {
      const r = await fetch("/api/clipboard", { method: "POST" });
      const j = await r.json();
      if (!j.ok) { setOcrMsg(j.error ?? "剪贴板没有图片"); return; }
      lastClipHash.current = j.hash;
      await detectClipboard(j.path);
    } catch { setOcrMsg("剪贴板采样失败"); }
  }, [detectClipboard]);

  const fillFromClip = useCallback((cand: { name: string; grid_cells: number; score: number; box: number[]; path: string }) => {
    const it = items.find((x) => x.name === cand.name);
    const row: KnownItemRow = {
      key: Date.now() + Math.random(),
      id: it?.id != null ? it.id : "",
      name: cand.name,
      size: String(cand.grid_cells),
      value: it ? fmtInputNum(String(it.value)) : "",
    };
    dispatch({ type: "SET_KNOWN_ITEMS", items: (() => {
      const rows = state.knownItems;
      const emptyIdx = rows.findIndex((r) => parseNum(r.size) === null && !r.name);
      if (emptyIdx >= 0) return rows.map((r, i) => (i === emptyIdx ? row : r));
      return [...rows, row];
    })() });
    setClipCandidates((prev) => prev.filter((c) => c !== cand));
  }, [items, state.knownItems]);

  const importAllFromClip = useCallback(() => {
    clipCandidates.forEach((c) => {
      const it = items.find((x) => x.name === c.name);
      const row: KnownItemRow = {
        key: Date.now() + Math.random(),
        id: it?.id != null ? it.id : "",
        name: c.name,
        size: String(c.grid_cells),
        value: it ? fmtInputNum(String(it.value)) : "",
      };
      dispatch({ type: "SET_KNOWN_ITEMS", items: (() => {
        const rows = state.knownItems;
        const emptyIdx = rows.findIndex((r) => parseNum(r.size) === null && !r.name);
        if (emptyIdx >= 0) return rows.map((r, i) => (i === emptyIdx ? row : r));
        return [...rows, row];
      })() });
    });
    setClipCandidates([]);
    setOcrMsg(`已全部填入 ${clipCandidates.length} 件红品`);
  }, [clipCandidates, items, state.knownItems]);

  const onIdentify = useCallback(async (key: number) => {
    const row = state.knownItems.find((r) => r.key === key);
    if (!row) return;
    const g = parseNum(row.size);
    if (g === null) { dispatch({ type: "SET_ERROR", error: "识别前请先填写该藏品的格数" }); return; }
    dispatch({ type: "SET_ERROR", error: "" });
    setIdentifyBusy(true);
    setIdentifyFor(key);
    try {
      const r = await api.identify(g, parseNum(row.value));
      if (r.matches.length === 1) onPickIdentify(key, r.matches[0]);
      else setIdentifyHits(r.matches);
    } catch (e) {
      dispatch({ type: "SET_ERROR", error: e instanceof Error ? e.message : String(e) });
    } finally {
      setIdentifyBusy(false);
    }
  }, [state.knownItems]);

  const onPickIdentify = useCallback((key: number, m: IdentifyMatch) => {
    const patch: Partial<KnownItemRow> = {
      size: String(m.grid_cells),
      name: m.name,
      id: items.find((x) => x.name === m.name)?.id ?? "",
    };
    if (m.value !== null) patch.value = fmtInputNum(String(m.value));
    dispatch({ type: "UPDATE_KNOWN", key, patch });
    setIdentifyFor(null);
    setIdentifyHits(null);
    dispatch({ type: "SET_SAVED_MSG", msg: `已识别：${m.name}（${m.grid_cells}格）` });
    setTimeout(() => dispatch({ type: "SET_SAVED_MSG", msg: "" }), 4000);
  }, [items]);

  const onApplyOcr = useCallback((task: OcrTask) => {
    const ocrItems = task.result?.items ?? [];
    if (ocrItems.length === 0) { setOcrWarn(true); setOcrMsg("该图片未识别到藏品，请放大查看原图"); return; }
    const cells = ocrItems[0].grid_cells;
    const total = ocrItems.length * cells;
    const avg = total / ocrItems.length;
    const best = [...ocrItems].sort((a, b) => b.price - a.price)[0];
    dispatch({ type: "SET_FIELD", field: "avg", value: avg.toFixed(1) });
    dispatch({ type: "SET_FIELD", field: "countEst", value: String(ocrItems.length) });
    dispatch({
      type: "SET_KNOWN_ITEMS",
      items: state.knownItems.length > 0
        ? state.knownItems.map((r, i) => i === 0
          ? { ...r, size: String(best.grid_cells), value: fmtInputNum(String(best.price)), name: best.name, id: items.find((x) => x.name === best.name)?.id ?? "" }
          : r)
        : [{ key: 1, id: "", name: best.name, size: String(best.grid_cells), value: fmtInputNum(String(best.price)) }],
    });
    setOcrWarn(false);
    setOcrMsg(`已填入：红品均格 ${avg.toFixed(1)}（${total}格 / ${ocrItems.length}件），已知红品 ${best.name}（${best.price.toLocaleString()}）`);
  }, [items, state.knownItems]);

  const onRunEstimate = useCallback(async (lock: { red_grids: number; red_count: number } | null = state.lockedCand) => {
    dispatch({ type: "SET_ERROR", error: "" });
    const avgVal = parseNum(state.avg);
    if (avgVal === null) { dispatch({ type: "SET_ERROR", error: "请填写红品平均格数" }); return; }
    dispatch({ type: "SET_LOADING", loading: true });
    try {
      const knownList = state.knownItems
        .map((k) => ({ name: k.name, size: parseNum(k.size), value: parseNum(k.value) }))
        .filter((k) => k.size !== null);
      const input: EstimateInput = {
        red_avg: avgVal,
        red_count_est: parseNum(state.countEst),
        red_count: parseNum(state.redCount),
        red_grids: parseNum(state.redGrids),
        selected_red_grids: lock?.red_grids ?? null,
        selected_red_count: lock?.red_count ?? null,
        known_name: knownList[0]?.name ?? null,
        known_size: knownList[0]?.size ?? null,
        known_value: knownList[0]?.value ?? null,
        known_items: knownList,
        total_grids: parseNum(state.totalGrids),
        blue_grids: parseNum(state.blueGrids),
        wg_grids: parseNum(state.wgGrids),
        purple_grids: parseNum(state.purpleGrids),
        gold_grids: parseNum(state.goldGrids),
        min_bid: parseNum(state.minBid),
        margin: state.margin,
        use_calibration: state.useCalib,
        board: state.useBoard ? state.board : null,
      };
      const r = await api.estimate(input);
      dispatch({ type: "SET_RESULT", result: r, input });
      setLastSig(paramSig(state));
      if (lock && r.candidates.some((c) => c.red_grids === lock.red_grids && c.red_count === lock.red_count)) {
        dispatch({ type: "SET_LOCKED_CAND", cand: lock });
      } else {
        dispatch({ type: "SET_LOCKED_CAND", cand: null });
      }
    } catch (e) {
      dispatch({ type: "SET_ERROR", error: e instanceof Error ? e.message : String(e) });
    }
  }, [state]);

  const onQuickArchive = useCallback(async () => {
    if (!state.result || !state.lastInput) return;
    setArchiving(true);
    try {
      const r = await api.quickArchive({ input: state.lastInput, result: state.result });
      notify(`已归档 #对局${r.game_no}`, "gold");
    } catch {
      notify("后端接口待开放", "amber");
    } finally {
      setArchiving(false);
    }
  }, [state.result, state.lastInput, notify]);

  const onFillKnownSize = useCallback((s: number) => {
    const rows = state.knownItems;
    const emptyIdx = rows.findIndex((r) => parseNum(r.size) === null);
    if (emptyIdx >= 0) dispatch({ type: "UPDATE_KNOWN", key: rows[emptyIdx].key, patch: { size: String(s) } });
    else {
      dispatch({ type: "ADD_KNOWN" });
      setTimeout(() => {
        dispatch({ type: "SET_KNOWN_ITEMS", items: [...rows, { key: Date.now(), id: "", name: null, size: String(s), value: "" }] });
      }, 0);
    }
    setSizePop(null);
  }, [state.knownItems]);

  /* ── 去标注校准：通过 URL query 传递参数 ── */
  const goAnnotate = useCallback(() => {
    const inp = state.lastInput;
    if (!inp) return;
    navigateTo("annotate", {
      red_avg: inp.red_avg ?? "",
      red_count: inp.red_count ?? inp.red_count_est ?? "",
      total_grids: inp.total_grids ?? "",
    });
  }, [state.lastInput]);

  const onReset = useCallback(() => {
    dispatch({ type: "RESET" });
    setLastSig(null);
  }, []);

  /* ── Dirty：参数自上次估值后是否变化（高亮开始估值） ── */
  const sig = paramSig(state);
  const dirty = lastSig !== null && lastSig !== sig && state.result !== null;

  const hasKnown = state.knownItems.some((k) => parseNum(k.size) !== null);
  const knownCount = state.knownItems.filter((k) => k.name || parseNum(k.size) !== null).length;

  /* ── 已知红品折叠：有数据自动展开，否则默认折叠 ── */
  const knownExpanded = knownOpen ?? knownCount > 0;

  return (
    <div className="flex min-h-full flex-col">
      {/* ── 顶部标题 ── */}
      <div className="mb-5">
        <h1 className="text-xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
          估值工作台
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-tertiary)" }}>
          填左侧参数，右栏实时显示上一次估值结果 · 确认后去标注校准录入结算
        </p>
      </div>

      {/* ── 两栏布局 ── */}
      <div className="grid flex-1 grid-cols-1 gap-5 lg:grid-cols-[2fr_3fr]">
        {/* ════════ 左栏：输入区 ════════ */}
        <div className="space-y-4">
          {/* 棋盘参数 */}
          <div className="card p-5">
            <h3 className="mb-3 text-sm font-medium tracking-wide" style={{ color: "var(--text-secondary)" }}>
              棋盘参数
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="field-label">红品平均格数 *</label>
                <input
                  className="input"
                  type="number" step="0.1" min="0.01" max="50"
                  placeholder="如 2.2"
                  value={state.avg}
                  onChange={(e) => dispatch({ type: "SET_FIELD", field: "avg", value: e.target.value })}
                  onBlur={() => {
                    const n = parseFloat(state.avg);
                    if (!Number.isNaN(n)) dispatch({ type: "SET_FIELD", field: "avg", value: n.toFixed(1) });
                  }}
                />
              </div>
              <div>
                <label className="field-label">红品件数</label>
                <input
                  className="input"
                  type="number" min="1" max="80" placeholder="可选"
                  value={state.countEst}
                  onChange={(e) => dispatch({ type: "SET_FIELD", field: "countEst", value: e.target.value })}
                />
              </div>
              <div>
                <label className="field-label">全场总格数 T</label>
                <input
                  className="input"
                  type="number" min="1" placeholder="可选"
                  value={state.totalGrids}
                  onChange={(e) => dispatch({ type: "SET_FIELD", field: "totalGrids", value: e.target.value })}
                />
              </div>
            </div>

            {/* 截图识别（可选） */}
            <div className="mt-4 rounded-xl p-3" style={{ background: "var(--bg-input)", border: "1px solid var(--border-subtle)" }}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium" style={{ color: "var(--gold-300)" }}>从截图识别（可选）：</span>
                <button className="btn-primary !h-7 !px-3 text-xs" onClick={sampleClipForKnown} disabled={clipBusy}>
                  {clipBusy ? "识别中…" : "采样剪贴板识别"}
                </button>
                <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
                  <input type="checkbox" style={{ accentColor: "var(--gold-500)" }} checked={autoClipOn} onChange={(e) => setAutoClipOn(e.target.checked) } />
                  自动采样 Win+Shift+S
                </label>
              </div>
              {ocrMsg && (
                <div className="mt-2 rounded-lg border px-2.5 py-1.5 text-xs" style={{
                  borderColor: ocrWarn ? "rgba(201, 154, 62, 0.3)" : "rgba(74, 154, 106, 0.3)",
                  background: ocrWarn ? "var(--amber-soft)" : "var(--jade-soft)",
                  color: ocrWarn ? "var(--amber-400)" : "var(--jade-400)",
                }}>{ocrMsg}</div>
              )}
              {clipSettle && (clipSettle.total_value != null || clipSettle.deal_price != null || clipSettle.profit != null) && (
                <div className="mt-2 grid grid-cols-3 gap-2 border-t pt-2 text-xs" style={{ borderColor: "var(--border-subtle)" }}>
                  <div><div className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>藏品总价值</div>
                    <b style={{ color: "var(--jade-400)" }}>{clipSettle.total_value != null ? clipSettle.total_value.toLocaleString() : "—"}</b></div>
                  <div><div className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>成交价</div>
                    <b style={{ color: "var(--gold-300)" }}>{clipSettle.deal_price != null ? clipSettle.deal_price.toLocaleString() : "—"}</b></div>
                  <div><div className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>收益</div>
                    <b style={{ color: (clipSettle.profit ?? 0) >= 0 ? "var(--jade-400)" : "var(--vermilion-400)" }}>{clipSettle.profit != null ? clipSettle.profit.toLocaleString() : "—"}</b></div>
                </div>
              )}
              {clipCandidates.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>识别到的红品候选（点击填入）：</span>
                    <button className="text-[11px] font-medium transition hover:opacity-80" style={{ color: "var(--gold-300)" }} onClick={importAllFromClip}>
                      全部填入（{clipCandidates.length}）
                    </button>
                  </div>
                  {clipCandidates.map((c, i) => (
                    <button key={i} className="flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }} onClick={() => fillFromClip(c)}>
                      <img src={`/api/vision/crop_box?image_path=${encodeURIComponent(c.path)}&box=${c.box.join(",")}`} alt="" className="h-8 w-8 rounded border object-contain" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-canvas)" }} onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
                      <span className="min-w-0 flex-1 truncate text-xs" style={{ color: "var(--text-primary)" }}>{c.name}（{c.grid_cells}格）</span>
                      <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>{Math.round(c.score * 100)}%</span>
                      <span className="text-[11px]" style={{ color: "var(--gold-300)" }}>填入 →</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 开始估值 */}
            <div className="mt-4 flex items-center gap-3">
              <button
                className={`btn-accent flex-1 !py-2.5 text-sm ${dirty ? "" : ""}`}
                style={dirty ? { boxShadow: "0 0 0 2px var(--gold-400)", animation: "pulse 1.6s infinite" } : undefined}
                onClick={() => onRunEstimate()}
                disabled={!state.avg || state.loading}
              >
                {state.loading ? "计算中…" : "开始估值"}
              </button>
              {dirty && (
                <span className="text-xs" style={{ color: "var(--gold-300)" }}>参数已变更，建议重新估值</span>
              )}
            </div>
            {state.error && (
              <div className="mt-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "rgba(196, 74, 74, 0.3)", background: "var(--vermilion-soft)", color: "var(--vermilion-400)" }}>
                {state.error}
              </div>
            )}
          </div>

          {/* 已知红品（可折叠，默认有数据展开） */}
          <div className="card p-5">
            <button className="flex w-full items-center justify-between" onClick={() => setKnownOpen((v) => !(v ?? knownCount > 0))}>
              <span className="text-sm font-medium tracking-wide" style={{ color: "var(--text-secondary)" }}>
                已知红品{knownCount > 0 ? `（${knownCount}）` : ""}
              </span>
              <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{knownExpanded ? "收起 ▲" : "展开 ▼"}</span>
            </button>
            {knownExpanded && <KnownItemsBlock state={state} dispatch={dispatch} items={items} gridStats={gridStats} onIdentify={onIdentify} onPickIdentify={onPickIdentify} identifyFor={identifyFor} identifyHits={identifyHits} identifyBusy={identifyBusy} onSizePop={setSizePop} onFillKnownSize={onFillKnownSize} />}
          </div>
        </div>

        {/* ════════ 右栏：结果区 ════════ */}
        <div className="min-w-0">
          {state.result ? (
            <ResultPanel
              result={state.result}
              state={state}
              dispatch={dispatch}
              gridStats={gridStats}
              sizePop={sizePop}
              onSizePop={setSizePop}
              onFillKnownSize={onFillKnownSize}
              hasKnown={hasKnown}
              onRunEstimate={onRunEstimate}
            />
          ) : (
            <div className="flex h-full min-h-[320px] items-center justify-center rounded-xl border border-dashed p-8 text-center" style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}>
              <div>
                <div className="mb-2 text-4xl">📊</div>
                <div className="text-sm">输入参数后点击「开始估值」</div>
                <div className="mt-1 text-xs">右侧将实时显示估值结果与出价建议</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        className="mt-6 flex flex-wrap items-center gap-3"
        style={{
          position: "sticky",
          bottom: 0,
          zIndex: 10,
          background: "var(--bg-surface)",
          borderTop: "1px solid var(--border)",
          padding: "var(--space-4)",
          marginTop: "var(--space-6)",
          boxShadow: "0 -8px 24px -12px rgba(0,0,0,0.5)",
        }}
      >
        <button className="btn-ghost !py-2 text-sm" onClick={onQuickArchive} disabled={archiving || !state.result}>
          {archiving ? "归档中…" : "一键归档"}
        </button>
        <button className="btn-accent !py-2 text-sm" onClick={goAnnotate} disabled={!state.lastInput}>
          去标注校准 ▶
        </button>
        <button className="btn-ghost !py-2 text-sm" onClick={onReset}>
          下一局 ↺
        </button>
        <span className="ml-auto text-xs" style={{ color: "var(--text-tertiary)" }}>
          {state.result ? "已显示上一次估值结果" : "尚未估值"}
        </span>
      </div>
    </div>
  );
}

/* ── 已知红品列表（折叠区内容） ── */
function KnownItemsBlock({
  state, dispatch, items, gridStats, onIdentify, onPickIdentify, identifyFor, identifyHits, identifyBusy, onSizePop, onFillKnownSize,
}: {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  items: CatalogItem[];
  gridStats: Record<number, GridStat>;
  onIdentify: (key: number) => void;
  onPickIdentify: (key: number, m: IdentifyMatch) => void;
  identifyFor: number | null;
  identifyHits: IdentifyMatch[] | null;
  identifyBusy: boolean;
  onSizePop: (s: number | null) => void;
  onFillKnownSize: (s: number) => void;
}) {
  const avgNum = parseNum(state.avg);
  const countNum = parseNum(state.countEst);
  const knownGrids = state.knownItems.reduce((sum, k) => sum + (parseNum(k.size) ?? 0), 0);
  const totalRedGrids = avgNum !== null && countNum !== null ? avgNum * countNum : null;
  const infoDensity = totalRedGrids && totalRedGrids > 0 ? Math.min(100, (knownGrids / totalRedGrids) * 100) : 0;

  return (
    <div className="mt-3 space-y-2.5">
      {/* 信息密度 */}
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span style={{ color: "var(--text-secondary)" }}>信息密度</span>
          <span className="font-mono tabular-nums font-semibold" style={{ color: infoDensity >= 67 ? "var(--jade-400)" : infoDensity >= 33 ? "var(--amber-400)" : "var(--vermilion-400)" }}>{infoDensity.toFixed(0)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--bg-input)" }}>
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${infoDensity}%`, background: infoDensity >= 67 ? "var(--jade-400)" : infoDensity >= 33 ? "var(--amber-400)" : "var(--vermilion-400)" }} />
        </div>
      </div>

      {state.knownItems.map((k, idx) => (
        <div key={k.key} className="rounded-xl p-3" style={{ background: "var(--bg-input)", border: "1px solid var(--border-subtle)" }}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>已知红品 {idx + 1}</span>
            {state.knownItems.length > 1 && (
              <button className="text-xs transition hover:opacity-80" style={{ color: "var(--vermilion-400)" }} onClick={() => dispatch({ type: "REMOVE_KNOWN", key: k.key })}>✕ 移除</button>
            )}
          </div>
          <select className="input" value={k.id} onChange={(e) => {
            const id = e.target.value === "" ? "" : Number(e.target.value);
            if (id === "") dispatch({ type: "UPDATE_KNOWN", key: k.key, patch: { id: "", name: null, size: "", value: "" } });
            else {
              const it = items.find((x) => x.id === id);
              dispatch({ type: "UPDATE_KNOWN", key: k.key, patch: it ? { id, name: it.name, size: String(it.grid_cells), value: fmtInputNum(String(it.value)) } : { id, name: null, size: "", value: "" } });
            }
          }}>
            <option value="">— 从图鉴选择（可留空）—</option>
            {items.map((it) => (<option key={it.id} value={it.id}>{it.name}（{it.grid_cells}格）</option>))}
          </select>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div><label className="field-label">格数</label>
              <input className="input" type="number" min="1" placeholder="如 8" value={k.size} onChange={(e) => dispatch({ type: "UPDATE_KNOWN", key: k.key, patch: { size: e.target.value } })} /></div>
            <div><label className="field-label">价值</label>
              <input className="input" type="text" inputMode="numeric" placeholder="如 900,000" value={k.value} onChange={(e) => dispatch({ type: "UPDATE_KNOWN", key: k.key, patch: { value: fmtInputNum(e.target.value) } })} /></div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button className="btn-ghost !h-7 !px-3 text-xs" onClick={() => onIdentify(k.key)} disabled={identifyBusy}>{identifyBusy && identifyFor === k.key ? "识别中…" : "识别藏品"}</button>
            <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>只填格数即按价值从低到高展示</span>
            {k.name && <span className="text-xs" style={{ color: "var(--jade-400)" }}>已识别：{k.name}</span>}
          </div>
          {identifyFor === k.key && identifyHits && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {identifyHits.length === 0 && <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>该格数下暂无图鉴藏品，可手动选择下拉框</span>}
              {identifyHits.map((m, i) => (
                <button key={`${m.name}-${i}`} onClick={() => onPickIdentify(k.key, m)} className="rounded-lg border px-2.5 py-1 text-xs transition hover:opacity-80" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
                  {m.name}（{m.grid_cells}格 · {fmtMoney(m.value)}{m.match ? ` · ${m.match}` : ""}）
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <button className="w-full rounded-xl border border-dashed p-2 text-xs font-medium transition hover:opacity-80" style={{ borderColor: "var(--border-default)", background: "transparent", color: "var(--gold-300)" }} onClick={() => dispatch({ type: "ADD_KNOWN" })}>
        ＋ 添加已知红品
      </button>
    </div>
  );
}

/* ── 右栏结果面板 ── */
function ResultPanel({
  result, state, dispatch, gridStats, sizePop, onSizePop, onFillKnownSize, hasKnown, onRunEstimate,
}: {
  result: EstimateResp;
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  gridStats: Record<number, GridStat>;
  sizePop: number | null;
  onSizePop: (s: number | null) => void;
  onFillKnownSize: (s: number) => void;
  hasKnown: boolean;
  onRunEstimate: (lock?: { red_grids: number; red_count: number } | null) => void;
}) {
  const shouldBid = result.bid.should_bid;
  const uncertaintyRatio = result.bid.uncertainty_ratio;

  const chartOption = useMemo(() => {
    const mk = (catIdx: number, _name: string, d: { p10: number; p50: number; p90: number; ev: number }, color: string) => [
      { type: "bar", data: [[catIdx, d.p10]], stack: "v", itemStyle: { color, opacity: 0.18, borderRadius: [6, 6, 0, 0] }, barWidth: 26 },
      { type: "bar", data: [[catIdx, d.p90 - d.p10]], stack: "v", itemStyle: { color, opacity: 0.55, borderRadius: [0, 0, 6, 6] }, barWidth: 26,
        label: { show: true, position: "top", color: CHART.textSecondary, fontSize: 11, formatter: () => `${fmtWan(d.p10)} ~ ${fmtWan(d.p90)}` } },
      { type: "scatter", symbol: "diamond", symbolSize: 10, data: [[catIdx, d.ev]], itemStyle: { color: CHART.textPrimary }, tooltip: { formatter: () => `期望 ${fmtWan(d.ev)}` } },
    ];
    return {
      tooltip: { trigger: "item" },
      grid: { left: 46, right: 18, top: 34, bottom: 30 },
      xAxis: { type: "category", data: ["红品价值", "全场总价值"], axisLabel: { color: CHART.textSecondary } },
      yAxis: { type: "value", axisLabel: { color: CHART.textSecondary, formatter: (v: number) => fmtWan(v) }, splitLine: { lineStyle: { color: CHART.border } } },
      series: [...mk(0, "红品", result.red, CHART.goldDim), ...mk(1, "全场", result.full, CHART.jade)],
    };
  }, [result]);

  return (
    <div className="space-y-4">
      {/* 核心行：推荐出价 + 预计收益 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ResultCard
          label={shouldBid ? "推荐出价" : "建议不出价"}
          valueNum={result.bid.recommended}
          format={fmtWan}
          sub={<>
            <span style={{ color: "var(--text-secondary)" }}>p10 × {(result.bid.margin * 100).toFixed(0)}%</span>
            {" · "}<span>天花板 {fmtWan(result.bid.max_bid)}</span>
          </>}
          tone={shouldBid ? "gold" : "vermilion"}
          icon={<svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 1L10.5 5.5L15 6.5L11.5 10L12.5 14.5L8 12L3.5 14.5L4.5 10L1 6.5L5.5 5.5L8 1Z" /></svg>}
        />
        {(result.bid.profit != null || !shouldBid) && <ProfitCard bid={result.bid} shouldBid={shouldBid} />}
      </div>

      {/* 区间条 + 置信度 */}
      <div className="rounded-xl border p-5" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
        <IntervalBar p10={result.red.p10} p50={result.red.p50} ev={result.red.ev} p90={result.red.p90} uncertaintyRatio={uncertaintyRatio} label="红品价值区间" />
      </div>

      {/* 出价建议横幅 */}
      <div className="rounded-xl border p-4" style={{ borderColor: shouldBid ? "rgba(74, 154, 106, 0.4)" : "rgba(196, 74, 74, 0.5)", background: shouldBid ? "var(--jade-soft)" : "var(--vermilion-soft)" }}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-lg font-bold" style={{ color: shouldBid ? "var(--jade-400)" : "var(--vermilion-400)" }}>{shouldBid ? "✓ 可以出价" : "✗ 不建议出价"}</span>
          <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${riskColor(result.bid.risk)}`}>{result.bid.risk}（区间倍数 ×{result.bid.risk_score.toFixed(1)}）</span>
          <span className="ml-auto text-xs" style={{ color: "var(--text-tertiary)" }}>全场估值模式：{result.full.mode === "细分" ? "逐品质细分" : "红品 × 实测倍率"}</span>
        </div>
        <p className="mt-2 text-sm" style={{ color: shouldBid ? "var(--jade-400)" : "var(--vermilion-400)" }}>{result.bid.bid_reason}</p>
        {shouldBid && (
          <div className="mt-2 flex flex-wrap gap-4 rounded-lg p-3 text-sm" style={{ background: "var(--bg-input)" }}>
            <span style={{ color: "var(--text-secondary)" }}>最坏情况利润：<span className="font-semibold" style={{ color: "var(--jade-400)" }}>{fmtWan(result.bid.worst_case_profit)}</span></span>
            <span style={{ color: "var(--text-secondary)" }}>期望利润：<span className="font-semibold" style={{ color: "var(--gold-300)" }}>{fmtWan(result.bid.expected_profit)}</span></span>
            <span style={{ color: "var(--text-secondary)" }}>不确定性：<span className="font-semibold" style={{ color: "var(--text-primary)" }}>{(uncertaintyRatio * 100).toFixed(0)}%</span></span>
          </div>
        )}
      </div>

      {/* 全场 / 红品 估值 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ResultCard label="全场总价值（期望）" valueNum={result.full.ev} format={fmtWan} sub={`区间 ${fmtWan(result.full.p10)} ~ ${fmtWan(result.full.p90)}`} tone="jade" />
        <ResultCard label="红品期望价值" valueNum={result.red.ev} format={fmtWan} sub={`区间 ${fmtWan(result.red.p10)} ~ ${fmtWan(result.red.p90)}`} tone="gold" />
      </div>

      {/* 模型徽章 */}
      <div className="flex flex-wrap gap-2">
        {result.ml?.available && (
          <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium" style={{ borderColor: "rgba(201, 169, 98, 0.4)", background: "var(--gold-soft)", color: "var(--gold-300)" }}>ML 修正 (n={result.ml.n})</span>
        )}
        {result.cnn?.ok && (
          <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium" style={{ borderColor: "rgba(201, 169, 98, 0.4)", background: "var(--gold-soft)", color: "var(--gold-300)" }}>CNN 融合</span>
        )}
        {result.calibration.factor !== 1 && (
          <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium" style={{ borderColor: "rgba(201, 169, 98, 0.4)", background: "var(--gold-soft)", color: "var(--gold-300)" }}>校准 ×{result.calibration.factor.toFixed(2)}</span>
        )}
      </div>

      {/* 候选组合（可折叠） */}
      <div className="card p-5">
        <h3 className="mb-2 text-sm font-medium tracking-wide" style={{ color: "var(--text-secondary)" }}>格数组合候选</h3>
        <CandidateList candidates={result.candidates} lockedCand={state.lockedCand} avg={state.avg} hasKnown={hasKnown} onSelect={(cand) => onRunEstimate(cand)} onSizePop={(s) => onSizePop(s)} />
        {sizePop !== null && gridStats[sizePop] && (
          <SizePopupContent size={sizePop} stat={gridStats[sizePop]} onClose={() => onSizePop(null)} onFill={() => onFillKnownSize(sizePop)} />
        )}
        {result.warnings.length > 0 && (
          <div className="mt-3 space-y-1 rounded-xl border px-3 py-2 text-xs" style={{ borderColor: "rgba(201, 154, 62, 0.2)", background: "var(--amber-soft)", color: "var(--amber-400)" }}>
            {result.warnings.map((w, i) => (<div key={i}>⚠ {w}</div>))}
          </div>
        )}
      </div>

      {/* 价值区间图 */}
      <div className="card p-5">
        <h3 className="mb-1 text-sm font-medium tracking-wide" style={{ color: "var(--text-secondary)" }}>价值区间可视化</h3>
        <p className="mb-3 text-xs" style={{ color: "var(--text-tertiary)" }}>柱体为 p10–p90，◇ 为期望值</p>
        <Chart option={chartOption} height={240} ariaLabel="柱状图：红品与全场价值区间 p10 至 p90，菱形为期望值" />
      </div>

      {/* 历史同类局 */}
      <div className="card p-5">
        <h3 className="mb-1 text-sm font-medium tracking-wide" style={{ color: "var(--text-secondary)" }}>历史同类局参考</h3>
        <p className="mb-3 text-xs" style={{ color: "var(--text-tertiary)" }}>均格接近的历史对局与成交结果</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="历史同类对局参考列表">
            <thead>
              <tr className="text-left text-xs" style={{ color: "var(--text-tertiary)" }}>
                <th className="py-1.5 pr-3">局</th><th className="py-1.5 pr-3">格数组合</th><th className="py-1.5 pr-3">红品总价值</th>
                <th className="py-1.5 pr-3">全场总价值</th><th className="py-1.5 pr-3">成交价</th><th className="py-1.5">结果</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {result.similar_games.map((g) => (
                <tr key={g.game_no} className="border-t" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
                  <td className="py-2 pr-3">{g.game_no}</td>
                  <td className="py-2 pr-3" style={{ color: "var(--text-tertiary)" }}>{g.grid_combo}</td>
                  <td className="py-2 pr-3">{fmtMoney(g.red_value)}</td>
                  <td className="py-2 pr-3">{fmtMoney(g.full_value)}</td>
                  <td className="py-2 pr-3">{fmtMoney(g.deal_price)}</td>
                  <td className="py-2">{g.profit === null ? <span style={{ color: "var(--text-tertiary)" }}>—</span> : g.profit >= 0 ? <span style={{ color: "var(--jade-400)" }}>+{fmtMoney(g.profit)}</span> : <span style={{ color: "var(--vermilion-400)" }}>{fmtMoney(g.profit)}</span>}</td>
                </tr>
              ))}
              {result.similar_games.length === 0 && (<tr><td colSpan={6} className="py-3 text-center" style={{ color: "var(--text-tertiary)" }}>暂无相近均格的历史对局</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ── 格数弹窗 ── */
function SizePopupContent({ size, stat, onClose, onFill }: { size: number; stat: GridStat; onClose: () => void; onFill: () => void }) {
  return (
    <div className="mt-3 rounded-xl border p-3" style={{ borderColor: "rgba(201, 169, 98, 0.4)", background: "var(--gold-soft)" }}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold" style={{ color: "var(--gold-300)" }}>{size} 格藏品预期价格</span>
        <button className="rounded-lg px-2 py-0.5 text-sm transition hover:opacity-80" style={{ color: "var(--text-tertiary)" }} onClick={onClose}>✕</button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm tabular-nums md:grid-cols-3" style={{ color: "var(--text-secondary)" }}>
        <div>图鉴数量：{stat.count} 件</div>
        <div style={{ color: "var(--gold-300)" }}>期望（均值）：{fmtMoney(stat.mean)}</div>
        <div>中位数：{fmtMoney(stat.median)}</div>
        <div>区间 p10–p90：{fmtMoney(stat.p10)} ~ {fmtMoney(stat.p90)}</div>
        <div>最低：{fmtMoney(stat.min)}</div>
        <div>最高：{fmtMoney(stat.max)}</div>
      </div>
      <div className="mt-2"><button className="btn-ghost !h-7 !px-3 text-xs" onClick={onFill}>填入已知红品格数</button></div>
    </div>
  );
}
