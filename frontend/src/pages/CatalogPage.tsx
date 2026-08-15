import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { Card } from "../components/Card";
import Chart from "../components/Chart";
import { CHART } from "../theme/chartTokens";
import type { CatalogResp, VisionItem } from "../types";
import { fmtMoney } from "../utils";

/* ── 格数分布概览条 ── */
function GridDistBar({ grids }: { grids: CatalogResp["grids"] }) {
  const maxCount = Math.max(...grids.map((g) => g.count), 1);
  return (
    <div className="space-y-2.5">
      {grids.map((g) => {
        const widthPct = Math.max((g.count / maxCount) * 100, 8);
        return (
          <div key={g.grid_cells} className="flex items-center gap-3">
            <span
              className="w-12 shrink-0 text-xs font-medium"
              style={{ color: "var(--text-secondary)" }}
            >
              {g.grid_cells} 格
            </span>
            <div
              className="relative h-7 flex-1 overflow-hidden rounded-md"
              style={{ background: "var(--bg-input)" }}
            >
              <div
                className="flex h-full items-center justify-end rounded-md pr-2 transition-all"
                style={{
                  width: `${widthPct}%`,
                  minWidth: "36px",
                  background:
                    "linear-gradient(90deg, rgba(201,169,98,0.15), var(--gold-500))",
                }}
              >
                <span
                  className="text-xs font-semibold tabular-nums"
                  style={{ color: "var(--text-inverse)" }}
                >
                  {g.count}
                </span>
              </div>
            </div>
            <span
              className="w-24 shrink-0 text-right text-xs tabular-nums"
              style={{ color: "var(--gold-400)" }}
            >
              均 {fmtMoney(g.mean)}
            </span>
            <span
              className="hidden w-24 shrink-0 text-right text-xs tabular-nums sm:block"
              style={{ color: "var(--text-tertiary)" }}
            >
              中位 {fmtMoney(g.median)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── 空状态 ── */
function EmptyState({ onImport }: { onImport: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div
        className="mb-4 flex h-16 w-16 items-center justify-center rounded-full"
        style={{ background: "var(--gold-soft)" }}
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--gold-400)" strokeWidth="1.5">
          <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2M4 7h16M4 7l1 13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1l1-13M9 11v6M15 11v6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <p className="mb-1 text-sm font-medium" style={{ color: "var(--text-primary)" }}>
        图鉴为空
      </p>
      <p className="mb-4 text-xs" style={{ color: "var(--text-tertiary)" }}>
        导入对局数据后图鉴将自动填充
      </p>
      <button className="btn-primary !h-9 !px-4 text-xs" onClick={onImport}>
        重新导入 Excel
      </button>
    </div>
  );
}

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

  // 每次打开/切换/关闭「查看学习图片」弹窗时，清空上一次的图片缺失标记。
  // 否则 imgMissing 一旦因旧后端/懒加载 quirk 被写入，会一直残留并让图片 invisible（黑屏）。
  useEffect(() => {
    setImgMissing(new Set());
  }, [detail]);

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
      tooltip: {
        trigger: "axis",
        backgroundColor: CHART.tooltipBg,
        borderColor: CHART.border,
        textStyle: { color: CHART.textPrimary, fontSize: 12 },
      },
      legend: { textStyle: { color: CHART.textSecondary }, top: 0 },
      grid: { left: 56, right: 20, top: 34, bottom: 30 },
      xAxis: {
        type: "category",
        data: cat.grids.map((g) => g.grid_cells + " 格"),
        axisLabel: { color: CHART.textSecondary },
        axisLine: { lineStyle: { color: CHART.border } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: CHART.textSecondary, formatter: (v: number) => (v / 10000).toFixed(0) + "万" },
        splitLine: { lineStyle: { color: CHART.gridLine } },
        axisLine: { lineStyle: { color: CHART.border } },
      },
      series: [
        {
          name: "均值",
          type: "bar",
          data: cat.grids.map((g) => g.mean),
          itemStyle: { color: CHART.goldDim, borderRadius: [5, 5, 0, 0] },
        },
        {
          name: "中位数",
          type: "bar",
          data: cat.grids.map((g) => g.median),
          itemStyle: { color: CHART.jade500, borderRadius: [5, 5, 0, 0] },
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
              shape: { x1: low[0], y1: low[1], x2: high[0], y2: high[1] },
              style: { stroke: CHART.amber, lineWidth: 4 },
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

  const isEmpty = gallery.length === 0 && !cat;

  /* ── 复用样式 ── */
  const toggleBtnBase: React.CSSProperties = {
    borderRadius: "var(--radius-md)",
    padding: "4px 10px",
    fontSize: "12px",
    transition: "all var(--dur-fast) var(--ease-out)",
    cursor: "pointer",
    border: "none",
  };

  return (
    <div className="space-y-5">
      {msg && (
        <div
          className="rounded-xl px-4 py-2.5 text-sm"
          style={{
            border: "1px solid rgba(201,169,98,0.3)",
            background: "var(--gold-soft)",
            color: "var(--gold-400)",
          }}
        >
          {msg}
        </div>
      )}

      {/* 删除确认弹窗 */}
      {confirmDel && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6">
          <div
            className="w-full max-w-sm rounded-2xl p-5"
            style={{
              border: "1px solid var(--border-default)",
              background: "var(--bg-surface)",
              boxShadow: "var(--shadow-xl)",
            }}
          >
            <div className="mb-2 text-base font-semibold" style={{ color: "var(--text-primary)" }}>
              {confirmDel.kind === "detail" ? "删除学习图片" : "删除藏品"}
            </div>
            <p className="mb-5 text-sm" style={{ color: "var(--text-secondary)" }}>
              确定删除选中的{" "}
              <span className="font-semibold" style={{ color: "var(--vermilion-400)" }}>
                {confirmDel.count}
              </span>{" "}
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
                className="btn-danger !py-2 text-sm"
                onClick={confirmExec}
                disabled={deleting || detailBusy}
              >
                {deleting || detailBusy ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 统计卡片 */}
      <Card
        title={`红色图鉴（${cat?.total ?? "—"} 件）`}
        desc="权威价格表来自你提供的 Excel；估值引擎会与 31 局实测单价融合"
        right={
          <button className="btn-ghost !py-2 text-xs" onClick={importXlsx}>
            重新导入 Excel
          </button>
        }
      >
        <Chart option={chartOption} height={300} ariaLabel="柱状图：红色藏品按格数的价值分布" />
      </Card>

      {/* 格数分布概览条 */}
      {cat && cat.grids.length > 0 && (
        <Card title="格数分布概览" desc="按格数分组：数量 / 均值 / 中位数">
          <GridDistBar grids={cat.grids} />
        </Card>
      )}

      {/* 明细统计表 */}
      <Card title="按格数统计" desc="单件价值（金币）">
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums" aria-label="藏品图鉴列表：名称、格数、价值、出现次数">
            <thead>
              <tr className="text-left text-xs" style={{ color: "var(--text-tertiary)" }}>
                <th className="py-2 pr-3 font-medium">格数</th>
                <th className="py-2 pr-3 font-medium">数量</th>
                <th className="py-2 pr-3 font-medium">最低</th>
                <th className="py-2 pr-3 font-medium">p10</th>
                <th className="py-2 pr-3 font-medium">均值</th>
                <th className="py-2 pr-3 font-medium">中位</th>
                <th className="py-2 pr-3 font-medium">p90</th>
                <th className="py-2 font-medium">最高</th>
              </tr>
            </thead>
            <tbody>
              {cat?.grids.map((g) => (
                <tr
                  key={g.grid_cells}
                  className="border-t"
                  style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
                >
                  <td className="py-2 pr-3 font-semibold" style={{ color: "var(--text-primary)" }}>
                    {g.grid_cells} 格
                  </td>
                  <td className="py-2 pr-3">{g.count}</td>
                  <td className="py-2 pr-3" style={{ color: "var(--text-tertiary)" }}>{fmtMoney(g.min)}</td>
                  <td className="py-2 pr-3">{fmtMoney(g.p10)}</td>
                  <td className="py-2 pr-3" style={{ color: "var(--gold-400)" }}>{fmtMoney(g.mean)}</td>
                  <td className="py-2 pr-3">{fmtMoney(g.median)}</td>
                  <td className="py-2 pr-3">{fmtMoney(g.p90)}</td>
                  <td className="py-2" style={{ color: "var(--amber-400)" }}>{fmtMoney(g.max)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* 藏品目录 */}
      <Card
        title={`藏品目录（图像核对）`}
        desc={`共 ${gallery.length} 件 · 有图像 ${gallery.filter((g) => g.has_image).length} 件 · 点击图片放大核对分割是否正确`}
      >
        {isEmpty ? (
          <EmptyState onImport={importXlsx} />
        ) : (
          <>
            {/* 工具栏 */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {/* 视图切换 */}
              <div
                className="flex items-center gap-0.5 rounded-lg p-0.5"
                style={{ border: "1px solid var(--border-subtle)", background: "var(--bg-input)" }}
              >
                {([["table", "表格"], ["cards", "画廊"]] as const).map(([k, label]) => (
                  <button
                    key={k}
                    style={{
                      ...toggleBtnBase,
                      background: viewMode === k ? "var(--gold-soft)" : "transparent",
                      color: viewMode === k ? "var(--gold-400)" : "var(--text-tertiary)",
                      fontWeight: viewMode === k ? 600 : 400,
                    }}
                    onClick={() => setViewMode(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* 搜索 */}
              <input
                className="input w-44"
                placeholder="搜索藏品名"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />

              {/* 格数筛选 */}
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

              {/* 排序 */}
              <select className="input w-36" value={sortBy} onChange={(e) => setSortBy(e.target.value as never)}>
                <option value="value_desc">价值：高 → 低</option>
                <option value="value_asc">价值：低 → 高</option>
                <option value="name">名称排序</option>
              </select>

              {/* 复选框筛选 */}
              <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-tertiary)" }}>
                <input
                  type="checkbox"
                  style={{ accentColor: "var(--gold-400)" }}
                  checked={onlyNoImage}
                  onChange={(e) => setOnlyNoImage(e.target.checked)}
                />
                只看无图（{gallery.filter((g) => !g.has_image).length}）
              </label>
              <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-tertiary)" }}>
                <input
                  type="checkbox"
                  style={{ accentColor: "var(--jade-400)" }}
                  checked={onlyNeedLearn}
                  onChange={(e) => setOnlyNeedLearn(e.target.checked)}
                />
                只看需学习（{needLearn.size}）
              </label>

              {/* 学习状态筛选 */}
              <div
                className="flex items-center gap-0.5 rounded-lg p-0.5"
                style={{ border: "1px solid var(--border-subtle)", background: "var(--bg-input)" }}
              >
                {([
                  ["all", `全部 ${gallery.length}`],
                  ["learned", `✓已学习 ${gallery.filter((g) => g.has_learn).length}`],
                  ["not", `未学习 ${gallery.filter((g) => !g.has_learn).length}`],
                ] as const).map(([k, label]) => (
                  <button
                    key={k}
                    style={{
                      ...toggleBtnBase,
                      background: learnFilter === k ? "var(--gold-soft)" : "transparent",
                      color: learnFilter === k ? "var(--gold-400)" : "var(--text-tertiary)",
                      fontWeight: learnFilter === k ? 600 : 400,
                    }}
                    onClick={() => setLearnFilter(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <button
                className="btn-ghost !py-1.5 text-xs"
                style={{ borderColor: "rgba(196,74,74,0.4)", color: "var(--vermilion-400)" }}
                onClick={deleteLearnSelected}
                disabled={learnedChecked.length === 0}
              >
                删除选中学习样本（{learnedChecked.length}）
              </button>

              <span className="ml-auto text-xs" style={{ color: "var(--text-tertiary)" }}>
                显示 {filtered.length} / {gallery.length} 件
              </span>

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

            {/* 批量操作 */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button
                className="btn-ghost !py-1.5 text-xs"
                onClick={() => setSelected(new Set(filtered.map((g) => g.cat_id)))}
              >
                全选当前筛选
              </button>
              <button
                className="btn-ghost !py-1.5 text-xs"
                style={{ borderColor: "rgba(201,154,62,0.4)", color: "var(--amber-400)" }}
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
                className="btn-danger !py-1.5 text-xs"
                onClick={deleteSelected}
                disabled={selected.size === 0 || deleting}
              >
                {deleting ? "删除中…" : `删除选中（${selected.size}）`}
              </button>
              <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                带"OCR新增"角标的是识别过程加进来的条目（不在 Excel 表格中），可勾选删除
              </span>
            </div>

            {/* 画廊视图 */}
            {viewMode === "cards" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {filtered.map((g) => (
                  <div
                    key={g.id ?? g.name}
                    className="relative rounded-xl border p-2 transition"
                    style={{
                      borderColor: selected.has(g.cat_id)
                        ? "rgba(196,74,74,0.6)"
                        : "var(--border-subtle)",
                      background: selected.has(g.cat_id)
                        ? "var(--vermilion-soft)"
                        : "var(--bg-input)",
                    }}
                  >
                    {/* 选择框 */}
                    <label
                      className="absolute left-2 top-2 z-10 flex h-5 w-5 cursor-pointer items-center justify-center rounded"
                      style={{ border: "1px solid var(--border-default)", background: "var(--bg-surface)" }}
                    >
                      <input
                        type="checkbox"
                        style={{ accentColor: "var(--vermilion-400)" }}
                        checked={selected.has(g.cat_id)}
                        onChange={() => toggleSelect(g.cat_id)}
                      />
                    </label>

                    {/* 角标 */}
                    {g.source === "ocr" && (
                      <span
                        className="absolute right-2 top-2 z-10 rounded px-1.5 py-0.5 text-[10px]"
                        style={{ background: "var(--amber-soft)", color: "var(--amber-400)" }}
                      >
                        OCR新增
                      </span>
                    )}
                    {g.has_learn && (
                      <span
                        className="absolute left-2 top-7 z-10 rounded px-1.5 py-0.5 text-[10px]"
                        style={{ background: "var(--jade-soft)", color: "var(--jade-400)" }}
                      >
                        ✓已学
                      </span>
                    )}
                    {g.has_manual && (
                      <span
                        className="absolute right-2 top-7 z-10 rounded px-1.5 py-0.5 text-[10px]"
                        style={{ background: "var(--gold-soft)", color: "var(--gold-400)" }}
                      >
                        ✋手动
                      </span>
                    )}

                    {/* 需学习勾选 */}
                    <label
                      className="absolute bottom-2 right-2 z-10 flex cursor-pointer items-center gap-1 text-[10px]"
                      style={{ color: "var(--jade-400)" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        style={{ accentColor: "var(--jade-400)" }}
                        checked={needLearn.has(g.cat_id)}
                        onChange={() => toggleNeed(g.cat_id)}
                      />
                      需学习
                    </label>

                    {/* 图片 */}
                    {g.has_image && g.id !== null ? (
                      <button
                        className="block w-full overflow-hidden rounded-lg"
                        style={{ border: "1px solid var(--border-subtle)", background: "var(--bg-elevated)" }}
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
                      <div
                        className="flex h-28 w-full items-center justify-center rounded-lg text-[11px]"
                        style={{
                          border: `1px dashed var(--border-default)`,
                          background: "var(--bg-surface)",
                          color: "var(--text-tertiary)",
                        }}
                      >
                        暂无图像
                      </div>
                    )}

                    {/* 名称 */}
                    <div
                      className="mt-1.5 truncate text-xs font-medium"
                      style={{ color: "var(--text-primary)" }}
                      title={g.name}
                    >
                      {g.name}
                    </div>

                    {/* 格数 + 价值 */}
                    <div
                      className="mt-0.5 flex items-center justify-between text-[11px]"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      <span>{g.grid_cells} 格</span>
                      <span className="tabular-nums" style={{ color: "var(--gold-400)" }}>
                        {fmtMoney(g.value)}
                      </span>
                    </div>

                    {/* 交易行价 */}
                    <div className="text-[10px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
                      交易行 {fmtMoney(g.current_value ?? g.value * 1.15)} 含税
                    </div>

                    {/* 学习图片按钮 */}
                    <button
                      className="mt-1.5 w-full rounded-lg py-1 text-[11px] transition"
                      style={{
                        border: "1px solid var(--border-subtle)",
                        color: "var(--text-tertiary)",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = "rgba(201,169,98,0.4)";
                        e.currentTarget.style.color = "var(--gold-400)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "var(--border-subtle)";
                        e.currentTarget.style.color = "var(--text-tertiary)";
                      }}
                      onClick={() => setDetail(g)}
                    >
                      查看学习图片（{g.n_images}）
                    </button>
                  </div>
                ))}
                {filtered.length === 0 && (
                  <div
                    className="col-span-full py-8 text-center text-sm"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    没有符合条件的藏品
                  </div>
                )}
              </div>
            ) : (
              /* 表格视图 */
              <div
                className="overflow-x-auto rounded-lg"
                style={{ border: "1px solid var(--border-subtle)" }}
              >
                <table className="w-full text-sm tabular-nums" aria-label="藏品图鉴列表：名称、格数、价值、出现次数">
                  <thead>
                    <tr
                      className="text-left text-[11px] uppercase tracking-[0.05em]"
                      style={{ color: "var(--text-tertiary)" }}
                    >
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
                        className="h-12 border-t align-middle"
                        style={{
                          borderColor: "var(--border-subtle)",
                          color: "var(--text-secondary)",
                          background: gi % 2 === 1 ? "var(--bg-input)" : "transparent",
                        }}
                      >
                        <td className="pl-4 pr-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              className="font-medium transition"
                              style={{ color: "var(--text-primary)" }}
                              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gold-400)")}
                              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
                              onClick={() => setDetail(g)}
                            >
                              {g.name}
                            </button>
                            {g.source === "ocr" && (
                              <span
                                className="rounded px-1.5 py-0.5 text-[10px]"
                                style={{ background: "var(--amber-soft)", color: "var(--amber-400)" }}
                              >
                                OCR新增
                              </span>
                            )}
                            {g.has_learn && (
                              <span
                                className="rounded px-1.5 py-0.5 text-[10px]"
                                style={{ background: "var(--jade-soft)", color: "var(--jade-400)" }}
                              >
                                ✓已学
                              </span>
                            )}
                            {g.has_manual && (
                              <span
                                className="rounded px-1.5 py-0.5 text-[10px]"
                                style={{ background: "var(--gold-soft)", color: "var(--gold-400)" }}
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
                            style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
                          >
                            {g.grid_cells} 格
                          </span>
                        </td>
                        <td className="pr-3 text-right font-mono">{fmtMoney(g.value)}</td>
                        <td className="pr-3 text-right font-mono" style={{ color: "var(--gold-400)" }}>
                          {fmtMoney(g.current_value ?? g.value * 1.15)}
                        </td>
                        <td className="pr-3">
                          <span
                            className="rounded-full px-2 py-0.5 text-xs tabular-nums"
                            style={
                              g.has_image
                                ? { background: "var(--gold-soft)", color: "var(--gold-400)" }
                                : { background: "var(--bg-input)", color: "var(--text-tertiary)" }
                            }
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
                                  className="overflow-hidden rounded-md"
                                  style={{
                                    border: "1px solid var(--border-subtle)",
                                    background: "var(--bg-surface)",
                                  }}
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
                            {!g.has_image && (
                              <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                                暂无图片
                              </span>
                            )}
                            {g.n_images > 8 && (
                              <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                                +{g.n_images - 8} 张
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filtered.length === 0 && (
                  <div
                    className="py-8 text-center text-sm"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    没有符合条件的藏品
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Card>

      {/* 学习图片详情弹窗 */}
      {detail && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
          onClick={() => {
            setDetail(null);
            setDetailSel(new Set());
          }}
        >
          <div
            className="max-h-full w-full max-w-3xl overflow-auto rounded-2xl p-5"
            style={{
              border: "1px solid var(--border-default)",
              background: "var(--bg-surface)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
                  {detail.name}
                </div>
                <div className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {detail.grid_cells} 格 · 共 {detail.images?.length ?? 0} 张图片 · 滚轮滑动浏览 · 点击图片即勾选
                </div>
              </div>
              <button
                className="rounded-full px-3 py-1.5 text-sm transition"
                style={{ background: "var(--bg-input)", color: "var(--text-tertiary)" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-tertiary)")}
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
                    className="relative cursor-pointer select-none rounded-xl border p-1.5 transition"
                    style={{
                      borderColor: detailSel.has(img.path)
                        ? "rgba(196,74,74,0.6)"
                        : "var(--border-subtle)",
                      background: detailSel.has(img.path)
                        ? "var(--vermilion-soft)"
                        : "var(--bg-input)",
                    }}
                  >
                    {/* 选择框 */}
                    <div
                      className="absolute left-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded"
                      style={{ border: "1px solid var(--border-default)", background: "var(--bg-surface)" }}
                    >
                      {detailSel.has(img.path) ? (
                        <span className="text-[13px] leading-none" style={{ color: "var(--vermilion-400)" }}>
                          ✓
                        </span>
                      ) : null}
                    </div>

                    {/* 角标 */}
                    <div className="absolute right-1.5 top-1.5 z-10 flex max-w-[72%] flex-wrap justify-end gap-1">
                      {img.source === "learn" && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px]"
                          style={{ background: "var(--jade-soft)", color: "var(--jade-400)" }}
                        >
                          学习
                        </span>
                      )}
                      {img.variant && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px]"
                          style={{ background: "var(--gold-soft)", color: "var(--gold-400)" }}
                        >
                          变体
                        </span>
                      )}
                    </div>

                    {/* 图片 */}
                    <img
                      src={`/api/vision/uploaded?path=${encodeURIComponent(img.path)}`}
                      alt=""
                      className={`h-24 w-full rounded-lg border object-contain ${imgMissing.has(img.path) ? "invisible" : ""}`}
                      style={{
                        borderColor: "var(--border-subtle)",
                        background: "var(--bg-canvas)",
                      }}
                      onError={() => setImgMissing((prev) => new Set(prev).add(img.path))}
                    />
                    {imgMissing.has(img.path) && (
                      <div
                        className="absolute inset-x-0 bottom-0 top-0 flex items-center justify-center rounded-lg text-[11px]"
                        style={{ background: "var(--bg-canvas)", color: "var(--text-tertiary)" }}
                      >
                        图片缺失
                      </div>
                    )}
                  </div>
                ))}
                {(detail.images ?? []).length === 0 && (
                  <div
                    className="col-span-full py-8 text-center text-sm"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    该藏品暂无图片
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                已选 {detailSel.size} 张
              </span>
              <div className="flex gap-2">
                <button
                  className="btn-ghost !py-2 text-xs"
                  onClick={() => setDetailSel(new Set(detail.images?.map((i) => i.path) ?? []))}
                >
                  全选
                </button>
                <button
                  className="btn-danger !py-2 text-xs"
                  onClick={deleteDetailSelected}
                  disabled={detailSel.size === 0 || detailBusy}
                >
                  {detailBusy ? "删除中…" : `删除选中（${detailSel.size}）`}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 图片放大 */}
      {zoom !== null && createPortal(
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
            className="absolute right-5 top-5 rounded-full px-3 py-1.5 text-sm transition"
            style={{ background: "var(--bg-input)", color: "var(--text-secondary)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
            onClick={() => setZoom(null)}
          >
            ✕ 关闭
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}
