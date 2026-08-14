import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Card } from "../components/Card";
import Chart from "../components/Chart";
import type { CatalogResp, VisionItem } from "../types";
import { fmtMoney } from "../utils";

export default function CatalogPage() {
  const [cat, setCat] = useState<CatalogResp | null>(null);
  const [msg, setMsg] = useState("");
  const [gallery, setGallery] = useState<VisionItem[]>([]);
  const [sizeFilter, setSizeFilter] = useState<number | "">("");
  const [sortBy, setSortBy] = useState<"value_desc" | "value_asc" | "name">("value_desc");
  const [search, setSearch] = useState("");
  const [onlyNoImage, setOnlyNoImage] = useState(false);
  const [needLearn, setNeedLearn] = useState<Set<number>>(new Set());
  const [onlyNeedLearn, setOnlyNeedLearn] = useState(false);
  const [learnFilter, setLearnFilter] = useState<"all" | "learned" | "not">("all");
  const [zoom, setZoom] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"cards" | "table">("table");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [detail, setDetail] = useState<VisionItem | null>(null);
  const [detailSel, setDetailSel] = useState<Set<string>>(new Set());
  const [detailBusy, setDetailBusy] = useState(false);
  const [imgMissing, setImgMissing] = useState<Set<string>>(new Set());
  // 页面内删除确认：{ kind: 'detail'|'catalog', count } 或 null
  const [confirmDel, setConfirmDel] = useState<{ kind: "detail" | "catalog"; count: number } | null>(null);

  const load = useCallback(async () => {
    setCat(await api.catalog());
  }, []);

  useEffect(() => {
    load().catch(() => {});
    api.visionGallery().then((r) => {
      setGallery(r.items);
      setNeedLearn(new Set(r.items.filter((x) => !x.has_image).map((x) => x.cat_id)));
    }).catch(() => {});
  }, [load]);

  // 回到页面/窗口聚焦时自动刷新（数据在后端变化时同步显示）
  useEffect(() => {
    const refresh = () => {
      if (document.hidden) return;
      api.visionGallery().then((r) => {
        setGallery(r.items);
        setNeedLearn(new Set(r.items.filter((x) => !x.has_image).map((x) => x.cat_id)));
      }).catch(() => {});
      load().catch(() => {});
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  const importXlsx = async () => {
    try {
      const r = await api.importCatalog();
      setMsg(`导入成功：${r.imported} 件红色拍品`);
      load();
      setTimeout(() => setMsg(""), 4000);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const chartOption = useMemo(() => {
    if (!cat) return {};
    return {
      tooltip: { trigger: "axis" },
      legend: { textStyle: { color: "#94a3b8" }, top: 0 },
      grid: { left: 56, right: 20, top: 34, bottom: 30 },
      xAxis: {
        type: "category",
        data: cat.grids.map((g) => g.grid_cells + " 格"),
        axisLabel: { color: "#94a3b8" },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#94a3b8", formatter: (v: number) => (v / 10000).toFixed(0) + "万" },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      series: [
        {
          name: "均值",
          type: "bar",
          data: cat.grids.map((g) => g.mean),
          itemStyle: { color: "#818cf8", borderRadius: [5, 5, 0, 0] },
        },
        {
          name: "中位数",
          type: "bar",
          data: cat.grids.map((g) => g.median),
          itemStyle: { color: "#34d399", borderRadius: [5, 5, 0, 0] },
        },
        {
          name: "p10–p90",
          type: "custom",
          renderItem: (params: any, api2: any) => {
            const i = params.dataIndex;
            const g = cat.grids[i];
            const low = api2.coord([i, g.p10]);
            const high = api2.coord([i, g.p90]);
            return {
              type: "line",
              shape: {
                x1: low[0],
                y1: low[1],
                x2: high[0],
                y2: high[1],
              },
              style: { stroke: "#f59e0b", lineWidth: 4 },
            };
          },
          data: cat.grids.map(() => 0),
        },
      ],
    };
  }, [cat]);

  const filtered = useMemo(() => {
    let list = gallery;
    if (sizeFilter !== "") {
      list = list.filter((g) => g.grid_cells === sizeFilter);
    }
    if (search.trim()) {
      list = list.filter((g) => g.name.includes(search.trim()));
    }
    if (onlyNoImage) {
      list = list.filter((g) => !g.has_image);
    }
    if (onlyNeedLearn) {
      list = list.filter((g) => needLearn.has(g.cat_id));
    }
    if (learnFilter === "learned") {
      list = list.filter((g) => g.has_learn);
    } else if (learnFilter === "not") {
      list = list.filter((g) => !g.has_learn);
    }
    const arr = [...list];
    if (sortBy === "value_desc") arr.sort((a, b) => b.value - a.value);
    else if (sortBy === "value_asc") arr.sort((a, b) => a.value - b.value);
    else arr.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    return arr;
  }, [gallery, sizeFilter, sortBy, search, onlyNoImage, onlyNeedLearn, needLearn, learnFilter]);

  const toggleNeed = (catId: number) => {
    setNeedLearn((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  const learnedChecked = gallery.filter((g) => needLearn.has(g.cat_id) && g.has_learn);
  const deleteLearnSelected = async () => {
    if (learnedChecked.length === 0) return;
    if (!window.confirm(`删除选中的 ${learnedChecked.length} 件藏品的已学样本？删除后它们回到「未学习」，可重新截图学习。`)) return;
    await api.visionDeleteLearn(learnedChecked.map((x) => x.name));
    setMsg(`已删除 ${learnedChecked.length} 件藏品的已学样本，可重新截图学习`);
    const r = await api.visionGallery();
    setGallery(r.items);
  };

  const sizes = useMemo(
    () => Array.from(new Set(gallery.map((g) => g.grid_cells))).sort((a, b) => a - b),
    [gallery],
  );

  const toggleSelect = (catId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    setConfirmDel({ kind: "catalog", count: selected.size });
  };

  const deleteDetailSelected = async () => {
    if (!detail || detailSel.size === 0) return;
    setConfirmDel({ kind: "detail", count: detailSel.size });
  };

  // 真正执行删除（由页面内确认弹窗调用）
  const confirmExec = async () => {
    if (!confirmDel) return;
    const kind = confirmDel.kind;
    setConfirmDel(null);
    if (kind === "catalog") {
      setDeleting(true);
      try {
        const r = await api.catalogDelete(Array.from(selected));
        setMsg(`已删除 ${r.deleted ?? 0} 件藏品，模型后台重训中`);
        setSelected(new Set());
        await Promise.all([load(), api.visionGallery().then((x) => setGallery(x.items))]);
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setDeleting(false);
      }
    } else {
      setDetailBusy(true);
      setMsg(`正在删除选中的 ${detailSel.size} 张学习图片…`);
      try {
        const r = await api.visionDeleteImages(Array.from(detailSel));
        setMsg(`已删除 ${r.deleted ?? detailSel.size} 张学习图片`);
        setTimeout(() => setMsg(""), 3000);
        const gal = await api.visionGallery();
        setGallery(gal.items);
        setNeedLearn(new Set(gal.items.filter((x) => !x.has_image).map((x) => x.cat_id)));
        const upd = gal.items.find((x) => x.cat_id === detail?.cat_id) ?? null;
        setDetail(upd);
        setDetailSel(new Set());
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setDetailBusy(false);
      }
    }
  };

  return (
    <div className="space-y-5">
      {msg && (
        <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-2.5 text-sm text-indigo-600">
          {msg}
        </div>
      )}

      {confirmDel && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6">
          <div className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-5 shadow-2xl">
            <div className="mb-2 text-base font-semibold text-slate-200">
              {confirmDel.kind === "detail" ? "删除学习图片" : "删除藏品"}
            </div>
            <p className="mb-5 text-sm text-slate-400">
              确定删除选中的 <span className="font-semibold text-rose-400">{confirmDel.count}</span>{" "}
              {confirmDel.kind === "detail" ? "张学习图片" : "件藏品"}吗？
              {confirmDel.kind === "detail"
                ? "该藏品对应样本会减少，操作不可撤销。"
                : "删除后模型会自动重训，操作不可撤销。"}
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="btn-ghost !py-2 text-sm"
                onClick={() => setConfirmDel(null)}
                disabled={deleting || detailBusy}
              >
                取消
              </button>
              <button
                className="btn-primary !py-2 text-sm !bg-rose-500 !shadow-rose-500/20 hover:!bg-rose-400"
                onClick={confirmExec}
                disabled={deleting || detailBusy}
              >
                {deleting || detailBusy ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}

      <Card
        title={`红色图鉴（${cat?.total ?? "—"} 件）`}
        desc="权威价格表来自你提供的 Excel；估值引擎会与 31 局实测单价融合"
        right={
          <button className="btn-ghost !py-2 text-xs" onClick={importXlsx}>
            重新导入 Excel
          </button>
        }
      >
        <Chart option={chartOption} height={300} />
      </Card>
      <Card title="按格数统计" desc="单件价值（金币）">
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="py-2 pr-3">格数</th>
                <th className="py-2 pr-3">数量</th>
                <th className="py-2 pr-3">最低</th>
                <th className="py-2 pr-3">p10</th>
                <th className="py-2 pr-3">均值</th>
                <th className="py-2 pr-3">中位</th>
                <th className="py-2 pr-3">p90</th>
                <th className="py-2">最高</th>
              </tr>
            </thead>
            <tbody>
              {cat?.grids.map((g) => (
                <tr key={g.grid_cells} className="border-t border-ink-700/60 text-slate-600">
                  <td className="py-2 pr-3 font-semibold">{g.grid_cells} 格</td>
                  <td className="py-2 pr-3">{g.count}</td>
                  <td className="py-2 pr-3 text-slate-500">{fmtMoney(g.min)}</td>
                  <td className="py-2 pr-3">{fmtMoney(g.p10)}</td>
                  <td className="py-2 pr-3 text-indigo-600">{fmtMoney(g.mean)}</td>
                  <td className="py-2 pr-3">{fmtMoney(g.median)}</td>
                  <td className="py-2 pr-3">{fmtMoney(g.p90)}</td>
                  <td className="py-2 text-amber-600">{fmtMoney(g.max)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title={`藏品目录（图像核对）`}
        desc={`共 ${gallery.length} 件 · 有图像 ${gallery.filter((g) => g.has_image).length} 件 · 点击图片放大核对分割是否正确`}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-900 p-0.5 text-xs">
            {([["cards", "卡片"], ["table", "表格"]] as const).map(([k, label]) => (
              <button
                key={k}
                className={`rounded-md px-2 py-1 ${viewMode === k ? "bg-indigo-500/20 text-indigo-700" : "text-slate-500 hover:text-slate-700"}`}
                onClick={() => setViewMode(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            className="input w-44"
            placeholder="搜索藏品名"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="input w-28"
            value={sizeFilter}
            onChange={(e) => setSizeFilter(e.target.value === "" ? "" : Number(e.target.value))}
          >
            <option value="">全部格数</option>
            {sizes.map((s) => (
              <option key={s} value={s}>
                {s} 格
              </option>
            ))}
          </select>
          <select className="input w-36" value={sortBy} onChange={(e) => setSortBy(e.target.value as never)}>
            <option value="value_desc">价值：高 → 低</option>
            <option value="value_asc">价值：低 → 高</option>
            <option value="name">名称排序</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            <input
              type="checkbox"
              className="accent-indigo-500"
              checked={onlyNoImage}
              onChange={(e) => setOnlyNoImage(e.target.checked)}
            />
            只看无图（{gallery.filter((g) => !g.has_image).length}）
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            <input
              type="checkbox"
              className="accent-emerald-500"
              checked={onlyNeedLearn}
              onChange={(e) => setOnlyNeedLearn(e.target.checked)}
            />
            只看需学习（{needLearn.size}）
          </label>
          <div className="flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-900 p-0.5 text-xs">
            {([
              ["all", `全部 ${gallery.length}`],
              ["learned", `✓已学习 ${gallery.filter((g) => g.has_learn).length}`],
              ["not", `未学习 ${gallery.filter((g) => !g.has_learn).length}`],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                className={`rounded-md px-2 py-1 ${learnFilter === k ? "bg-indigo-500/20 text-indigo-700" : "text-slate-500 hover:text-slate-700"}`}
                onClick={() => setLearnFilter(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className="btn-ghost !py-1.5 text-xs !border-rose-500/40 text-rose-600"
            onClick={deleteLearnSelected}
            disabled={learnedChecked.length === 0}
          >
            删除选中学习样本（{learnedChecked.length}）
          </button>
          <span className="ml-auto text-xs text-slate-500">显示 {filtered.length} / {gallery.length} 件</span>
          <button
            className="btn-ghost !px-3 !py-1.5 text-xs"
            onClick={async () => {
              const r = await api.visionGallery();
              setGallery(r.items);
              setNeedLearn(new Set(r.items.filter((x) => !x.has_image).map((x) => x.cat_id)));
              load();
              setMsg("已刷新");
              setTimeout(() => setMsg(""), 2000);
            }}
          >
            ⟳ 刷新
          </button>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            className="btn-ghost !py-1.5 text-xs"
            onClick={() => setSelected(new Set(filtered.map((g) => g.cat_id)))}
          >
            全选当前筛选
          </button>
          <button
            className="btn-ghost !py-1.5 text-xs !border-amber-500/40 text-amber-700"
            onClick={() =>
              setSelected(new Set(gallery.filter((g) => g.source === "ocr").map((g) => g.cat_id)))
            }
          >
            勾选全部 OCR 新增（{gallery.filter((g) => g.source === "ocr").length}）
          </button>
          <button
            className="btn-ghost !py-1.5 text-xs"
            onClick={() => setSelected(new Set())}
            disabled={selected.size === 0}
          >
            清除选择
          </button>
          <button
            className="btn-primary !py-1.5 text-xs !bg-rose-500 !shadow-rose-500/20 hover:!bg-rose-400"
            onClick={deleteSelected}
            disabled={selected.size === 0 || deleting}
          >
            {deleting ? "删除中…" : `删除选中（${selected.size}）`}
          </button>
          <span className="text-xs text-slate-500">
            带“OCR新增”角标的是识别过程加进来的条目（不在 Excel 表格中），可勾选删除
          </span>
        </div>
        {viewMode === "cards" ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((g) => (
            <div
              key={g.id ?? g.name}
              className={`relative rounded-xl border p-2 transition ${
                selected.has(g.cat_id)
                  ? "border-rose-500/60 bg-rose-500/5"
                  : "border-ink-700/70 bg-ink-900/50 hover:border-indigo-500/40"
              }`}
            >
              <label className="absolute left-2 top-2 z-10 flex h-5 w-5 cursor-pointer items-center justify-center rounded border border-ink-600 bg-ink-900/90">
                <input
                  type="checkbox"
                  className="accent-rose-500"
                  checked={selected.has(g.cat_id)}
                  onChange={() => toggleSelect(g.cat_id)}
                />
              </label>
              {g.source === "ocr" && (
                <span className="absolute right-2 top-2 z-10 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">
                  OCR新增
                </span>
              )}
              {g.has_learn && (
                <span className="absolute left-2 top-7 z-10 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-600">
                  ✓已学
                </span>
              )}
              <label
                className="absolute bottom-2 right-2 z-10 flex cursor-pointer items-center gap-1 text-[10px] text-emerald-600"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  className="accent-emerald-500"
                  checked={needLearn.has(g.cat_id)}
                  onChange={() => toggleNeed(g.cat_id)}
                />
                需学习
              </label>
              {g.has_image && g.id !== null ? (
                <button
                  className="block w-full overflow-hidden rounded-lg border border-ink-700 bg-ink-800"
                  onClick={() => setZoom(g.image_path)}
                >
                  <img
                    src={`/api/vision/uploaded?path=${encodeURIComponent(g.image_path ?? "")}`}
                    alt={g.name}
                    className="h-28 w-full object-contain"
                    loading="lazy"
                  />
                </button>
              ) : (
                <div className="flex h-28 w-full items-center justify-center rounded-lg border border-dashed border-ink-700 bg-ink-900 text-[11px] text-slate-400">
                  暂无图像
                </div>
              )}
              <div className="mt-1.5 truncate text-xs font-medium text-slate-100" title={g.name}>
                {g.name}
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[11px] text-slate-500">
                <span>{g.grid_cells} 格</span>
                <span className="text-indigo-600 tabular-nums">{fmtMoney(g.value)}</span>
              </div>
              <div className="text-[10px] text-slate-400 tabular-nums">
                交易行 {fmtMoney(g.current_value ?? g.value * 1.15)} 含税
              </div>
              <button
                className="mt-1.5 w-full rounded-lg border border-ink-700 py-1 text-[11px] text-slate-400 hover:border-indigo-500/40 hover:text-indigo-600"
                onClick={() => setDetail(g)}
              >
                查看学习图片（{g.n_images}）
              </button>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full py-8 text-center text-sm text-slate-400">没有符合条件的藏品</div>
          )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--border-subtle)" }}>
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.05em] text-slate-500">
                  <th className="py-3 pl-4 pr-3 font-medium">藏品</th>
                  <th className="py-3 pr-3 font-medium">格数</th>
                  <th className="py-3 pr-3 text-right font-medium">图鉴价</th>
                  <th className="py-3 pr-3 text-right font-medium">交易行价(含税)</th>
                  <th className="py-3 pr-3 font-medium">学习次数</th>
                  <th className="py-3 pr-4 font-medium">对应图片</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((g, gi) => (
                  <tr
                    key={g.cat_id}
                    className={`h-12 border-t align-middle text-slate-300 ${gi % 2 === 1 ? "bg-[var(--bg-secondary)]" : ""}`}
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    <td className="pl-4 pr-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button className="font-medium text-slate-100 hover:text-indigo-400" onClick={() => setDetail(g)}>{g.name}</button>
                        {g.source === "ocr" && (
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">OCR新增</span>
                        )}
                        {g.has_learn && (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-600">✓已学</span>
                        )}
                        {g.has_manual && (
                          <span
                            className="rounded px-1.5 py-0.5 text-[10px]"
                            style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                            title="手动补录的漏检红品，视觉识别时优先匹配（多注意/加强）"
                          >
                            ✋手动
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="pr-3">
                      <span
                        className="rounded-full border px-2 py-0.5 text-xs font-medium"
                        style={{ borderColor: "var(--border-accent)", color: "var(--text-secondary)" }}
                      >
                        {g.grid_cells} 格
                      </span>
                    </td>
                    <td className="pr-3 text-right font-mono">{fmtMoney(g.value)}</td>
                    <td className="pr-3 text-right font-mono" style={{ color: "var(--accent)" }}>
                      {fmtMoney(g.current_value ?? g.value * 1.15)}
                    </td>
                    <td className="pr-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs tabular-nums ${
                          g.has_image ? "bg-indigo-500/15 text-indigo-600" : "bg-slate-500/15 text-slate-500"
                        }`}
                      >
                        {g.n_images} 张
                      </span>
                    </td>
                    <td className="pr-4">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {(g.images && g.images.length > 0
                          ? g.images
                          : g.image_path
                            ? [{ id: g.id ?? -1, path: g.image_path }]
                            : []
                        )
                          .slice(0, 8)
                          .map((img, i) => (
                            <button
                              key={i}
                              className="overflow-hidden rounded-md border border-ink-700 bg-ink-900"
                              onClick={() => setZoom(img.path)}
                              title="点击放大"
                            >
                              <img
                                src={`/api/vision/uploaded?path=${encodeURIComponent(img.path)}`}
                                alt={g.name}
                                className="h-10 w-10 object-contain"
                                loading="lazy"
                                onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                              />
                            </button>
                          ))}
                        {!g.has_image && <span className="text-[11px] text-slate-400">暂无图片</span>}
                        {g.n_images > 8 && <span className="text-[11px] text-slate-500">+{g.n_images - 8} 张</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="py-8 text-center text-sm text-slate-400">没有符合条件的藏品</div>
            )}
          </div>
        )}
      </Card>

      {detail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
          onClick={() => {
            setDetail(null);
            setDetailSel(new Set());
          }}
        >
          <div
            className="max-h-full w-full max-w-3xl overflow-auto rounded-2xl border border-ink-700 bg-ink-900 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-base font-semibold text-slate-200">{detail.name}</div>
                <div className="text-xs text-slate-500">
                  {detail.grid_cells} 格 · 共 {detail.images?.length ?? 0} 张图片 · 滚轮滑动浏览 · 点击图片即勾选
                </div>
              </div>
              <button
                className="rounded-full bg-ink-800 px-3 py-1.5 text-sm text-slate-400"
                onClick={() => {
                  setDetail(null);
                  setDetailSel(new Set());
                }}
              >
                ✕ 关闭
              </button>
            </div>
            <div className="max-h-[62vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {(detail.images ?? []).map((img) => (
                <div
                  key={img.path}
                  onClick={() =>
                    setDetailSel((prev) => {
                      const n = new Set(prev);
                      if (n.has(img.path)) n.delete(img.path);
                      else n.add(img.path);
                      return n;
                    })
                  }
                  className={`relative cursor-pointer select-none rounded-xl border p-1.5 transition hover:border-indigo-500/50 ${
                    detailSel.has(img.path)
                      ? "border-rose-500/60 bg-rose-500/5"
                      : "border-ink-700/70 bg-ink-900/50"
                  }`}
                >
                  <div className="absolute left-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded border border-ink-600 bg-ink-900/90">
                    {detailSel.has(img.path) ? (
                      <span className="text-[13px] leading-none text-rose-500">✓</span>
                    ) : null}
                  </div>
                  <div className="absolute right-1.5 top-1.5 z-10 flex max-w-[72%] flex-wrap justify-end gap-1">
                    {img.source === "learn" && (
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-600">
                        学习
                      </span>
                    )}
                    {img.variant && (
                      <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-600">
                        变体
                      </span>
                    )}
                  </div>
                  <img
                    src={`/api/vision/uploaded?path=${encodeURIComponent(img.path)}`}
                    alt=""
                    className={`h-24 w-full rounded-lg border border-ink-700 object-contain bg-ink-950 ${imgMissing.has(img.path) ? "invisible" : ""}`}
                    loading="lazy"
                    onError={() => setImgMissing((prev) => new Set(prev).add(img.path))}
                  />
                  {imgMissing.has(img.path) && (
                    <div className="absolute inset-x-0 bottom-0 top-0 flex items-center justify-center rounded-lg bg-ink-950 text-[11px] text-slate-500">
                      图片缺失
                    </div>
                  )}
                </div>
              ))}
              {(detail.images ?? []).length === 0 && (
                <div className="col-span-full py-8 text-center text-sm text-slate-400">该藏品暂无图片</div>
              )}
            </div>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-slate-500">已选 {detailSel.size} 张</span>
              <div className="flex gap-2">
                <button
                  className="btn-ghost !py-2 text-xs"
                  onClick={() => setDetailSel(new Set(detail.images?.map((i) => i.path) ?? []))}
                >
                  全选
                </button>
                <button
                  className="btn-primary !py-2 text-xs !bg-rose-500 !shadow-rose-500/20 hover:!bg-rose-400"
                  onClick={deleteDetailSelected}
                  disabled={detailSel.size === 0 || detailBusy}
                >
                  {detailBusy ? "删除中…" : `删除选中（${detailSel.size}）`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {zoom !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
          onClick={() => setZoom(null)}
        >
          <img
            src={`/api/vision/uploaded?path=${encodeURIComponent(zoom)}`}
            alt=""
            className="max-h-full max-w-full rounded-xl shadow-2xl"
          />
          <button
            className="absolute right-5 top-5 rounded-full bg-ink-800 px-3 py-1.5 text-sm text-slate-800"
            onClick={() => setZoom(null)}
          >
            ✕ 关闭
          </button>
        </div>
      )}
    </div>
  );
}
