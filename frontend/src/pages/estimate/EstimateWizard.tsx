import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api } from "../../api";
import type {
  CatalogItem,
  EstimateInput,
  EstimateResp,
  GridStat,
  IdentifyMatch,
  OcrTask,
} from "../../types";
import { estimateReducer, initialState } from "./useEstimateReducer";
import type { WizardContext, KnownItemRow } from "./wizardTypes";
import { fmtInputNum, parseNum } from "./wizardTypes";
import { StepParameters } from "./StepParameters";
import { StepKnownItems } from "./StepKnownItems";
import { StepResults } from "./StepResults";

export function EstimateWizard() {
  const [state, dispatch] = useReducer(estimateReducer, initialState);

  /* ── Catalog & grid stats ── */
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [gridStats, setGridStats] = useState<Record<number, GridStat>>({});
  const [ocrTasks, setOcrTasks] = useState<OcrTask[]>([]);

  /* ── Identify state ── */
  const [identifyFor, setIdentifyFor] = useState<number | null>(null);
  const [identifyHits, setIdentifyHits] = useState<IdentifyMatch[] | null>(null);
  const [identifyBusy, setIdentifyBusy] = useState(false);

  /* ── Clipboard OCR state ── */
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
  const [autoClipOn, setAutoClipOn] = useState(false);
  const lastClipHash = useRef("");
  const firstPeek = useRef(true);
  const clipPathRef = useRef("");

  /* ── Size popup ── */
  const [sizePop, setSizePop] = useState<number | null>(null);

  /* ── Slide direction for step transition ── */
  const [dir, setDir] = useState<"left" | "right">("left");
  const stepRef = useRef(state.step);
  stepRef.current = state.step;
  const goStep = useCallback((n: 1 | 2 | 3) => {
    setDir(n > stepRef.current ? "left" : "right");
    dispatch({ type: "GO_STEP", step: n });
  }, []);

  /* ════════════════════════════════════════════════════════════
     Load catalog data
     ════════════════════════════════════════════════════════════ */
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

  /* ════════════════════════════════════════════════════════════
     Clipboard auto-poll
     ════════════════════════════════════════════════════════════ */
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

  /* ════════════════════════════════════════════════════════════
     Clipboard detection
     ════════════════════════════════════════════════════════════ */
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
      let oj: { settlement?: any } = {};
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
      if (cands.length > 0) {
        parts.push(`识别到 ${cands.length} 件红品候选`);
      } else {
        setOcrWarn(true);
        parts.push("未识别到藏品：请确认截图包含红品（单件截图或红底棋盘均可），金底/无红底棋盘暂无法自动切分");
      }
      if (s.total_value != null) parts.push(`总价值 ${s.total_value.toLocaleString()}`);
      if (s.deal_price != null) parts.push(`成交价 ${s.deal_price.toLocaleString()}`);
      if (s.profit != null) parts.push(`收益 ${s.profit.toLocaleString()}`);
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
      if (!j.ok) {
        setOcrMsg(j.error ?? "剪贴板没有图片");
        return;
      }
      lastClipHash.current = j.hash;
      await detectClipboard(j.path);
    } catch {
      setOcrMsg("剪贴板采样失败");
    }
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
    dispatch({
      type: "SET_KNOWN_ITEMS",
      items: (() => {
        const rows = state.knownItems;
        const emptyIdx = rows.findIndex((r) => parseNum(r.size) === null && !r.name);
        if (emptyIdx >= 0) return rows.map((r, i) => (i === emptyIdx ? row : r));
        return [...rows, row];
      })(),
    });
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
      dispatch({
        type: "SET_KNOWN_ITEMS",
        items: (() => {
          const rows = state.knownItems;
          const emptyIdx = rows.findIndex((r) => parseNum(r.size) === null && !r.name);
          if (emptyIdx >= 0) return rows.map((r, i) => (i === emptyIdx ? row : r));
          return [...rows, row];
        })(),
      });
    });
    setClipCandidates([]);
    setOcrMsg(`已全部填入 ${clipCandidates.length} 件红品`);
  }, [clipCandidates, items, state.knownItems]);

  /* ════════════════════════════════════════════════════════════
     Identify logic
     ════════════════════════════════════════════════════════════ */
  const onIdentify = useCallback(async (key: number) => {
    const row = state.knownItems.find((r) => r.key === key);
    if (!row) return;
    const g = parseNum(row.size);
    if (g === null) {
      dispatch({ type: "SET_ERROR", error: "识别前请先填写该藏品的格数" });
      return;
    }
    dispatch({ type: "SET_ERROR", error: "" });
    setIdentifyBusy(true);
    setIdentifyFor(key);
    try {
      const r = await api.identify(g, parseNum(row.value));
      if (r.matches.length === 1) {
        onPickIdentify(key, r.matches[0]);
      } else {
        setIdentifyHits(r.matches);
      }
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

  /* ════════════════════════════════════════════════════════════
     OCR task apply
     ════════════════════════════════════════════════════════════ */
  const onApplyOcr = useCallback((task: OcrTask) => {
    const ocrItems = task.result?.items ?? [];
    if (ocrItems.length === 0) {
      setOcrWarn(true);
      setOcrMsg("该图片未识别到藏品，请放大查看原图");
      return;
    }
    const cells = ocrItems[0].grid_cells;
    const total = ocrItems.length * cells;
    const avg = total / ocrItems.length;
    const best = [...ocrItems].sort((a, b) => b.price - a.price)[0];
    dispatch({ type: "SET_FIELD", field: "avg", value: avg.toFixed(1) });
    dispatch({ type: "SET_FIELD", field: "countEst", value: String(ocrItems.length) });
    // Fill first known item
    dispatch({
      type: "SET_KNOWN_ITEMS",
      items: state.knownItems.length > 0
        ? state.knownItems.map((r, i) =>
            i === 0
              ? {
                  ...r,
                  size: String(best.grid_cells),
                  value: fmtInputNum(String(best.price)),
                  name: best.name,
                  id: items.find((x) => x.name === best.name)?.id ?? "",
                }
              : r,
          )
        : [{ key: 1, id: "", name: best.name, size: String(best.grid_cells), value: fmtInputNum(String(best.price)) }],
    });
    setOcrWarn(false);
    setOcrMsg(
      `已填入：红品均格 ${avg.toFixed(1)}（${total}格 / ${ocrItems.length}件），已知红品 ${best.name}（${best.price.toLocaleString()}）`,
    );
  }, [items, state.knownItems]);

  /* ════════════════════════════════════════════════════════════
     Run estimate
     ════════════════════════════════════════════════════════════ */
  const onRunEstimate = useCallback(async (lock: { red_grids: number; red_count: number } | null = state.lockedCand) => {
    dispatch({ type: "SET_ERROR", error: "" });
    const avgVal = parseNum(state.avg);
    if (avgVal === null) {
      dispatch({ type: "SET_ERROR", error: "请填写红品平均格数" });
      return;
    }
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
      dispatch({ type: "GO_STEP", step: 3 });

      // Update locked candidate
      if (lock && r.candidates.some((c) => c.red_grids === lock.red_grids && c.red_count === lock.red_count)) {
        dispatch({ type: "SET_LOCKED_CAND", cand: lock });
      } else {
        dispatch({ type: "SET_LOCKED_CAND", cand: null });
      }
    } catch (e) {
      dispatch({ type: "SET_ERROR", error: e instanceof Error ? e.message : String(e) });
    }
  }, [state]);

  /* ════════════════════════════════════════════════════════════
     Save record
     ════════════════════════════════════════════════════════════ */
  const onSaveRecord = useCallback(async () => {
    if (!state.result || !state.lastInput) return;
    dispatch({ type: "SET_SAVING", saving: true });
    try {
      const bid = parseNum(state.bidInput);
      await api.createRecord({
        inputs: state.lastInput,
        prediction: state.result,
        bid,
        status: bid !== null ? "bid_placed" : "draft",
        note: bid !== null ? `出价 ${bid}` : "",
      });
      dispatch({ type: "SET_SAVED_MSG", msg: "已保存到历史复盘，拍卖结束后去「录入结算」" });
      setTimeout(() => dispatch({ type: "SET_SAVED_MSG", msg: "" }), 5000);
    } catch (e) {
      dispatch({ type: "SET_ERROR", error: e instanceof Error ? e.message : String(e) });
    } finally {
      dispatch({ type: "SET_SAVING", saving: false });
    }
  }, [state.result, state.lastInput, state.bidInput]);

  /* ════════════════════════════════════════════════════════════
     Fill known size from popup
     ════════════════════════════════════════════════════════════ */
  const onFillKnownSize = useCallback((s: number) => {
    const rows = state.knownItems;
    const emptyIdx = rows.findIndex((r) => parseNum(r.size) === null);
    if (emptyIdx >= 0) {
      dispatch({ type: "UPDATE_KNOWN", key: rows[emptyIdx].key, patch: { size: String(s) } });
    } else {
      dispatch({ type: "ADD_KNOWN" });
      // The new item won't have the size set yet — need to set it after add
      setTimeout(() => {
        dispatch({ type: "SET_KNOWN_ITEMS", items: [...rows, { key: Date.now(), id: "", name: null, size: String(s), value: "" }] });
      }, 0);
    }
    setSizePop(null);
  }, [state.knownItems]);

  /* ════════════════════════════════════════════════════════════
     Build context
     ════════════════════════════════════════════════════════════ */
  const ctx: WizardContext = {
    state,
    dispatch,
    items,
    gridStats,
    identifyFor,
    identifyHits,
    identifyBusy,
    onIdentify,
    onPickIdentify,
    clipBusy,
    clipCandidates,
    clipSettle,
    ocrMsg,
    ocrWarn,
    autoClipOn,
    onSetAutoClip: setAutoClipOn,
    onSampleClip: sampleClipForKnown,
    onFillFromClip: fillFromClip,
    onImportAllClip: importAllFromClip,
    ocrTasks,
    onApplyOcr,
    onRunEstimate,
    onSaveRecord,
    sizePop,
    onSizePop: setSizePop,
    onFillKnownSize,
  };

  /* ════════════════════════════════════════════════════════════
     键盘快捷键
       Ctrl+Enter  触发估值计算（输入框聚焦时也生效）
       1 / 2 / 3   跳转到对应步骤（输入框聚焦时禁用）
       R           重置为新对局
       Esc         关闭弹层（格数弹窗 / 识别结果）
     ════════════════════════════════════════════════════════════ */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

      // Ctrl+Enter：触发估值（即使正在输入也可触发）
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        onRunEstimate();
        return;
      }

      // Esc：关闭所有弹层
      if (e.key === "Escape") {
        setSizePop(null);
        setIdentifyHits(null);
        setIdentifyFor(null);
        return;
      }

      // 以下快捷键在输入框聚焦时禁用，避免误触
      if (typing) return;

      if (e.key === "1") goStep(1);
      else if (e.key === "2") goStep(2);
      else if (e.key === "3") {
        if (state.result) goStep(3);
      } else if (e.key === "r" || e.key === "R") {
        dispatch({ type: "RESET" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onRunEstimate, goStep, state.result]);

  /* ════════════════════════════════════════════════════════════
     Render
     ════════════════════════════════════════════════════════════ */
  const steps = [
    { num: 1, label: "参数" },
    { num: 2, label: "已知品" },
    { num: 3, label: "结果" },
  ] as const;

  return (
    <div>
      {/* ── Step indicator ── */}
      <div className="mb-6 flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s.num} className="flex items-center gap-2">
            {i > 0 && (
              <div
                className="h-px w-8 transition-all duration-300"
                style={{
                  background: state.step >= s.num ? "var(--gold-500)" : "var(--border-subtle)",
                }}
              />
            )}
            <button
              onClick={() => {
                // Allow navigating back to completed steps, but not forward beyond current
                if (s.num <= state.step || (s.num === 3 && state.result)) {
                  goStep(s.num);
                }
              }}
              disabled={s.num > state.step && !(s.num === 3 && state.result)}
              aria-label={`第 ${s.num} 步：${s.label}`}
              className="flex items-center gap-2 transition"
              style={{ opacity: s.num <= state.step ? 1 : 0.5 }}
            >
              <div
                className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-all duration-300"
                style={{
                  background: state.step === s.num ? "var(--gold-500)" : state.step > s.num ? "var(--jade-500)" : "var(--bg-input)",
                  color: state.step >= s.num ? "var(--text-inverse)" : "var(--text-tertiary)",
                  border: state.step === s.num ? "2px solid var(--gold-400)" : "1px solid var(--border-subtle)",
                }}
              >
                {state.step > s.num ? "✓" : s.num}
              </div>
              <span
                className="text-sm font-medium transition"
                style={{
                  color: state.step === s.num ? "var(--gold-300)" : state.step > s.num ? "var(--text-primary)" : "var(--text-tertiary)",
                }}
              >
                {s.label}
              </span>
            </button>
          </div>
        ))}
      </div>

      {/* ── Step content ── */}
      <div key={state.step} className={dir === "left" ? "animate-slide-left" : "animate-slide-right"}>
        {state.step === 1 && <StepParameters ctx={ctx} />}
        {state.step === 2 && <StepKnownItems ctx={ctx} />}
        {state.step === 3 && <StepResults ctx={ctx} />}
      </div>
    </div>
  );
}
