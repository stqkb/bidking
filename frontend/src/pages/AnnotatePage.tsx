import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Card, Stat } from "../components/Card";
import type { CatalogItem } from "../types";
import { fmtMoney } from "../utils";

type Kind = "red" | "total" | "deal" | "profit";
const KIND_LABEL: Record<Kind, string> = {
  red: "红品",
  total: "藏品总价值",
  deal: "成交价",
  profit: "收益",
};

interface DetectCell {
  cell: [number, number, number, number];
  icon: [number, number, number, number];
  matches: { name: string; grid_cells: number; score: number; value?: number }[];
}

export default function AnnotatePage() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [images, setImages] = useState<{ path: string; url: string; name: string }[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [imagePath, setImagePath] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [cells, setCells] = useState<DetectCell[]>([]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [nameOverrides, setNameOverrides] = useState<Record<number, string>>({});
  const [gridOverrides, setGridOverrides] = useState<Record<number, string>>({});
  const [filterCells, setFilterCells] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [annotations, setAnnotations] = useState<any[]>([]);
  const [settle, setSettle] = useState<{
    total_value: number | null;
    deal_price: number | null;
    profit: number | null;
  } | null>(null);
  const [summary, setSummary] = useState<{
    items: { name: string; grid_cells: number; value: number }[];
    settle: { total_value: number | null; deal_price: number | null; profit: number | null };
  }>({ items: [], settle: { total_value: null, deal_price: null, profit: null } });
  const [summarySaving, setSummarySaving] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualBox, setManualBox] = useState<[number, number, number, number] | null>(null);
  const [manualName, setManualName] = useState("");
  const [manualGrid, setManualGrid] = useState("");
  const [manualValue, setManualValue] = useState("");
  const [manualDrag, setManualDrag] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null);
  const [manualThumbs, setManualThumbs] = useState<Record<string, string>>({});  // 藏品名 -> 代表图路径
  const [manualSort, setManualSort] = useState<"az" | "value_asc" | "value_desc">("az");
  const [autoClip, setAutoClip] = useState(false);
  const [won, setWon] = useState(false);  // 本人是否竞拍成功（收益规律统计用）
  const lastClipHash = useRef("");
  const firstPeek = useRef(true);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    api.catalogItems().then((r) => setItems(r.items)).catch(() => {});
    // 加载每个藏品的代表图（优先原始学习图，无则首张），供手动添加选择界面展示
    api.visionGallery()
      .then((g) => {
        const m: Record<string, string> = {};
        for (const it of g.items) {
          const ims = it.images ?? [];
          const pick = ims.find((x) => !x.variant) ?? ims[0];
          if (pick) m[it.name] = pick.path;
        }
        setManualThumbs(m);
      })
      .catch(() => {});
  }, []);

  const loadAnno = useCallback(async (p: string) => {
    try {
      const r = await fetch(`/api/vision/annotations?image_path=${encodeURIComponent(p)}`).then((x) => x.json());
      setAnnotations(r.annotations ?? []);
    } catch {
      setAnnotations([]);
    }
  }, []);

  const detect = useCallback(async (path: string) => {
    setBusy(true);
    setMsg("正在自动识别红品格子…");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30000);  // 防 OCR 卡死导致按钮一直禁用
    try {
      const [detRes, ocrRes] = await Promise.all([
        fetch("/api/vision/auto_detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_path: path }),
          signal: ac.signal,
        }),
        fetch("/api/ocr/recognize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
          signal: ac.signal,
        }),
      ]);
      const j = await detRes.json();
      const oj = await ocrRes.json().catch(() => ({}));
      const s = oj.settlement ?? {};
      setSettle({
        total_value: s.total_value ?? null,
        deal_price: s.deal_price ?? null,
        profit: s.profit ?? null,
      });
      // 结算字段自动并入本局汇总（跨图取第一个非空值）
      setSummary((prev) => ({
        ...prev,
        settle: {
          total_value: prev.settle.total_value ?? s.total_value ?? null,
          deal_price: prev.settle.deal_price ?? s.deal_price ?? null,
          profit: prev.settle.profit ?? s.profit ?? null,
        },
      }));
      setCells(j.cells ?? []);
      setChecked(new Set());
      setNameOverrides({});
      setGridOverrides({});
      // 自动把识别到的红品并入本局汇总（无需勾选）
      // 同图内同名红品（如两件相同藏品）分别保留；仅跨图（已汇总集合）同名合并
      setSummary((prev) => {
        const merged = [...prev.items];
        const prevNames = new Set(prev.items.map((it) => it.name));
        for (const c of j.cells ?? []) {
          const top = c.matches?.[0];
          if (!top || !top.name) continue;
          if (prevNames.has(top.name)) continue;
          merged.push({ name: top.name, grid_cells: top.grid_cells ?? 0, value: top.value ?? 0 });
        }
        return { ...prev, items: merged };
      });
      const parts = [`识别到 ${(j.cells ?? []).length} 个红品格子`];
      if (s.total_value != null) parts.push(`总价值 ${s.total_value.toLocaleString()}`);
      if (s.deal_price != null) parts.push(`成交价 ${s.deal_price.toLocaleString()}`);
      if (s.profit != null) parts.push(`收益 ${s.profit.toLocaleString()}`);
      setMsg(parts.join(" · ") + "，红品已自动计入本局汇总，可在下方修改后保存");
    } catch (e) {
      setMsg(
        e instanceof Error && e.name === "AbortError"
          ? "识别超时（30 秒），请重试"
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!autoClip) return;
    firstPeek.current = true;
    const loadClip = async () => {
      try {
        const r = await fetch("/api/clipboard", { method: "POST" });
        const j = await r.json();
        if (!j.ok) return;
        if (firstPeek.current) {
          // 只记录当前剪贴板哈希，不加载旧图
          firstPeek.current = false;
          lastClipHash.current = j.hash;
          return;
        }
        if (j.ok && j.hash && j.hash !== lastClipHash.current) {
          lastClipHash.current = j.hash;
          selectImage(j.path);
          setMsg("已自动采样剪贴板截图并识别，请勾选红品");
        }
      } catch {
        /* ignore */
      }
    };
    loadClip();
    const timer = setInterval(loadClip, 2000);
    return () => clearInterval(timer);
  }, [autoClip, detect]);

  const selectImage = (path: string) => {
    setImagePath(path);
    setImageUrl(`/api/vision/uploaded?path=${encodeURIComponent(path)}`);
    setCells([]);
    setChecked(new Set());
    setNameOverrides({});
    setGridOverrides({});
    loadAnno(path);
    detect(path);
  };

  const addImage = (path: string, autoSelect = true) => {
    const url = `/api/vision/uploaded?path=${encodeURIComponent(path)}`;
    const name = path.split(/[\\/]/).pop() ?? path;
    setImages((prev) => {
      if (prev.some((x) => x.path === path)) return prev;
      return [...prev, { path, url, name }];
    });
    if (autoSelect) {
      setActiveIdx(images.length);
      selectImage(path);
    }
  };

  const switchImage = (idx: number) => {
    if (idx < 0 || idx >= images.length) return;
    setActiveIdx(idx);
    selectImage(images[idx].path);
  };

  const removeImage = (idx: number) => {
    setImages((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) {
        setImagePath("");
        setImageUrl("");
        setCells([]);
        setChecked(new Set());
        setAnnotations([]);
      } else {
        const ni = Math.min(idx, next.length - 1);
        setActiveIdx(ni);
        selectImage(next[ni].path);
      }
      return next;
    });
  };

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("files", f);
    const r = await fetch("/api/vision/upload_multi", { method: "POST", body: fd });
    const j = await r.json();
    if (j.paths?.length) {
      // 先把所有图加入列表，再逐张自动识别（每张结果都并入本局汇总）
      setImages((prev) => {
        const merged = [...prev];
        for (const p of j.paths) {
          if (!merged.some((x) => x.path === p)) {
            merged.push({ path: p, url: `/api/vision/uploaded?path=${encodeURIComponent(p)}`, name: p.split(/[\\/]/).pop() ?? p });
          }
        }
        return merged;
      });
      setBusy(true);
      setMsg(`已加入 ${j.paths.length} 张图，正在逐张自动识别…`);
      for (let i = 0; i < j.paths.length; i++) {
        const p = j.paths[i];
        setActiveIdx(images.length + i);
        setImagePath(p);
        setImageUrl(`/api/vision/uploaded?path=${encodeURIComponent(p)}`);
        setCells([]);
        setChecked(new Set());
        setNameOverrides({});
        setGridOverrides({});
        loadAnno(p);
        await detect(p);
      }
      setBusy(false);
      setMsg(`已识别全部 ${j.paths.length} 张图，红品已计入本局汇总，请核对后保存`);
    }
  };

  const capture = async () => {
    const r = await fetch("/api/capture", { method: "POST" });
    const j = await r.json();
    if (!j.ok) {
      setMsg(j.error ?? "截图失败");
      return;
    }
    addImage(j.path);
  };

  const sampleClip = async () => {
    const r = await fetch("/api/clipboard", { method: "POST" });
    const j = await r.json();
    if (!j.ok) {
      setMsg(j.error ?? "剪贴板没有图片");
      return;
    }
    addImage(j.path);
  };

  const toggle = (i: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const manualDown = (e: React.MouseEvent) => {
    if (!imgRef.current || !manualOpen) return;
    const ir = imgRef.current.getBoundingClientRect();
    setManualDrag({ sx: e.clientX - ir.left, sy: e.clientY - ir.top, ex: e.clientX - ir.left, ey: e.clientY - ir.top });
  };
  const manualMove = (e: React.MouseEvent) => {
    if (!manualDrag || !imgRef.current) return;
    const ir = imgRef.current.getBoundingClientRect();
    setManualDrag({ ...manualDrag, ex: e.clientX - ir.left, ey: e.clientY - ir.top });
  };
  const manualUp = () => {
    if (!manualDrag || !imgRef.current) return;
    const sx = imgRef.current.naturalWidth / imgRef.current.width;
    const sy = imgRef.current.naturalHeight / imgRef.current.height;
    setManualBox([
      Math.round(Math.min(manualDrag.sx, manualDrag.ex) * sx),
      Math.round(Math.min(manualDrag.sy, manualDrag.ey) * sy),
      Math.round(Math.max(manualDrag.sx, manualDrag.ex) * sx),
      Math.round(Math.max(manualDrag.sy, manualDrag.ey) * sy),
    ]);
    setManualDrag(null);
  };

  const saveManual = async () => {
    if (!manualBox || !manualName.trim()) {
      setMsg("请框选红品图标并填写名称");
      return;
    }
    setBusy(true);
    try {
      const grid = Number(manualGrid) || 0;
      const catItem = items.find((x) => x.name === manualName.trim());
      const value = manualValue ? Number(manualValue) || 0 : catItem ? catItem.value ?? 0 : 0;
      const r = await fetch("/api/vision/annotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_path: imagePath,
          box: manualBox,
          kind: "red",
          name: manualName.trim(),
          grid_cells: grid,
        }),
      });
      const j = await r.json();
      if (j.ok) {
        // 手动添加的红品也并入跨图汇总
        setSummary((prev) => {
          const names = new Set(prev.items.map((it) => it.name));
          if (!names.has(j.name)) {
            return {
              ...prev,
              items: [...prev.items, { name: j.name, grid_cells: grid, value }],
            };
          }
          return prev;
        });
        setMsg(`已手动添加红品：${j.name}，并计入本局汇总`);
        setManualBox(null);
        setManualName("");
        setManualGrid("");
        setManualValue("");
        setManualOpen(false);
        loadAnno(imagePath);
      } else {
        setMsg(j.detail ?? "保存失败");
      }
    } finally {
      setBusy(false);
    }
  };

  const saveChecked = async () => {
    if (checked.size === 0) {
      setMsg("请先勾选要保存的红品");
      return;
    }
    setBusy(true);
    try {
    const picked: { name: string; grid_cells: number; value: number }[] = [];
    for (const i of Array.from(checked)) {
      const cell = cells[i];
      const name = (nameOverrides[i] ?? cell.matches[0]?.name ?? "").trim();
      const grid = Number(gridOverrides[i] ?? cell.matches[0]?.grid_cells ?? 0) || 0;
      if (!name) continue;
      const m = cell.matches[0];
      const value = m ? m.value ?? 0 : 0;
      picked.push({ name, grid_cells: grid, value });
      try {
        const r = await fetch("/api/vision/annotate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image_path: imagePath,
            box: cell.icon,
            kind: "red",
            name,
            grid_cells: grid,
          }),
        });
        const j = await r.json();
      } catch {
        /* ignore */
      }
    }
    // 跨图合并：与已汇总集合（prev.items）同名则跳过；
    // 本次勾选（同一张图）内的同名红品分别保留（如两件相同藏品）
    const curSettle = settle;
    setSummary((prev) => {
      const merged = [...prev.items];
      const prevNames = new Set(prev.items.map((it) => it.name));
      for (const p of picked) {
        if (!prevNames.has(p.name)) {
          merged.push(p);
        }
      }
      const mergedSettle = {
        total_value: prev.settle.total_value ?? curSettle?.total_value ?? null,
        deal_price: prev.settle.deal_price ?? curSettle?.deal_price ?? null,
        profit: prev.settle.profit ?? curSettle?.profit ?? null,
      };
      return { items: merged, settle: mergedSettle };
    });
    setMsg(`已勾选 ${picked.length} 件红品，汇总后共 ${summary.items.length + picked.length} 件`);
    setChecked(new Set());
    loadAnno(imagePath);
    } finally {
      setBusy(false);
    }
  };

  const updateSettle = (k: "total_value" | "deal_price" | "profit", v: string) => {
    setSummary((prev) => {
      const settle = { ...prev.settle, [k]: v === "" ? null : Number(v) || 0 };
      // 总价值 / 成交价 任一变更时，收益自动按「总价值 − 成交价」算出
      if (k !== "profit") {
        const tv = settle.total_value;
        const dp = settle.deal_price;
        settle.profit = tv != null && dp != null ? tv - dp : null;
      }
      return { ...prev, settle };
    });
  };

  const saveSummary = async () => {
    if (summary.items.length === 0) {
      setMsg("还没有汇总红品，请先勾选保存");
      return;
    }
    setSummarySaving(true);
    try {
      const r = await fetch("/api/ocr/save_summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: summary.items,
          settlement: summary.settle,
          won,
        }),
      });
      const text = await r.text();
      let j: any = null;
      try {
        j = JSON.parse(text);
      } catch {
        /* 后端可能返回非 JSON（如 500 页面） */
      }
      if (j && j.ok) {
        const tip =
          j.profit_ok === 0
            ? "，⚠️ 收益核验不通过（收益 ≠ 总价值−成交价），已保存但未进入模型训练"
            : "，模型后台重训中";
        setMsg(
          `已保存为对局 #${j.game_no}：红品 ${j.red_count} 件 / ${j.total_cells} 格（均格 ${j.red_avg}）` +
          (j.settlement?.total_value != null ? `，总价值 ${j.settlement.total_value.toLocaleString()}` : "") +
          (j.settlement?.deal_price != null ? `，成交价 ${j.settlement.deal_price.toLocaleString()}` : "") +
          tip,
        );
        // 保存成功：清空本局所有图片与汇总，准备下一局
        resetAll();
      } else {
        setMsg((j && (j.detail || j.error)) || `保存失败（HTTP ${r.status}，响应非 JSON）`);
      }
    } catch (e) {
      setMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSummarySaving(false);
    }
  };

  const resetAll = () => {
    setImages([]);
    setActiveIdx(0);
    setImagePath("");
    setImageUrl("");
    setCells([]);
    setChecked(new Set());
    setNameOverrides({});
    setGridOverrides({});
    setSummary({ items: [], settle: { total_value: null, deal_price: null, profit: null } });
    setWon(false);
    setSettle(null);
    setAnnotations([]);
    setManualOpen(false);
    setManualBox(null);
    setManualName("");
    setManualGrid("");
    setManualValue("");
  };

  const updateSummaryItem = (idx: number, patch: Partial<{ name: string; grid_cells: number; value: number }>) => {
    setSummary((prev) => ({
      ...prev,
      items: prev.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    }));
  };

  const removeSummaryItem = (idx: number) => {
    setSummary((prev) => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }));
  };

  const deleteAnno = async (id: number) => {
    // 删除标注记录（从图库移除学习样本）
    const ann = annotations.find((a) => a.id === id);
    if (!ann) return;
    if (ann.kind === "red" && ann.name) {
      await fetch("/api/vision/delete_learn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: [ann.name] }),
      });
    }
    loadAnno(imagePath);
    setMsg("已删除标注");
  };

  const filteredItems = filterCells
    ? items.filter((it) => it.grid_cells === Number(filterCells))
    : items;
  const manualItems = manualGrid
    ? items.filter((it) => it.grid_cells === Number(manualGrid))
    : items;
  // 手动添加的图片选择器：排序（名称 A-Z / 价值升 / 价值降）
  const sortedManualItems = useMemo(() => {
    const arr = [...manualItems];
    if (manualSort === "az") {
      arr.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    } else if (manualSort === "value_asc") {
      arr.sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
    } else {
      arr.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    }
    return arr;
  }, [manualItems, manualSort]);

  const pickManual = (it: CatalogItem) => {
    setManualName(it.name);
    setManualGrid(String(it.grid_cells));
    setManualValue(String(it.value));
  };

  return (
    <div className="space-y-5">
      <Card
        title="标注校准（勾选确认）"
        desc="选择图片后自动识别红品格子与候选 → 勾选正确的 → 保存入库学习；标注记录可查看缩略图并删除"
      >
        <div className="flex flex-wrap items-center gap-2">
          <label className="btn-ghost !py-2 text-xs">
            上传截图（可多选）
            <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
          </label>
          <button className="btn-primary !py-2 text-xs" onClick={capture}>
            📷 截取游戏画面
          </button>
          <button className="btn-ghost !py-2 text-xs" onClick={sampleClip}>
            📋 剪贴板截图
          </button>
          <button className="btn-ghost !py-2 text-xs" onClick={() => imagePath && detect(imagePath)} disabled={busy}>
            🔄 重新识别
          </button>
          <label className="flex items-center gap-1.5 text-xs text-content-secondary">
            <input
              type="checkbox"
              className="accent-indigo-500"
              checked={autoClip}
              onChange={(e) => setAutoClip(e.target.checked)}
            />
            自动采样 Win+Shift+S（截图即识别）
          </label>
          <span className="text-xs text-content-secondary">按格数筛选红品：</span>
          <select className="input w-28 !py-1.5 text-xs" value={filterCells} onChange={(e) => setFilterCells(e.target.value)}>
            <option value="">全部格数</option>
            {Array.from(new Set(items.map((it) => it.grid_cells))).sort((a, b) => a - b).map((g) => (
              <option key={g} value={g}>{g} 格</option>
            ))}
          </select>
        </div>
        {images.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-content-secondary">图片（{images.length}）：</span>
            {images.map((img, i) => (
              <button
                key={img.path}
                className={`group relative flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition ${
                  i === activeIdx ? "border-gold-400/60 bg-gold-soft text-gold-400" : "border-ink-700 text-content-primary hover:border-ink-500"
                }`}
                onClick={() => switchImage(i)}
              >
                <img src={img.url} alt="" className="h-6 w-6 rounded object-contain bg-ink-900" />
                <span className="max-w-28 truncate">{img.name.slice(0, 14)}</span>
                <span
                  className="ml-0.5 text-vermilion-400 opacity-0 transition group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeImage(i);
                  }}
                >
                  ✕
                </span>
              </button>
            ))}
          </div>
        )}
        {msg && <div className="mt-2 text-sm text-jade-400">{msg}</div>}
      </Card>

      {imageUrl ? (
        <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
          <Card
            title="原图与自动识别"
            desc={manualOpen ? "手动添加模式：拖拽框出漏检的红品图标" : "红框为自动检测到的红品格子"}
            right={
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {settle && (settle.total_value != null || settle.deal_price != null || settle.profit != null) && (
                  <>
                    <span className="text-xs text-content-secondary">
                      总价值{" "}
                      <b className="text-jade-400">
                        {settle.total_value != null ? settle.total_value.toLocaleString() : "—"}
                      </b>
                    </span>
                    <span className="text-xs text-content-secondary">
                      成交价{" "}
                      <b className="text-sky-400">
                        {settle.deal_price != null ? settle.deal_price.toLocaleString() : "—"}
                      </b>
                    </span>
                    <span className="text-xs text-content-secondary">
                      收益{" "}
                      <b className={(settle.profit ?? 0) >= 0 ? "text-jade-400" : "text-vermilion-400"}>
                        {settle.profit != null ? settle.profit.toLocaleString() : "—"}
                      </b>
                    </span>
                  </>
                )}
                <button
                  className={`btn-ghost !py-1.5 text-xs ${manualOpen ? "border-amber-500/60 text-amber-400" : ""}`}
                  onClick={() => setManualOpen((v) => !v)}
                >
                  {manualOpen ? "取消手动添加" : "➕ 手动添加漏检红品"}
                </button>
              </div>
            }
          >
            <div
              className="relative max-h-[560px] w-full overflow-auto rounded-xl border border-ink-700 bg-ink-900"
              onMouseDown={manualDown}
              onMouseMove={manualMove}
              onMouseUp={manualUp}
              onMouseLeave={() => setManualDrag(null)}
            >
              <div className="relative inline-block">
                <img ref={imgRef} src={imageUrl} alt="" className="block max-w-full select-none" draggable={false} />
                {cells.map((c, i) => {
                  const sx = imgRef.current ? imgRef.current.width / imgRef.current.naturalWidth : 1;
                  return (
                    <div
                      key={i}
                      className={`pointer-events-none absolute border-2 ${checked.has(i) ? "border-jade-400" : "border-fuchsia-400"}`}
                      style={{
                        left: c.icon[0] * sx,
                        top: c.icon[1] * sx,
                        width: (c.icon[2] - c.icon[0]) * sx,
                        height: (c.icon[3] - c.icon[1]) * sx,
                      }}
                    />
                  );
                })}
                {manualDrag && (
                  <div
                    className="pointer-events-none absolute border-2 border-amber-400 bg-amber-400/20"
                    style={{
                      left: Math.min(manualDrag.sx, manualDrag.ex),
                      top: Math.min(manualDrag.sy, manualDrag.ey),
                      width: Math.abs(manualDrag.ex - manualDrag.sx),
                      height: Math.abs(manualDrag.ey - manualDrag.sy),
                    }}
                  />
                )}
              </div>
            </div>
            {manualOpen && (
              <div className="mt-2 rounded-xl border border-amber-400/30 bg-amber-500/5 p-2.5">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <input
                    className="input w-20 !py-1 text-xs"
                    placeholder="格数筛选"
                    type="number"
                    value={manualGrid}
                    onChange={(e) => setManualGrid(e.target.value)}
                  />
                  <select
                    className="input w-32 !py-1 text-xs"
                    value={manualSort}
                    onChange={(e) => setManualSort(e.target.value as typeof manualSort)}
                  >
                    <option value="az">名称 A-Z</option>
                    <option value="value_asc">价值 ↑</option>
                    <option value="value_desc">价值 ↓</option>
                  </select>
                  <input
                    className="input w-28 !py-1 text-xs"
                    placeholder="价值(可改)"
                    type="number"
                    value={manualValue}
                    onChange={(e) => setManualValue(e.target.value)}
                  />
                  <button
                    className="btn-primary !py-1.5 text-xs"
                    onClick={saveManual}
                    disabled={busy || !manualBox}
                    title={
                      busy
                        ? "正在处理中…，请稍候"
                        : !manualBox
                          ? "请先在图片上拖拽框选红品图标"
                          : "保存手动红品"
                    }
                  >
                    保存手动红品
                  </button>
                  {busy && <span className="text-[11px] text-amber-400">处理中…</span>}
                  {manualBox && <span className="text-[11px] text-content-secondary">已框选 ({manualBox[0]},{manualBox[1]})</span>}
                </div>
                <div className="mb-1 text-[11px] text-content-secondary">
                  框选漏检红品图标后，点击下方图片选择藏品（共 {sortedManualItems.length} 件）：
                  {manualName && <span className="ml-1 text-amber-400">已选：{manualName}</span>}
                </div>
                <div className="grid max-h-60 grid-cols-3 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                  {sortedManualItems.map((it) => {
                    const tp = manualThumbs[it.name];
                    const sel = manualName === it.name;
                    return (
                      <button
                        key={it.id}
                        onClick={() => pickManual(it)}
                        className={`flex flex-col items-stretch overflow-hidden rounded-lg border bg-ink-850 text-left transition ${
                          sel
                            ? "border-amber-400 ring-1 ring-amber-400/60"
                            : "border-ink-700 hover:border-ink-500"
                        }`}
                      >
                        <div className="flex h-14 w-full items-center justify-center bg-ink-900">
                          {tp ? (
                            <img
                              src={`/api/vision/uploaded?path=${encodeURIComponent(tp)}`}
                              alt={it.name}
                              className="h-full w-full object-contain"
                              loading="lazy"
                            />
                          ) : (
                            <span className="text-base text-content-primary">{it.name.slice(0, 1)}</span>
                          )}
                        </div>
                        <div className="px-1 py-0.5">
                          <div className="truncate text-[10px] text-content-primary">{it.name}</div>
                          <div className="text-[9px] text-content-secondary">{it.grid_cells}格 · {fmtMoney(it.value)}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>

          <Card title="自动识别结果（已计入本局汇总）" desc="识别到的红品已自动加入下方汇总，可在此参考或直接编辑汇总">
            <div className="space-y-2">
              {cells.length === 0 && !busy && <div className="py-4 text-center text-sm text-content-secondary">未检测到红品格子</div>}
              {cells.map((c, i) => {
                const top = c.matches[0];
                const thumb = `/api/vision/crop_box?image_path=${encodeURIComponent(imagePath)}&box=${c.icon.join(",")}`;
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-lg border border-ink-700 p-1.5"
                  >
                    <img src={thumb} alt="" className="h-11 w-11 shrink-0 rounded border border-ink-700 object-contain bg-ink-900" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-content-primary">{top?.name ?? "未识别"}</div>
                      <span className="text-[10px] text-content-secondary">
                        {top ? `${top.grid_cells ?? 0}格 · ${(top.score * 100).toFixed(0)}% · ${top.value != null ? fmtMoney(top.value) : "—"}` : "无候选"}
                      </span>
                    </div>
                  </div>
                );
              })}
              <div className="text-[11px] text-content-secondary">
                提示：识别结果已自动入汇总；如需补录漏检藏品，请用上方"手动添加漏检红品"；识别错的在下方汇总里删除或改选。
              </div>
            </div>
          </Card>
        </div>
      ) : (
        <Card title="选择图片" desc="先上传截图、截取游戏画面或采样剪贴板">
          <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-ink-700 text-sm text-content-secondary">
            尚未选择图片
          </div>
        </Card>
      )}

      {summary.items.length > 0 && (
        <Card title="本局汇总（跨图合并）" desc="各图勾选的红品已合并，确认后保存为一条历史对局用于训练">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="红品数" value={summary.items.length} tone="accent" />
            <Stat
              label="红品平均格数"
              value={summary.items.length ? (Math.floor((summary.items.reduce((s, it) => s + it.grid_cells, 0) / summary.items.length) * 10) / 10).toFixed(1) : "—"}
            />
            <Stat
              label="红品总格数"
              value={summary.items.reduce((s, it) => s + it.grid_cells, 0)}
            />
            <div>
              <div className="text-xs text-content-secondary">总价值（可改）</div>
              <input
                className="input mt-1 w-full !py-1 text-sm tabular-nums"
                type="number"
                value={summary.settle.total_value ?? ""}
                placeholder="—"
                onChange={(e) => updateSettle("total_value", e.target.value)}
              />
            </div>
            <div>
              <div className="text-xs text-content-secondary">成交价（可改）</div>
              <input
                className="input mt-1 w-full !py-1 text-sm tabular-nums"
                type="number"
                value={summary.settle.deal_price ?? ""}
                placeholder="—"
                onChange={(e) => updateSettle("deal_price", e.target.value)}
              />
            </div>
            <div>
              <div className="text-xs text-content-secondary">收益（= 总价值−成交价，自动算）</div>
              <input
                className={`input mt-1 w-full !py-1 text-sm tabular-nums ${
                  summary.settle.profit != null && summary.settle.profit < 0 ? "!text-vermilion-400" : "!text-jade-400"
                }`}
                type="number"
                value={summary.settle.profit ?? ""}
                placeholder="—"
                onChange={(e) => updateSettle("profit", e.target.value)}
              />
            </div>
          </div>
          {(() => {
            const tv = summary.settle.total_value;
            const dp = summary.settle.deal_price;
            const pf = summary.settle.profit;
            if (tv == null || dp == null || pf == null) return null;
            const calc = tv - dp;
            const ok = Math.abs(pf - calc) <= 0.5;
            return ok ? (
              <div className="mt-2 rounded-lg border border-jade-400/40 bg-jade-soft px-3 py-1.5 text-xs text-jade-400">
                ✓ 收益核验通过：{fmtMoney(pf)} = 总价值 − 成交价
              </div>
            ) : (
              <div className="mt-2 rounded-lg border border-vermilion-400/40 bg-vermilion-soft px-3 py-1.5 text-xs text-vermilion-400">
                ✗ 收益核验不通过：收益应为 总价值 − 成交价 = {fmtMoney(calc)}（当前 {fmtMoney(pf)}）。保存后该局将标红，且<strong>不进入模型训练</strong>。
              </div>
            );
          })()}
          <div className="mt-2 space-y-1">
            {summary.items.map((it, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg border border-ink-700/60 bg-ink-900/40 p-1.5 text-xs">
                <span className="text-content-secondary">{i + 1}.</span>
                <select
                  className="input min-w-32 flex-1 !py-0.5 text-xs"
                  value={it.name}
                  onChange={(e) => {
                    const it2 = items.find((x) => x.name === e.target.value);
                    updateSummaryItem(i, {
                      name: e.target.value,
                      grid_cells: it2 ? it2.grid_cells : it.grid_cells,
                      value: it2 ? it2.value : it.value,
                    });
                  }}
                >
                  {items.map((it2) => (
                    <option key={it2.id} value={it2.name}>
                      {it2.name}（{it2.grid_cells}格 · {fmtMoney(it2.value)}）
                    </option>
                  ))}
                </select>
                <input
                  className="input w-16 !py-0.5 text-xs"
                  type="number"
                  value={it.grid_cells}
                  onChange={(e) => updateSummaryItem(i, { grid_cells: Number(e.target.value) || 0 })}
                />
                <input
                  className="input w-24 !py-0.5 text-xs"
                  type="number"
                  value={it.value}
                  onChange={(e) => updateSummaryItem(i, { value: Number(e.target.value) || 0 })}
                />
                <button
                  className="text-xs text-vermilion-400 hover:text-vermilion-400"
                  onClick={() => removeSummaryItem(i)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              className="btn-ghost !py-1 text-xs"
              onClick={() => setSummary((prev) => ({
                ...prev,
                items: [...prev.items, { name: "", grid_cells: 1, value: 0 }],
              }))}
            >
              ＋ 添加红品
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-content-primary">
              <input
                type="checkbox"
                checked={won}
                onChange={(e) => setWon(e.target.checked)}
                className="h-4 w-4 rounded border-ink-600"
              />
              本人竞拍成功（收益规律仅统计勾选对局）
            </label>
            <button className="btn-primary !py-2 text-xs" onClick={saveSummary} disabled={summarySaving}>
              {summarySaving ? "保存中…" : "💾 保存本局（并入训练）"}
            </button>
            <button
              className="btn-ghost !py-2 text-xs text-vermilion-400"
              onClick={resetAll}
            >
              清空本局
            </button>
          </div>
        </Card>
      )}

      {annotations.length > 0 && (
        <Card title={`本图标注记录（${annotations.length}）`} desc="点击缩略图可放大核对，红品删除会同时移除学习样本">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {annotations.map((a) => {
              const thumb = `/api/vision/crop_box?image_path=${encodeURIComponent(a.image_path)}&box=${a.box.replace(/[\[\] ]/g, "")}`;
              return (
                <div key={a.id} className="rounded-xl border border-ink-700 bg-ink-900 p-2">
                  <img src={thumb} alt="" className="h-24 w-full rounded-lg border border-ink-700 object-contain bg-ink-950" />
                  <div className="mt-1.5 text-xs font-semibold text-content-primary">
                    {KIND_LABEL[a.kind as Kind] ?? a.kind}
                  </div>
                  <div className="text-[11px] text-content-secondary">
                    {a.name || "—"}
                    {a.grid_cells ? ` · ${a.grid_cells}格` : ""}
                    {a.value != null ? ` · ${a.value.toLocaleString()}` : ""}
                  </div>
                  <button
                    className="mt-1.5 w-full rounded-lg border border-vermilion-400/40 bg-vermilion-soft py-1 text-[11px] text-vermilion-400"
                    onClick={() => deleteAnno(a.id)}
                  >
                    删除
                  </button>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
