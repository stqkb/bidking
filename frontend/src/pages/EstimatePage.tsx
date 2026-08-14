import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import BoardEditor from "../components/BoardEditor";
import { Badge, Card, Stat } from "../components/Card";
import Chart from "../components/Chart";
import type { CatalogItem, EstimateInput, EstimateResp, GridStat, OcrTask } from "../types";
import type { IdentifyMatch } from "../types";
import { fmtMoney, fmtWan, riskColor } from "../utils";

const EMPTY_BOARD = () => Array.from({ length: 16 }, () => Array(16).fill(0));

export default function EstimatePage() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [avg, setAvg] = useState("");
  const [countEst, setCountEst] = useState("");
  const [knownItems, setKnownItems] = useState<
    { key: number; id: number | ""; name: string | null; size: string; value: string }[]
  >([{ key: 1, id: "", name: null, size: "", value: "" }]);
  const [identifyFor, setIdentifyFor] = useState<number | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [redCount, setRedCount] = useState("");
  const [redGrids, setRedGrids] = useState("");
  const [totalGrids, setTotalGrids] = useState("");
  const [blueGrids, setBlueGrids] = useState("");
  const [wgGrids, setWgGrids] = useState("");
  const [purpleGrids, setPurpleGrids] = useState("");
  const [goldGrids, setGoldGrids] = useState("");
  const [minBid, setMinBid] = useState("");
  const [margin, setMargin] = useState(0.84);
  const [useCalib, setUseCalib] = useState(false);
  const [useBoard, setUseBoard] = useState(false);
  const [board, setBoard] = useState<number[][]>(EMPTY_BOARD);
  const [result, setResult] = useState<EstimateResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [identifyHits, setIdentifyHits] = useState<IdentifyMatch[] | null>(null);
  const [identifyBusy, setIdentifyBusy] = useState(false);
  const [gridStats, setGridStats] = useState<Record<number, GridStat>>({});
  const [sizePop, setSizePop] = useState<number | null>(null);
  const [lockedCand, setLockedCand] = useState<{ red_grids: number; red_count: number } | null>(null);
  const [bidInput, setBidInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [lastInput, setLastInput] = useState<EstimateInput | null>(null);
  const [ocrTasks, setOcrTasks] = useState<OcrTask[]>([]);
  const [ocrPick, setOcrPick] = useState<number | "">("");
  const [ocrZoom, setOcrZoom] = useState<number | null>(null);
  const [ocrMsg, setOcrMsg] = useState("");
  const [ocrWarn, setOcrWarn] = useState(false);
  const [clipBusy, setClipBusy] = useState(false);
  const [clipCandidates, setClipCandidates] = useState<
    { name: string; grid_cells: number; score: number; box: number[]; path: string }[]
  >([]);
  const [clipSettle, setClipSettle] = useState<{
    total_value: number | null;
    deal_price: number | null;
    profit: number | null;
  } | null>(null);
  const clipPathRef = useRef("");
  const [autoClipOn, setAutoClipOn] = useState(false);
  const lastClipHash = useRef("");
  const firstPeek = useRef(true);

  useEffect(() => {
    api.catalogItems().then((r) => setItems(r.items)).catch(() => {});
    api.catalog().then((r) => {
      const m: Record<number, GridStat> = {};
      r.grids.forEach((g) => {
        m[g.grid_cells] = g;
      });
      setGridStats(m);
    }).catch(() => {});
    api.ocrStatus().then((r) => {
      setOcrTasks(r.tasks.filter((t) => t.status === "pending"));
    }).catch(() => {});
  }, []);

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
      } catch {
        /* ignore */
      }
    };
    loadClip();
    const timer = setInterval(loadClip, 2000);
    return () => clearInterval(timer);
  }, [autoClipOn]);

  const detectClipboard = async (path: string) => {
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
  };

  const sampleClipForKnown = async () => {
    const r = await fetch("/api/clipboard", { method: "POST" });
    const j = await r.json();
    if (!j.ok) {
      setOcrMsg(j.error ?? "剪贴板没有图片");
      return;
    }
    lastClipHash.current = j.hash;
    await detectClipboard(j.path);
  };

  const fillFromClip = (cand: { name: string; grid_cells: number; score: number; box: number[]; path: string }) => {
    const it = items.find((x) => x.name === cand.name);
    setKnownItems((rows) => {
      const emptyIdx = rows.findIndex((r) => num(r.size) === null && !r.name);
      const row: { key: number; id: number | ""; name: string | null; size: string; value: string } = {
        key: Date.now() + Math.random(),
        id: it?.id != null ? it.id : "",
        name: cand.name,
        size: String(cand.grid_cells),
        value: it ? fmtInputNum(String(it.value)) : "",
      };
      if (emptyIdx >= 0) return rows.map((r, i) => (i === emptyIdx ? row : r));
      return [...rows, row];
    });
    setClipCandidates((prev) => prev.filter((c) => c !== cand));
  };

  const importAllFromClip = () => {
    clipCandidates.forEach((c) => {
      const it = items.find((x) => x.name === c.name);
      setKnownItems((rows) => {
        const emptyIdx = rows.findIndex((r) => num(r.size) === null && !r.name);
        const row: { key: number; id: number | ""; name: string | null; size: string; value: string } = {
          key: Date.now() + Math.random(),
          id: it?.id != null ? it.id : "",
          name: c.name,
          size: String(c.grid_cells),
          value: it ? fmtInputNum(String(it.value)) : "",
        };
        if (emptyIdx >= 0) return rows.map((r, i) => (i === emptyIdx ? row : r));
        return [...rows, row];
      });
    });
    setClipCandidates([]);
    setOcrMsg(`已全部填入 ${clipCandidates.length} 件红品`);
  };

  const applyOcr = (task: OcrTask) => {
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
    setAvg(String(avg.toFixed(1)));
    setCountEst(String(ocrItems.length));
    setKnownItems((rows) =>
      rows.length > 0
        ? rows.map((r, i) =>
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
    );
    setOcrWarn(false);
    setOcrMsg(
      `已填入：红品均格 ${avg.toFixed(1)}（${total}格 / ${ocrItems.length}件），已知红品 ${best.name}（${best.price.toLocaleString()}）`,
    );
  };

  const num = (s: string): number | null => {
    const n = parseFloat(s.replace(/,/g, ""));
    return Number.isNaN(n) ? null : n;
  };

  const fmtInputNum = (raw: string): string => {
    const s = raw.replace(/[^\d.]/g, "");
    const dot = s.indexOf(".");
    const intPart = dot >= 0 ? s.slice(0, dot) : s;
    const decPart = dot >= 0 ? s.slice(dot + 1).replace(/\./g, "") : "";
    const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return dot >= 0 ? `${intFmt}.${decPart}` : intFmt;
  };

  const updateKnown = (
    key: number,
    patch: Partial<{ id: number | ""; name: string | null; size: string; value: string }>,
  ) => {
    setKnownItems((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const onSelectKnown = (key: number, id: number | "") => {
    if (id === "") {
      updateKnown(key, { id: "", name: null, size: "", value: "" });
      return;
    }
    const it = items.find((x) => x.id === id);
    updateKnown(
      key,
      it
        ? { id, name: it.name, size: String(it.grid_cells), value: fmtInputNum(String(it.value)) }
        : { id, name: null, size: "", value: "" },
    );
  };

  const addKnown = () => {
    setKnownItems((rows) => [
      ...rows,
      { key: Date.now(), id: "", name: null, size: "", value: "" },
    ]);
  };

  const fillKnownSize = (s: number) => {
    setKnownItems((rows) => {
      const emptyIdx = rows.findIndex((r) => num(r.size) === null);
      if (emptyIdx >= 0) {
        return rows.map((r, i) => (i === emptyIdx ? { ...r, size: String(s) } : r));
      }
      return [...rows, { key: Date.now(), id: "", name: null, size: String(s), value: "" }];
    });
    setSizePop(null);
  };

  const removeKnown = (key: number) => {
    if (knownItems.length <= 1) return;
    setKnownItems((rows) => rows.filter((r) => r.key !== key));
    if (identifyFor === key) {
      setIdentifyFor(null);
      setIdentifyHits(null);
    }
  };

  const runEstimate = async (lock: { red_grids: number; red_count: number } | null = lockedCand) => {
    setError("");
    const avgVal = num(avg);
    if (avgVal === null) {
      setError("请填写红品平均格数");
      return;
    }
    setLoading(true);
    try {
      const knownList = knownItems
        .map((k) => ({ name: k.name, size: num(k.size), value: num(k.value) }))
        .filter((k) => k.size !== null);
      const input: EstimateInput = {
        red_avg: avgVal,
        red_count_est: num(countEst),
        red_count: num(redCount),
        red_grids: num(redGrids),
        selected_red_grids: lock?.red_grids ?? null,
        selected_red_count: lock?.red_count ?? null,
        known_name: knownList[0]?.name ?? null,
        known_size: knownList[0]?.size ?? null,
        known_value: knownList[0]?.value ?? null,
        known_items: knownList,
        total_grids: num(totalGrids),
        blue_grids: num(blueGrids),
        wg_grids: num(wgGrids),
        purple_grids: num(purpleGrids),
        gold_grids: num(goldGrids),
        min_bid: num(minBid),
        margin,
        use_calibration: useCalib,
        board: useBoard ? board : null,
      };
      const r = await api.estimate(input);
      setResult(r);
      setLastInput(input);
      if (
        lock &&
        r.candidates.some((c) => c.red_grids === lock.red_grids && c.red_count === lock.red_count)
      ) {
        setLockedCand(lock);
      } else {
        setLockedCand(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const identify = async (key: number) => {
    const row = knownItems.find((r) => r.key === key);
    if (!row) return;
    const g = num(row.size);
    if (g === null) {
      setError("识别前请先填写该藏品的格数");
      return;
    }
    setError("");
    setIdentifyBusy(true);
    setIdentifyFor(key);
    try {
      const r = await api.identify(g, num(row.value));
      if (r.matches.length === 1) {
        pickIdentify(key, r.matches[0]);
      } else {
        setIdentifyHits(r.matches);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIdentifyBusy(false);
    }
  };

  const pickIdentify = (key: number, m: IdentifyMatch) => {
    const patch: Partial<{ id: number | ""; name: string | null; size: string; value: string }> = {
      size: String(m.grid_cells),
      name: m.name,
      id: items.find((x) => x.name === m.name)?.id ?? "",
    };
    if (m.value !== null) patch.value = fmtInputNum(String(m.value));
    updateKnown(key, patch);
    setIdentifyFor(null);
    setIdentifyHits(null);
    setSavedMsg(`已识别：${m.name}（${m.grid_cells}格）`);
    setTimeout(() => setSavedMsg(""), 4000);
  };

  const saveRecord = async () => {
    if (!result || !lastInput) return;
    setSaving(true);
    try {
      const bid = num(bidInput);
      await api.createRecord({
        inputs: lastInput,
        prediction: result,
        bid,
        status: bid !== null ? "bid_placed" : "draft",
        note: bid !== null ? `出价 ${bid}` : "",
      });
      setSavedMsg("已保存到历史复盘，拍卖结束后去「录入结算」");
      setTimeout(() => setSavedMsg(""), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const chartOption = useMemo(() => {
    if (!result) return {};
    const mk = (
      catIdx: number,
      name: string,
      d: { p10: number; p50: number; p90: number; ev: number },
      color: string,
    ) => [
      {
        name,
        type: "bar",
        data: [[catIdx, d.p10]],
        stack: "v",
        itemStyle: { color, opacity: 0.18, borderRadius: [6, 6, 0, 0] },
        barWidth: 26,
      },
      {
        name,
        type: "bar",
        data: [[catIdx, d.p90 - d.p10]],
        stack: "v",
        itemStyle: { color, opacity: 0.55, borderRadius: [0, 0, 6, 6] },
        barWidth: 26,
        label: {
          show: true,
          position: "top",
          color: "#cbd5e1",
          fontSize: 11,
          formatter: () => `${fmtWan(d.p10)} ~ ${fmtWan(d.p90)}`,
        },
      },
      {
        name,
        type: "scatter",
        symbol: "diamond",
        symbolSize: 10,
        data: [[catIdx, d.ev]],
        itemStyle: { color: "#fff" },
        tooltip: { formatter: () => `期望 ${fmtWan(d.ev)}` },
      },
    ];
    return {
      tooltip: { trigger: "item" },
      grid: { left: 46, right: 18, top: 34, bottom: 30 },
      xAxis: { type: "category", data: ["红品价值", "全场总价值"], axisLabel: { color: "#94a3b8" } },
      yAxis: {
        type: "value",
        axisLabel: { color: "#94a3b8", formatter: (v: number) => fmtWan(v) },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      series: [...mk(0, "红品", result.red, "#8b5cf6"), ...mk(1, "全场", result.full, "#10b981")],
    };
  }, [result]);

  const pickedTask = ocrPick !== "" ? ocrTasks.find((x) => x.id === ocrPick) : null;
  const hasKnown = knownItems.some((k) => num(k.size) !== null);

  return (
    <>
    <div className="grid gap-5 lg:grid-cols-[420px_1fr]">
      <div className="space-y-5">
        <Card title="对局输入" desc="红色为核心，其他品质可选填，填得越多估值越准">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">红品平均格数 *</label>
                <input
                  className="input"
                  type="number"
                  step="0.1"
                  min="0.01"
                  max="50"
                  placeholder="如 2.2"
                  value={avg}
                  onChange={(e) => setAvg(e.target.value)}
                  onBlur={() => {
                    const n = parseFloat(avg);
                    if (!Number.isNaN(n)) setAvg(n.toFixed(1));
                  }}
                />
              </div>
              <div>
                <label className="field-label">红品件数预估</label>
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="80"
                  placeholder="可选"
                  value={countEst}
                  onChange={(e) => setCountEst(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-2.5">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-sky-300">从截图识别已知红品：</span>
                  <button className="btn-primary !py-1.5 text-xs" onClick={sampleClipForKnown} disabled={clipBusy}>
                    {clipBusy ? "识别中…" : "📋 采样剪贴板识别"}
                  </button>
                  <label className="flex items-center gap-1.5 text-xs text-slate-400">
                    <input
                      type="checkbox"
                      className="accent-sky-500"
                      checked={autoClipOn}
                      onChange={(e) => setAutoClipOn(e.target.checked)}
                    />
                    自动采样 Win+Shift+S
                  </label>
                </div>
                {ocrMsg && (
                  <div
                    className={`mt-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                      ocrWarn
                        ? "border-amber-500/30 bg-amber-500/10 text-amber-600"
                        : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                    }`}
                  >
                    {ocrMsg}
                  </div>
                )}
                {clipSettle && (clipSettle.total_value != null || clipSettle.deal_price != null || clipSettle.profit != null) && (
                  <div className="mt-2 grid grid-cols-3 gap-2 border-t border-sky-500/20 pt-2 text-xs">
                    <div>
                      <div className="text-[10px] text-slate-500">藏品总价值</div>
                      <b className="text-emerald-400">{clipSettle.total_value != null ? clipSettle.total_value.toLocaleString() : "—"}</b>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500">成交价</div>
                      <b className="text-sky-400">{clipSettle.deal_price != null ? clipSettle.deal_price.toLocaleString() : "—"}</b>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500">收益</div>
                      <b className={(clipSettle.profit ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}>
                        {clipSettle.profit != null ? clipSettle.profit.toLocaleString() : "—"}
                      </b>
                    </div>
                  </div>
                )}
                {clipCandidates.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-400">识别到的红品候选（点击填入）：</span>
                      <button className="text-[11px] font-medium text-sky-400 hover:text-sky-300" onClick={importAllFromClip}>
                        全部填入（{clipCandidates.length}）
                      </button>
                    </div>
                    {clipCandidates.map((c, i) => (
                      <button
                        key={i}
                        className="flex w-full items-center gap-2 rounded-lg border border-ink-700 bg-ink-900/70 px-2.5 py-1.5 text-left transition hover:border-sky-500/60 hover:bg-sky-500/10"
                        onClick={() => fillFromClip(c)}
                      >
                        <img
                          src={`/api/vision/crop_box?image_path=${encodeURIComponent(c.path)}&box=${c.box.join(",")}`}
                          alt=""
                          className="h-8 w-8 rounded border border-ink-700 bg-ink-950 object-contain"
                          onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                        />
                        <span className="min-w-0 flex-1 truncate text-xs text-slate-200">
                          {c.name}（{c.grid_cells}格）
                        </span>
                        <span className="text-[10px] text-slate-500">{Math.round(c.score * 100)}%</span>
                        <span className="text-[11px] text-sky-400">填入 →</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {knownItems.map((k, idx) => (
                <div key={k.key} className="rounded-xl border border-ink-700/70 bg-ink-900/50 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-500">已知红品 {idx + 1}</span>
                    {knownItems.length > 1 && (
                      <button
                        className="text-xs text-rose-600 hover:text-rose-700"
                        onClick={() => removeKnown(k.key)}
                      >
                        ✕ 移除
                      </button>
                    )}
                  </div>
                  <select
                    className="input"
                    value={k.id}
                    onChange={(e) => onSelectKnown(k.key, e.target.value === "" ? "" : Number(e.target.value))}
                  >
                    <option value="">— 从图鉴选择（可留空）—</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name}（{it.grid_cells}格）
                      </option>
                    ))}
                  </select>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <label className="field-label">格数</label>
                      <input
                        className="input"
                        type="number"
                        min="1"
                        placeholder="如 8"
                        value={k.size}
                        onChange={(e) => updateKnown(k.key, { size: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="field-label">价值</label>
                      <input
                        className="input"
                        type="text"
                        inputMode="numeric"
                        placeholder="如 900,000"
                        value={k.value}
                        onChange={(e) => updateKnown(k.key, { value: fmtInputNum(e.target.value) })}
                      />
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      className="btn-ghost !px-3 !py-1.5 text-xs"
                      onClick={() => identify(k.key)}
                      disabled={identifyBusy}
                    >
                      {identifyBusy && identifyFor === k.key ? "识别中…" : "识别藏品"}
                    </button>
                    <span className="text-[11px] text-slate-400">只填格数即按价值从低到高展示</span>
                    {k.name && <span className="text-xs text-emerald-600">已识别：{k.name}</span>}
                  </div>
                  {identifyFor === k.key && identifyHits && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {identifyHits.length === 0 && (
                        <span className="text-xs text-slate-500">该格数下暂无图鉴藏品，可手动选择下拉框</span>
                      )}
                      {identifyHits.map((m, i) => (
                        <button
                          key={`${m.name}-${i}`}
                          onClick={() => pickIdentify(k.key, m)}
                          className="rounded-lg border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs text-slate-700 transition hover:border-emerald-500/50 hover:text-emerald-700"
                        >
                          {m.name}（{m.grid_cells}格 · {fmtMoney(m.value)}
                          {m.match ? ` · ${m.match}` : ""}）
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <button
                className="w-full rounded-xl border border-dashed border-ink-700 bg-white px-3 py-2 text-xs font-medium text-indigo-600 transition hover:border-indigo-500/60 hover:text-indigo-700"
                onClick={addKnown}
              >
                ＋ 添加已知红品（可先选第一个，再按期望继续识别）
              </button>
              {savedMsg && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600">
                  {savedMsg}
                </div>
              )}
            </div>

            <button
              className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
              onClick={() => setAdvanced(!advanced)}
            >
              {advanced ? "收起高级字段 ▲" : "展开高级字段 ▼（件数/总格数/其他品质/最低出价）"}
            </button>
            {advanced && (
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-ink-700/70 bg-ink-900/50 p-3">
                {[
                  ["红品件数", redCount, setRedCount],
                  ["红品总格数", redGrids, setRedGrids],
                  ["全场总格数 T", totalGrids, setTotalGrids],
                  ["蓝色格数", blueGrids, setBlueGrids],
                  ["白绿格数", wgGrids, setWgGrids],
                  ["紫色格数", purpleGrids, setPurpleGrids],
                  ["金色格数", goldGrids, setGoldGrids],
                  ["游戏最低出价", minBid, setMinBid],
                ].map(([label, val, set]) => (
                  <div key={label as string}>
                    <label className="field-label">{label as string}</label>
                    <input
                      className="input"
                      type="number"
                      placeholder="可选"
                      value={val as string}
                      onChange={(e) => (set as (s: string) => void)(e.target.value)}
                    />
                  </div>
                ))}
              </div>
            )}

            <div>
              <label className="field-label">
                利润率 margin（推荐出价 = 保守下限 p10 × margin）：{(margin * 100).toFixed(0)}%
              </label>
              <input
                type="range"
                min="0.5"
                max="1"
                step="0.01"
                value={margin}
                onChange={(e) => setMargin(Number(e.target.value))}
                className="w-full accent-indigo-500"
              />
              <div className="flex justify-between text-[11px] text-slate-400">
                <span>保守 50%</span>
                <span>默认 85%</span>
                <span>激进 100%</span>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={useCalib}
                onChange={(e) => setUseCalib(e.target.checked)}
                className="accent-indigo-500"
              />
              启用已知红品校准（实验性，实测会放大误差，默认关闭）
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={useBoard}
                onChange={(e) => setUseBoard(e.target.checked)}
                className="accent-indigo-500"
              />
              附加棋盘布局（CNN 融合估值）
            </label>
            {useBoard && <BoardEditor board={board} onChange={setBoard} />}

            <button className="btn-primary w-full" onClick={() => runEstimate()} disabled={loading}>
              {loading ? "计算中…" : "开始估值"}
            </button>
            {error && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-600">
                {error}
              </div>
            )}
          </div>
        </Card>
        <Card title="截图辅助估值（可选）" desc="从已扫描的图片自动填入表单">
          <div className="space-y-3">
            <select
              className="input"
              value={ocrPick}
              onChange={(e) => setOcrPick(e.target.value === "" ? "" : Number(e.target.value))}
            >
              <option value="">— 选择已扫描图片 —</option>
              {ocrTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.shape} · {t.path.split(/[\\/]/).pop()?.slice(0, 16)}（{(t.result?.items ?? []).length}件）
                </option>
              ))}
            </select>
            {pickedTask && (
              <div className="flex gap-3">
                <button
                  className="group relative w-28 shrink-0 overflow-hidden rounded-lg border border-ink-700 bg-ink-900"
                  onClick={() => setOcrZoom(pickedTask.id)}
                >
                  <img
                    src={`/api/ocr/image/${pickedTask.id}`}
                    alt=""
                    className="h-24 w-full object-contain transition group-hover:scale-105"
                  />
                </button>
                <div className="min-w-0 space-y-1.5">
                  {(pickedTask.result?.items ?? []).slice(0, 4).map((it, i) => (
                    <div key={i} className="text-xs text-slate-200">
                      {it.name} · {it.price.toLocaleString()} · {it.grid_cells}格
                    </div>
                  ))}
                  <button
                    className="btn-ghost !py-1.5 text-xs"
                    onClick={() => applyOcr(pickedTask)}
                  >
                    识别并填入表单
                  </button>
                </div>
              </div>
            )}
            {ocrMsg && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600">
                {ocrMsg}
              </div>
            )}
            <p className="text-xs text-slate-500">
              图片来自「截图输入」已扫描任务；点缩略图可放大查看。
            </p>
          </div>
        </Card>
      </div>

      <div className="space-y-5">
        {!result ? (
          <Card className="flex h-64 items-center justify-center text-slate-400">
            填写左侧信息后点击「开始估值」，这里会展示估值区间、出价建议与格数组合候选。
          </Card>
        ) : (
          <>
            <Card
              title="估值结果"
              right={
                <div className="flex gap-1.5">
                  {result.ml?.available && <Badge className="border-violet-500/40 bg-violet-500/15 text-violet-600">ML 修正</Badge>}
                  {result.cnn?.ok && <Badge className="border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-600">CNN 融合</Badge>}
                  {result.calibration.factor !== 1 && (
                    <Badge className="border-sky-500/40 bg-sky-500/15 text-sky-600">
                      校准 ×{result.calibration.factor.toFixed(2)}
                    </Badge>
                  )}
                </div>
              }
            >
              <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-ink-700/70 bg-ink-900/50 p-3">
                <div className="w-40">
                  <label className="field-label">我的出价（可选）</label>
                  <input
                    className="input"
                    type="number"
                    placeholder="如 800000"
                    value={bidInput}
                    onChange={(e) => setBidInput(e.target.value)}
                  />
                </div>
                <button className="btn-ghost" onClick={saveRecord} disabled={saving}>
                  {saving ? "保存中…" : "保存本场记录"}
                </button>
                <span className="text-xs text-slate-500">
                  保存后到「历史复盘」录入结算，模型会自动重训
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="红品期望价值" value={fmtWan(result.red.ev)} sub={`区间 ${fmtWan(result.red.p10)} ~ ${fmtWan(result.red.p90)}`} tone="accent" />
                <Stat label="全场总价值（期望）" value={fmtWan(result.full.ev)} sub={`区间 ${fmtWan(result.full.p10)} ~ ${fmtWan(result.full.p90)}`} tone="money" />
                <Stat
                  label={result.bid.should_bid ? "推荐出价" : "建议不出价"}
                  value={fmtWan(result.bid.recommended)}
                  sub={`p10 × ${(result.bid.margin * 100).toFixed(0)}%`}
                />
                <Stat label="绝对天花板" value={fmtWan(result.bid.max_bid)} sub="超过此价坚决放弃" tone={result.bid.should_bid ? "money" : "accent"} />
              </div>

              {/* 出价建议 / 不建议出价 横幅 */}
              <div
                className={`mt-3 rounded-xl border p-3 ${
                  result.bid.should_bid
                    ? "border-emerald-500/40 bg-emerald-500/5"
                    : "border-red-500/50 bg-red-500/10"
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className={`text-lg font-bold ${result.bid.should_bid ? "text-emerald-600" : "text-red-600"}`}>
                    {result.bid.should_bid ? "✓ 可以出价" : "✗ 不建议出价"}
                  </span>
                </div>
                <p className={`mt-1 text-sm ${result.bid.should_bid ? "text-emerald-700" : "text-red-700"}`}>
                  {result.bid.bid_reason}
                </p>
                {!result.bid.should_bid && (
                  <p className="mt-1 text-xs text-slate-500">
                    保守策略：估值不确定性大时宁可不拍，避免赢家诅咒导致亏损
                  </p>
                )}
              </div>

              {/* 利润分析 */}
              {result.bid.should_bid && (
                <div className="mt-2 flex flex-wrap gap-4 rounded-xl border border-ink-700/70 bg-ink-900/50 p-3 text-sm">
                  <span className="text-slate-500">
                    最坏情况利润: <span className="font-semibold text-emerald-600">{fmtWan(result.bid.worst_case_profit)}</span>
                  </span>
                  <span className="text-slate-500">
                    期望利润: <span className="font-semibold text-indigo-600">{fmtWan(result.bid.expected_profit)}</span>
                  </span>
                  <span className="text-slate-500">
                    不确定性: p10/ev = <span className="font-semibold text-slate-700">{(result.bid.uncertainty_ratio * 100).toFixed(0)}%</span>
                  </span>
                </div>
              )}

              <div className="mt-3 flex items-center gap-3">
                <span className="text-sm text-slate-500">风险等级</span>
                <Badge className={riskColor(result.bid.risk)}>
                  {result.bid.risk}（区间倍数 ×{result.bid.risk_score.toFixed(1)}）
                </Badge>
                <span className="text-xs text-slate-500">全场估值模式：{result.full.mode === "细分" ? "逐品质细分" : "红品 × 实测倍率"}</span>
              </div>
            </Card>

            <Card title="价值区间可视化" desc="柱体为 p10–p90，◇ 为期望值">
              <Chart option={chartOption} height={240} />
            </Card>

            <Card
              title="格数组合候选"
              desc={`点击候选可锁定并按该组合重算估值与出价（均格 ${avg}，1 位小数 · ±0.05 宽容匹配）`}
            >
              {lockedCand && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600">
                  <span>
                    当前估值已锁定为 {lockedCand.red_grids} 格 / {lockedCand.red_count} 件，出价按该组合重算
                  </span>
                  <button
                    className="rounded-md border border-emerald-500/40 px-2 py-0.5 hover:bg-emerald-500/10"
                    onClick={() => runEstimate(null)}
                  >
                    恢复综合估值
                  </button>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {result.candidates.map((c, i) => {
                  const isLocked =
                    lockedCand !== null &&
                    lockedCand.red_grids === c.red_grids &&
                    lockedCand.red_count === c.red_count;
                  return (
                    <div
                      key={`${c.red_grids}-${c.red_count}`}
                      className={`rounded-xl border px-3 py-2 text-sm transition ${
                        isLocked
                          ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-700 ring-1 ring-emerald-500/40"
                          : i === 0
                            ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-700"
                            : "border-ink-700 bg-ink-900/60 text-slate-600"
                      }`}
                    >
                      <button
                        className="font-semibold tabular-nums hover:text-slate-800"
                        onClick={() =>
                          runEstimate(isLocked ? null : { red_grids: c.red_grids, red_count: c.red_count })
                        }
                        title={isLocked ? "取消锁定，恢复综合估值" : "点击后按此格数组合重算估值与出价"}
                      >
                        {c.red_grids} 格 / {c.red_count} 件
                        {isLocked ? (
                          <span className="ml-1.5 text-[10px] text-emerald-600">已锁定</span>
                        ) : (
                          i === 0 && <span className="ml-1.5 text-[10px] text-indigo-600">最可能</span>
                        )}
                      </button>
                      {c.estimate && (
                        <div className="mt-1 text-xs tabular-nums text-indigo-600">
                          该候选红品期望 ≈ {fmtWan(c.estimate.ev)}（{fmtWan(c.estimate.p10)} ~ {fmtWan(c.estimate.p90)}）
                          {hasKnown && c.estimate.remaining_ev !== undefined && (
                            <span className="ml-1 text-emerald-600">
                              · 其余藏品期望 ≈ {fmtWan(c.estimate.remaining_ev)}
                            </span>
                          )}
                        </div>
                      )}
                      {c.compositions && c.compositions.length > 0 && (
                        <div className="mt-1 text-xs text-slate-500">
                          {c.compositions.slice(0, 3).map((comp, j) => (
                            <div key={j} className="flex flex-wrap items-center gap-1 tabular-nums">
                              {comp.map((s, k) => (
                                <span key={k} className="flex items-center gap-1">
                                  {k > 0 && <span className="text-slate-400">+</span>}
                                  <button
                                    className="rounded-md border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-indigo-600 transition hover:border-indigo-500/60 hover:bg-indigo-500/10"
                                    onClick={() => setSizePop(s)}
                                    title={`查看 ${s} 格藏品预期价格`}
                                  >
                                    {s}
                                  </button>
                                </span>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {sizePop !== null && gridStats[sizePop] && (
                <div className="mt-3 rounded-xl border border-indigo-500/40 bg-indigo-500/5 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-indigo-700">{sizePop} 格藏品预期价格</span>
                    <button
                      className="rounded-lg px-2 py-0.5 text-slate-500 transition hover:bg-ink-800 hover:text-slate-800"
                      onClick={() => setSizePop(null)}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm tabular-nums text-slate-600 md:grid-cols-3">
                    <div>图鉴数量：{gridStats[sizePop].count} 件</div>
                    <div className="text-indigo-600">期望（均值）：{fmtMoney(gridStats[sizePop].mean)}</div>
                    <div>中位数：{fmtMoney(gridStats[sizePop].median)}</div>
                    <div>区间 p10–p90：{fmtMoney(gridStats[sizePop].p10)} ~ {fmtMoney(gridStats[sizePop].p90)}</div>
                    <div>最低：{fmtMoney(gridStats[sizePop].min)}</div>
                    <div>最高：{fmtMoney(gridStats[sizePop].max)}</div>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      className="btn-ghost !py-1.5 text-xs"
                      onClick={() => fillKnownSize(sizePop)}
                    >
                      填入已知红品格数
                    </button>
                  </div>
                </div>
              )}
              {result.warnings.length > 0 && (
                <div className="mt-3 space-y-1 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700/80">
                  {result.warnings.map((w, i) => (
                    <div key={i}>⚠ {w}</div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="历史同类局参考" desc="均格接近的历史对局与成交结果">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500">
                      <th className="py-1.5 pr-3">局</th>
                      <th className="py-1.5 pr-3">格数组合</th>
                      <th className="py-1.5 pr-3">红品总价值</th>
                      <th className="py-1.5 pr-3">全场总价值</th>
                      <th className="py-1.5 pr-3">成交价</th>
                      <th className="py-1.5">结果</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {result.similar_games.map((g) => (
                      <tr key={g.game_no} className="border-t border-ink-700/60 text-slate-600">
                        <td className="py-2 pr-3">{g.game_no}</td>
                        <td className="py-2 pr-3 text-slate-500">{g.grid_combo}</td>
                        <td className="py-2 pr-3">{fmtMoney(g.red_value)}</td>
                        <td className="py-2 pr-3">{fmtMoney(g.full_value)}</td>
                        <td className="py-2 pr-3">{fmtMoney(g.deal_price)}</td>
                        <td className="py-2">
                          {g.profit === null ? (
                            <span className="text-slate-400">—</span>
                          ) : g.profit >= 0 ? (
                            <span className="text-emerald-600">+{fmtMoney(g.profit)}</span>
                          ) : (
                            <span className="text-rose-600">{fmtMoney(g.profit)}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {result.similar_games.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-3 text-center text-slate-400">
                          暂无相近均格的历史对局
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
    {ocrZoom !== null && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
        onClick={() => setOcrZoom(null)}
      >
        <img
          src={`/api/ocr/image/${ocrZoom}`}
          alt=""
          className="max-h-full max-w-full rounded-xl shadow-2xl"
        />
        <button
          className="absolute right-5 top-5 rounded-full bg-ink-800 px-3 py-1.5 text-sm text-slate-800"
          onClick={() => setOcrZoom(null)}
        >
          ✕ 关闭
        </button>
      </div>
    )}
    </>
  );
}
