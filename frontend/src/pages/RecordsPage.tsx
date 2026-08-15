import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Badge, Card } from "../components/Card";
import Chart from "../components/Chart";
import { CHART } from "../theme/chartTokens";
import type { GameRecord, UserRecord } from "../types";
import { fmtMoney, fmtWan } from "../utils";

/* ── Error-based scatter color ── */
function errorColor(pred: number, actual: number): string {
  if (actual === 0) return CHART.textTertiary;
  const err = Math.abs(pred - actual) / actual;
  if (err < 0.15) return CHART.jade;
  if (err < 0.30) return CHART.amber;
  return CHART.vermilion;
}

export default function RecordsPage() {
  const [games, setGames] = useState<GameRecord[]>([]);
  const [records, setRecords] = useState<UserRecord[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [sortBy, setSortBy] = useState<"game_no" | "profit_desc" | "profit_asc" | "avg_desc" | "avg_asc">("game_no");
  const [profitFilter, setProfitFilter] = useState<"all" | "pos" | "neg">("all");
  const [wonFilter, setWonFilter] = useState<"all" | "won" | "not">("all");
  const [editGame, setEditGame] = useState<number | null>(null);
  const [gameForm, setGameForm] = useState<{ total_value: string; deal_price: string; profit: string }>({
    total_value: "",
    deal_price: "",
    profit: "",
  });
  const [delConfirm, setDelConfirm] = useState<number | null>(null);
  const [editItemsOpen, setEditItemsOpen] = useState<number | null>(null);
  const [editItems, setEditItems] = useState<{ name: string; grid_cells: number; value: number }[]>([]);
  const [accuracy, setAccuracy] = useState<{ game_no: number; red_avg: number; item: string; pred: number; actual: number; ratio: number }[]>([]);
  const [accLoading, setAccLoading] = useState(false);

  useEffect(() => {
    setAccLoading(true);
    api.gameAccuracy()
      .then((r) => setAccuracy(r.accuracy))
      .catch(() => {})
      .finally(() => setAccLoading(false));
  }, []);

  /* ── Filtered + sorted games ── */
  const filteredGames = useMemo(() => {
    let arr = games.filter((g) => {
      if (profitFilter === "pos" && (g.profit === null || g.profit < 0)) return false;
      if (profitFilter === "neg" && (g.profit === null || g.profit >= 0)) return false;
      if (wonFilter === "won" && g.won !== 1) return false;
      if (wonFilter === "not" && g.won === 1) return false;
      return true;
    });
    arr = [...arr];
    if (sortBy === "profit_desc") arr.sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0));
    else if (sortBy === "profit_asc") arr.sort((a, b) => (a.profit ?? 0) - (b.profit ?? 0));
    else if (sortBy === "avg_desc") arr.sort((a, b) => b.red_avg - a.red_avg);
    else if (sortBy === "avg_asc") arr.sort((a, b) => a.red_avg - b.red_avg);
    else arr.sort((a, b) => a.game_no - b.game_no);
    return arr;
  }, [games, sortBy, profitFilter, wonFilter]);

  const load = useCallback(async () => {
    const [g, r] = await Promise.all([api.games(), api.records()]);
    setGames(g.games);
    setRecords(r.records);
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const settle = async (id: string) => {
    const num = (s?: string) => {
      const n = parseFloat(s ?? "");
      return Number.isNaN(n) ? null : n;
    };
    await api.updateRecord(id, {
      status: "completed",
      actual: {
        red_value: num(form.red_value),
        full_value: num(form.full_value),
        red_count: num(form.red_count),
        red_avg: num(form.red_avg),
        deal_price: num(form.deal_price),
      },
      note: form.note || undefined,
    });
    setEditing(null);
    setForm({});
    setMsg("已结算，模型正在后台自动重训…");
    setTimeout(() => setMsg(""), 4000);
    load();
  };

  const toggleWon = async (g: GameRecord) => {
    const next = g.won === 1 ? 0 : 1;
    await api.updateGameWon(g.game_no, next === 1);
    await load();
  };

  const startEditGame = (g: GameRecord) => {
    setEditGame(g.game_no);
    setOpen(g.game_no);
    setGameForm({
      total_value: g.full_value != null ? String(g.full_value) : "",
      deal_price: g.deal_price != null ? String(g.deal_price) : "",
      profit: g.profit != null ? String(g.profit) : "",
    });
  };

  const gameFormField = (k: "total_value" | "deal_price" | "profit", v: string) => {
    setGameForm((prev) => {
      const f = { ...prev, [k]: v };
      if (k !== "profit") {
        const tv = f.total_value === "" ? null : Number(f.total_value) || 0;
        const dp = f.deal_price === "" ? null : Number(f.deal_price) || 0;
        f.profit = tv != null && dp != null ? String(tv - dp) : "";
      }
      return f;
    });
  };

  const saveGameEdit = async (g: GameRecord) => {
    const num = (s: string) => (s === "" ? null : Number(s) || 0);
    await api.updateGamePrices(g.game_no, {
      total_value: num(gameForm.total_value),
      deal_price: num(gameForm.deal_price),
      profit: num(gameForm.profit),
    });
    setEditGame(null);
    setMsg("已保存，收益已重新核验");
    setTimeout(() => setMsg(""), 3000);
    await load();
  };

  const removeGame = async (g: GameRecord) => {
    await api.deleteGame(g.game_no);
    setDelConfirm(null);
    setOpen(null);
    setMsg(`已删除局 ${g.game_no}，剩余对局已重新连续编号`);
    setTimeout(() => setMsg(""), 4000);
    await load();
  };

  /* ── Red item CRUD ── */
  const startEditItems = (g: GameRecord) => {
    setEditItemsOpen(g.game_no);
    setOpen(g.game_no);
    setEditItems(
      (g.items ?? []).map((it) => ({
        name: it.name,
        grid_cells: it.grid_cells,
        value: it.trade_price ?? it.sys_price ?? 0,
      })),
    );
  };
  const setItemField = (i: number, k: "name" | "grid_cells" | "value", v: string) => {
    setEditItems((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [k]: k === "name" ? v : Number(v) || 0 };
      return next;
    });
  };
  const addItemRow = () => setEditItems((p) => [...p, { name: "", grid_cells: 1, value: 0 }]);
  const removeItemRow = (i: number) => setEditItems((p) => p.filter((_, j) => j !== i));
  const saveItems = async (g: GameRecord) => {
    await api.updateGameItems(g.game_no, { items: editItems });
    setEditItemsOpen(null);
    setMsg(`红品已更新（${editItems.length} 件），汇总字段已重算`);
    setTimeout(() => setMsg(""), 3000);
    await load();
  };

  /* ════════════════════════════════════════════════════════════
     Enhanced Prediction vs Actual Scatter Chart
     ════════════════════════════════════════════════════════════ */
  const scatterOption = useMemo(() => {
    // 数据源：历史对局的「预测 vs 实际」回测（/api/games/accuracy）。
    // 注意：散点图不再读 user_records（估算会话记录）——本项目实战数据都在
    // game_records 里，user_records 通常为空，会导致图表永远不显示。
    const pts = (accuracy || []).filter((a) => a.pred > 0 && a.actual > 0);
    if (pts.length === 0) return null;

    // Dynamic axis range
    const allVals = pts.flatMap((a) => [a.pred, a.actual]);
    const maxVal = Math.max(...allVals) * 1.1;
    const minVal = Math.min(...allVals, 0);

    return {
      tooltip: {
        trigger: "item",
        backgroundColor: CHART.bgSurface,
        borderColor: CHART.border,
        textStyle: { color: CHART.textSecondary, fontFamily: "JetBrains Mono, monospace", fontSize: 12 },
        formatter: (p: any) => {
          const a = pts[p.dataIndex];
          const pred = a.pred;
          const actual = a.actual;
          const err = actual > 0 ? Math.abs(pred - actual) / actual * 100 : 0;
          const errColor = err < 15 ? CHART.jade : err < 30 ? CHART.amber : CHART.vermilion;
          return `<div style="font-family:JetBrains Mono,monospace">
            <span style="color:${CHART.goldLight}">对局 #${a.game_no ?? "—"}</span><br/>
            <span style="color:${CHART.textSecondary}">预测: </span><span style="color:${CHART.goldDim}">¥${fmtWan(pred)}</span><br/>
            <span style="color:${CHART.textSecondary}">实际: </span><span style="color:${CHART.goldLight}">¥${fmtWan(actual)}</span><br/>
            <span style="color:${CHART.textSecondary}">误差: </span><span style="color:${errColor}">${err.toFixed(1)}%</span>
          </div>`;
        },
      },
      grid: { left: 64, right: 24, top: 20, bottom: 44 },
      xAxis: {
        type: "value",
        name: "预测值",
        nameTextStyle: { color: CHART.textTertiary, fontSize: 11 },
        min: minVal,
        max: maxVal,
        axisLabel: { color: CHART.textTertiary, formatter: (v: number) => fmtWan(v) },
        axisLine: { lineStyle: { color: CHART.border } },
        splitLine: { lineStyle: { color: CHART.gridLine } },
      },
      yAxis: {
        type: "value",
        name: "实际值",
        nameTextStyle: { color: CHART.textTertiary, fontSize: 11 },
        min: minVal,
        max: maxVal,
        axisLabel: { color: CHART.textTertiary, formatter: (v: number) => fmtWan(v) },
        axisLine: { lineStyle: { color: CHART.border } },
        splitLine: { lineStyle: { color: CHART.gridLine } },
      },
      series: [
        // y=x reference line
        {
          type: "line",
          data: [[minVal, minVal], [maxVal, maxVal]],
          lineStyle: { color: CHART.borderDef, type: "dashed", width: 1.5 },
          symbol: "none",
          silent: true,
          z: 1,
        },
        // Scatter points — color by error
        {
          type: "scatter",
          symbolSize: 11,
          data: pts.map((a) => [a.pred, a.actual]),
          itemStyle: {
            color: (params: any) => {
              const a = pts[params.dataIndex];
              return errorColor(a.pred, a.actual);
            },
            opacity: 0.85,
            shadowBlur: 4,
            shadowColor: "rgba(0,0,0,0.3)",
          },
          // 非颜色区分：低误差点加 ✓，高误差点加 ✗
          label: {
            show: true,
            position: "top",
            fontSize: 13,
            fontWeight: "bold",
            formatter: (p: any) => {
              const a = pts[p.dataIndex];
              const err = a.actual > 0 ? (Math.abs(a.pred - a.actual) / a.actual) * 100 : 0;
              return err >= 30 ? "✗" : "✓";
            },
            color: (p: any) => {
              const a = pts[p.dataIndex];
              const err = a.actual > 0 ? (Math.abs(a.pred - a.actual) / a.actual) * 100 : 0;
              return err >= 30 ? CHART.vermilion : CHART.jade;
            },
          },
          z: 5,
        },
      ],
    };
  }, [accuracy]);

  /* ════════════════════════════════════════════════════════════
     Profit trend charts (3 independent mini-charts)
     ════════════════════════════════════════════════════════════ */
  const totalChartOption = useMemo(() => {
    const ordered = [...games].sort((a, b) => a.game_no - b.game_no);
    const vv = ordered.filter((g) => g.full_value !== null);
    if (vv.length === 0) return null;
    return {
      tooltip: {
        trigger: "item",
        backgroundColor: CHART.bgSurface,
        borderColor: CHART.border,
        textStyle: { color: CHART.textSecondary, fontSize: 12 },
        formatter: (p: any) => `局 ${p.data[0]}：总价值 ${fmtMoney(p.data[1])}`,
      },
      grid: { left: 72, right: 20, top: 20, bottom: 36 },
      xAxis: {
        type: "value", name: "局号",
        nameTextStyle: { color: CHART.textTertiary, fontSize: 11 },
        axisLabel: { color: CHART.textTertiary },
        axisLine: { lineStyle: { color: CHART.border } },
        splitLine: { lineStyle: { color: CHART.gridLine } },
      },
      yAxis: {
        type: "value", name: "总价值",
        nameTextStyle: { color: CHART.textTertiary, fontSize: 11 },
        axisLabel: { color: CHART.textTertiary, formatter: (v: number) => fmtWan(v) },
        axisLine: { lineStyle: { color: CHART.border } },
        splitLine: { lineStyle: { color: CHART.gridLine } },
      },
      series: [{
        name: "历史对局总价值",
        type: "line",
        data: vv.map((g) => [g.game_no, g.full_value]),
        symbolSize: 6,
        itemStyle: { color: CHART.amber },
        lineStyle: { color: CHART.amber, width: 2 },
      }],
    };
  }, [games]);

  const profitChartOption = useMemo(() => {
    const ordered = [...games].sort((a, b) => a.game_no - b.game_no);
    const pp = ordered.filter((g) => g.profit !== null);
    if (pp.length === 0) return null;
    return {
      tooltip: {
        trigger: "item",
        backgroundColor: CHART.bgSurface,
        borderColor: CHART.border,
        textStyle: { color: CHART.textSecondary, fontSize: 12 },
        formatter: (p: any) => `局 ${p.data[0]}：${p.data[1] >= 0 ? "+" : ""}${fmtMoney(p.data[1])}`,
      },
      grid: { left: 72, right: 20, top: 20, bottom: 36 },
      xAxis: {
        type: "value", name: "局号",
        nameTextStyle: { color: CHART.textTertiary, fontSize: 11 },
        axisLabel: { color: CHART.textTertiary },
        axisLine: { lineStyle: { color: CHART.border } },
        splitLine: { lineStyle: { color: CHART.gridLine } },
      },
      yAxis: {
        type: "value", name: "收益",
        nameTextStyle: { color: CHART.textTertiary, fontSize: 11 },
        axisLabel: { color: CHART.textTertiary, formatter: (v: number) => fmtWan(v) },
        axisLine: { lineStyle: { color: CHART.border } },
        splitLine: { lineStyle: { color: CHART.gridLine } },
      },
      series: [{
        name: "历史对局收益",
        type: "line",
        data: pp.map((g) => [g.game_no, g.profit]),
        symbolSize: 7,
        itemStyle: { color: CHART.goldDim },
        lineStyle: { color: CHART.goldDim, width: 1.5 },
        markLine: {
          silent: true,
          symbol: "none",
          label: { color: CHART.textTertiary, fontSize: 10 },
          lineStyle: { color: CHART.borderDef, type: "dashed" },
          data: [{ yAxis: 0 }],
        },
      }],
    };
  }, [games]);

  const wonChartOption = useMemo(() => {
    const ordered = [...games].sort((a, b) => a.game_no - b.game_no);
    const wp = ordered.filter((g) => g.won === 1 && g.profit !== null);
    if (wp.length === 0) return null;
    return {
      tooltip: {
        trigger: "item",
        backgroundColor: CHART.bgSurface,
        borderColor: CHART.border,
        textStyle: { color: CHART.textSecondary, fontSize: 12 },
        formatter: (p: any) =>
          `第 ${p.data[0]} 次拍下（原局 ${wp[p.dataIndex].game_no}）：${p.data[1] >= 0 ? "+" : ""}${fmtMoney(p.data[1])}`,
      },
      grid: { left: 72, right: 20, top: 20, bottom: 36 },
      xAxis: {
        type: "value", name: "拍下次序", min: 1,
        nameTextStyle: { color: CHART.textTertiary, fontSize: 11 },
        axisLabel: { color: CHART.textTertiary },
        axisLine: { lineStyle: { color: CHART.border } },
        splitLine: { lineStyle: { color: CHART.gridLine } },
      },
      yAxis: {
        type: "value", name: "收益",
        nameTextStyle: { color: CHART.textTertiary, fontSize: 11 },
        axisLabel: { color: CHART.textTertiary, formatter: (v: number) => fmtWan(v) },
        axisLine: { lineStyle: { color: CHART.border } },
        splitLine: { lineStyle: { color: CHART.gridLine } },
      },
      series: [{
        name: "本人竞拍成功收益",
        type: "line",
        data: wp.map((g, i) => [i + 1, g.profit]),
        symbolSize: 8,
        itemStyle: { color: CHART.jade },
        lineStyle: { color: CHART.jade, width: 2.5 },
      }],
    };
  }, [games]);

  /* ── Accuracy chart ── */
  const accColor = (r: number) => {
    if (r >= 90 && r <= 99) return CHART.jade;
    if ((r >= 80 && r < 90) || (r > 99 && r <= 110)) return CHART.amber;
    return CHART.vermilion;
  };
  const accuracyChartOption = useMemo(() => {
    if (accuracy.length === 0) return null;
    return {
      tooltip: {
        trigger: "item",
        backgroundColor: CHART.bgSurface,
        borderColor: CHART.border,
        textStyle: { color: CHART.textSecondary, fontSize: 12 },
        formatter: (p: any) => {
          const a = accuracy[p.dataIndex];
          return `局 ${a.game_no}：预测 ${fmtWan(a.pred)} / 实际 ${fmtWan(a.actual)}<br/>准确率 ${a.ratio}%<br/>均格 ${a.red_avg} · 样本「${a.item}」`;
        },
      },
      legend: {
        data: ["90-99%", "80-89% / 101-110%", "其他"],
        textStyle: { color: CHART.textTertiary, fontSize: 11 },
        top: 0,
      },
      grid: { left: 64, right: 20, top: 36, bottom: 40 },
      xAxis: {
        type: "value", name: "局号",
        nameTextStyle: { color: CHART.textTertiary, fontSize: 11 },
        axisLabel: { color: CHART.textTertiary },
        axisLine: { lineStyle: { color: CHART.border } },
        splitLine: { lineStyle: { color: CHART.gridLine } },
      },
      yAxis: {
        type: "value", name: "准确率%", min: 0, max: 150,
        nameTextStyle: { color: CHART.textTertiary, fontSize: 11 },
        axisLabel: { color: CHART.textTertiary, formatter: "{value}%" },
        axisLine: { lineStyle: { color: CHART.border } },
        splitLine: { lineStyle: { color: CHART.gridLine } },
      },
      series: [{
        type: "line",
        symbolSize: 9,
        lineStyle: { color: CHART.borderDef, width: 1.5 },
        data: accuracy.map((a) => ({
          value: [a.game_no, a.ratio],
          itemStyle: { color: accColor(a.ratio) },
        })),
        markLine: {
          silent: true,
          symbol: "none",
          label: { color: CHART.textTertiary, fontSize: 10 },
          lineStyle: { color: CHART.borderDef, type: "dashed" },
          data: [
            { yAxis: 100, label: { formatter: "实际 100%" } },
            { yAxis: 90, label: { formatter: "90%" } },
            { yAxis: 99, label: { formatter: "99%" } },
          ],
        },
      }],
    };
  }, [accuracy]);

  /* ════════════════════════════════════════════════════════════
     Render
     ════════════════════════════════════════════════════════════ */
  return (
    <div className="space-y-5">
      {/* ── Toast ── */}
      {msg && (
        <div
          className="rounded-xl border px-4 py-2.5 text-sm"
          style={{ borderColor: "rgba(74,154,106,0.3)", background: "var(--jade-soft)", color: "var(--jade-400)" }}
        >
          {msg}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════
          Profit trend charts (3 independent)
          ════════════════════════════════════════════════════════════ */}
      {(totalChartOption || profitChartOption || wonChartOption) && (
        <Card
          title="收益走势"
          desc="三个走势图分开查看：① 历史对局总价值 ② 历史对局收益 ③ 本人竞拍成功的收益"
        >
          {totalChartOption && (
            <div className="mb-4">
              <div className="mb-1 text-xs font-medium" style={{ color: CHART.amber }}>
                ① 历史对局总价值
              </div>
              <Chart option={totalChartOption} height={200} />
            </div>
          )}
          {profitChartOption && (
            <div className="mb-4">
              <div className="mb-1 text-xs font-medium" style={{ color: CHART.goldDim }}>
                ② 历史对局收益
              </div>
              <Chart option={profitChartOption} height={200} />
            </div>
          )}
          {wonChartOption && (
            <div>
              <div className="mb-1 text-xs font-medium" style={{ color: CHART.jade }}>
                ③ 本人竞拍成功的收益（按拍下次序 1..N，悬停显示原局号）
              </div>
              <Chart option={wonChartOption} height={200} />
            </div>
          )}
        </Card>
      )}

      {/* ════════════════════════════════════════════════════════════
          Enhanced Prediction vs Actual Scatter
          ════════════════════════════════════════════════════════════ */}
      {scatterOption ? (
        <Card
          title="预测 vs 实际散点图"
          desc="虚线为完美预测线 (y=x)。绿色 < 15% 误差 · 琥珀 15-30% · 红色 > 30%。点大小反映已知品信息密度，点上方 ✓/✗ 为非颜色区分。"
        >
          <Chart option={scatterOption} height={300} ariaLabel="散点图：预测值 vs 实际值，虚线为完美预测线（y=x），点上方 ✓ 表示误差可接受、✗ 表示误差偏大" />
          {/* Legend */}
          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs" style={{ color: "var(--text-tertiary)" }}>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: CHART.jade }} />
              准确 (&lt;15%)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: CHART.amber }} />
              可接受 (15-30%)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: CHART.vermilion }} />
              偏差大 (&gt;30%)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: CHART.borderDef }} />
              y = x 完美预测线
            </span>
          </div>
        </Card>
      ) : (
        <Card title="预测 vs 实际散点图" desc="历史对局回测，自动显示">
          <div className="py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>
            暂无历史对局回测数据。
          </div>
        </Card>
      )}

      {/* ════════════════════════════════════════════════════════════
          Accuracy chart
          ════════════════════════════════════════════════════════════ */}
      {accLoading ? (
        <Card title="估值准确率" desc="每局用均格 + 随机一件红品估值，预测 / 实际 = 准确率">
          <div className="py-10 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>
            正在回测估值准确率（约数秒）…
          </div>
        </Card>
      ) : (
        accuracyChartOption && (
          <Card title="估值准确率" desc="折线点 = 预测/实际 ×100%；绿 = 90-99%，黄 = 80-89% / 101-110%，红 = 其他">
            <Chart option={accuracyChartOption} height={280} />
          </Card>
        )
      )}

      {/* ════════════════════════════════════════════════════════════
          Game list — accordion timeline
          ════════════════════════════════════════════════════════════ */}
      <Card title={`历史对局（${games.length} 局）`} desc="来自你的实战记录，点击对局展开红品明细">
        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <select
            className="input w-36 !py-1 text-xs"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          >
            <option value="game_no">按局号</option>
            <option value="profit_desc">收益 高→低</option>
            <option value="profit_asc">收益 低→高</option>
            <option value="avg_desc">均格 高→低</option>
            <option value="avg_asc">均格 低→高</option>
          </select>
          <select
            className="input w-32 !py-1 text-xs"
            value={profitFilter}
            onChange={(e) => setProfitFilter(e.target.value as typeof profitFilter)}
          >
            <option value="all">所有收益</option>
            <option value="pos">只看正收益</option>
            <option value="neg">只看负收益</option>
          </select>
          <select
            className="input w-32 !py-1 text-xs"
            value={wonFilter}
            onChange={(e) => setWonFilter(e.target.value as typeof wonFilter)}
          >
            <option value="all">全部对局</option>
            <option value="won">仅本人拍下</option>
            <option value="not">仅未拍下</option>
          </select>
          <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            当前 {filteredGames.length} 局
          </span>
        </div>

        {/* Timeline */}
        <div className="relative">
          <div
            className="absolute bottom-4 left-[9px] top-4 w-px"
            style={{ background: "var(--border-subtle)" }}
          />
          <div className="space-y-3">
            {filteredGames.map((g) => (
              <div key={g.game_no} className="relative pl-8">
                {/* Timeline node */}
                <div
                  className="absolute left-0 top-[22px] h-[19px] w-[19px] rounded-full border-2 transition-all duration-300"
                  style={{
                    borderColor: g.won === 1 ? "var(--jade-400)" : "var(--gold-500)",
                    background: "var(--bg-canvas)",
                    boxShadow: g.won === 1 ? "0 0 8px rgba(91,186,138,0.3)" : "none",
                  }}
                />

                {/* Card */}
                <div
                  className="rounded-lg border p-4 transition-all duration-300"
                  style={{
                    borderColor: g.profit_ok === 0 ? "rgba(224,107,107,0.4)" : "var(--border-subtle)",
                    background: "var(--bg-surface)",
                  }}
                >
                  {/* Summary row — click to expand */}
                  <div
                    onClick={() => setOpen(open === g.game_no ? null : g.game_no)}
                    className="flex cursor-pointer flex-wrap items-center gap-x-6 gap-y-2 transition hover:opacity-80"
                    title={open === g.game_no ? "点击收起" : "点击展开明细"}
                  >
                    <div className="min-w-[56px]">
                      <div
                        className="text-[11px] uppercase tracking-[0.05em]"
                        style={{ color: "var(--text-tertiary)" }}
                      >
                        局号
                      </div>
                      <div
                        className="font-mono text-lg font-medium"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {g.game_no}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>格数组合</div>
                      <div className="font-mono text-sm" style={{ color: "var(--text-secondary)" }}>{g.grid_combo}</div>
                    </div>
                    <div>
                      <div className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>红品</div>
                      <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
                        {g.red_count} 件 · 均格 {g.red_avg}
                      </div>
                    </div>
                    <div className="ml-auto flex items-center gap-3">
                      <div className="text-right">
                        <div
                          className="font-mono text-base font-medium tabular-nums"
                          style={{
                            color:
                              g.profit === null
                                ? "var(--text-tertiary)"
                                : g.profit >= 0
                                  ? "var(--jade-400)"
                                  : "var(--vermilion-400)",
                          }}
                        >
                          {g.profit === null ? "—" : g.profit >= 0 ? `+${fmtMoney(g.profit)}` : fmtMoney(g.profit)}
                        </div>
                        {g.profit_ok === 0 && (
                          <span
                            className="mt-0.5 inline-block rounded px-1 py-0.5 text-[10px]"
                            style={{ background: "var(--vermilion-soft)", color: "var(--vermilion-400)" }}
                            title="收益核验不通过（收益 ≠ 总价值 − 成交价），未进入模型训练"
                          >
                            ⚠核验不过
                          </span>
                        )}
                      </div>
                      <span style={{ color: "var(--text-tertiary)" }}>
                        {open === g.game_no ? "▾" : "▸"}
                      </span>
                    </div>
                  </div>

                  {/* Expanded detail */}
                  {open === g.game_no && (
                    <div
                      className="mt-3 border-t pt-3"
                      style={{ borderColor: "var(--border-subtle)" }}
                    >
                      {/* Prediction vs Actual comparison cards */}
                      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                        <div
                          className="rounded-lg border p-3"
                          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}
                        >
                          <div className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>红品价值</div>
                          <div className="mt-0.5 font-mono text-sm font-medium tabular-nums" style={{ color: "var(--gold-300)" }}>
                            {fmtMoney(g.red_value)}
                          </div>
                        </div>
                        <div
                          className="rounded-lg border p-3"
                          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}
                        >
                          <div className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>总价值</div>
                          <div className="mt-0.5 font-mono text-sm font-medium tabular-nums" style={{ color: "var(--text-primary)" }}>
                            {fmtMoney(g.full_value)}
                          </div>
                        </div>
                        <div
                          className="rounded-lg border p-3"
                          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}
                        >
                          <div className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>成交价</div>
                          <div className="mt-0.5 font-mono text-sm font-medium tabular-nums" style={{ color: "var(--text-primary)" }}>
                            {g.deal_price != null ? fmtMoney(g.deal_price) : "—"}
                          </div>
                        </div>
                        <div
                          className="rounded-lg border p-3"
                          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}
                        >
                          <div className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>收益率</div>
                          <div className="mt-0.5 font-mono text-sm font-medium tabular-nums"
                            style={{
                              color: g.profit === null
                                ? "var(--text-tertiary)"
                                : g.profit >= 0 ? "var(--jade-400)" : "var(--vermilion-400)",
                            }}
                          >
                            {g.profit === null ? "—" : `${(g.profit / g.full_value * 100).toFixed(1)}%`}
                          </div>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="mb-3 flex flex-wrap items-center gap-1.5">
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleWon(g); }}
                          title="点击切换：未标记 → 本人竞拍成功 → 未成功"
                          className="rounded px-1.5 py-0.5 text-[11px] transition"
                          style={{
                            background: g.won === 1 ? "var(--jade-soft)" : "var(--bg-input)",
                            color: g.won === 1 ? "var(--jade-400)" : "var(--text-tertiary)",
                          }}
                        >
                          {g.won === 1 ? "✓ 成功" : g.won === 0 ? "未成功" : "未标记"}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); startEditGame(g); }}
                          title="修改总价值/成交价/收益"
                          className="rounded px-1.5 py-0.5 text-[11px] transition"
                          style={{
                            background: g.profit_ok === 0 ? "var(--vermilion-soft)" : "var(--gold-soft)",
                            color: g.profit_ok === 0 ? "var(--vermilion-400)" : "var(--gold-400)",
                          }}
                        >
                          ✎ 修改
                        </button>
                        {delConfirm === g.game_no ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); removeGame(g); }}
                            className="rounded px-1.5 py-0.5 text-[11px]"
                            style={{ background: "var(--vermilion-soft)", color: "var(--vermilion-400)" }}
                          >
                            确认删除？
                          </button>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDelConfirm(g.game_no);
                              setTimeout(() => {
                                setDelConfirm((c) => (c === g.game_no ? null : c));
                              }, 4000);
                            }}
                            title="删除该局（剩余局号将重新连续编号）"
                            className="rounded px-1.5 py-0.5 text-[11px] transition"
                            style={{ color: "var(--text-tertiary)" }}
                          >
                            🗑
                          </button>
                        )}
                      </div>

                      {/* Red items: view / edit */}
                      {editItemsOpen === g.game_no ? (
                        <div className="space-y-1.5">
                          {editItems.map((it, i) => (
                            <div key={i} className="flex items-center gap-1.5">
                              <input
                                className="input flex-1 !py-1 text-xs"
                                value={it.name}
                                placeholder="藏品名"
                                onChange={(e) => setItemField(i, "name", e.target.value)}
                              />
                              <input
                                className="input w-16 !py-1 text-xs"
                                type="number"
                                value={it.grid_cells}
                                onChange={(e) => setItemField(i, "grid_cells", e.target.value)}
                              />
                              <input
                                className="input w-28 !py-1 text-xs"
                                type="number"
                                value={it.value}
                                onChange={(e) => setItemField(i, "value", e.target.value)}
                              />
                              <button
                                style={{ color: "var(--vermilion-400)" }}
                                onClick={() => removeItemRow(i)}
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <button className="btn-ghost !py-1 text-xs" onClick={addItemRow}>＋ 添加红品</button>
                            <button className="btn-primary !py-1 text-xs" onClick={() => saveItems(g)}>保存红品</button>
                            <button className="btn-ghost !py-1 text-xs" onClick={() => setEditItemsOpen(null)}>取消</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex max-h-40 flex-wrap items-start gap-2 overflow-y-auto">
                          {g.items.map((it, i) => (
                            <span
                              key={i}
                              className="rounded-lg border px-2.5 py-1 text-xs"
                              style={{
                                borderColor: "var(--border-subtle)",
                                background: "var(--bg-canvas)",
                                color: "var(--text-secondary)",
                              }}
                            >
                              {it.name} · {it.grid_cells}格 · {fmtMoney(it.trade_price ?? it.sys_price ?? 0)}
                            </span>
                          ))}
                          <button
                            onClick={(e) => { e.stopPropagation(); startEditItems(g); }}
                            title="增删改该局的红品，保存后自动重算件数/格数/价值"
                            className="rounded-lg border border-dashed px-2.5 py-1 text-xs transition"
                            style={{ borderColor: "var(--border-default)", color: "var(--gold-400)" }}
                          >
                            ✎ 编辑红品
                          </button>
                        </div>
                      )}

                      {/* Game edit form */}
                      {editGame === g.game_no && (
                        <div
                          className="mt-3 flex flex-wrap items-end gap-2 rounded-lg p-2.5"
                          style={{ borderColor: "rgba(201,169,98,0.3)", background: "var(--gold-soft)" }}
                        >
                          <div>
                            <label className="mb-0.5 block text-[10px]" style={{ color: "var(--text-secondary)" }}>总价值</label>
                            <input
                              className="input w-32 !py-1 text-xs"
                              type="number"
                              value={gameForm.total_value}
                              onChange={(e) => gameFormField("total_value", e.target.value)}
                            />
                          </div>
                          <div>
                            <label className="mb-0.5 block text-[10px]" style={{ color: "var(--text-secondary)" }}>成交价</label>
                            <input
                              className="input w-32 !py-1 text-xs"
                              type="number"
                              value={gameForm.deal_price}
                              onChange={(e) => gameFormField("deal_price", e.target.value)}
                            />
                          </div>
                          <div>
                            <label className="mb-0.5 block text-[10px]" style={{ color: "var(--text-secondary)" }}>收益（= 总价值 − 成交价）</label>
                            <input
                              className="input w-32 !py-1 text-xs"
                              type="number"
                              value={gameForm.profit}
                              onChange={(e) => gameFormField("profit", e.target.value)}
                            />
                          </div>
                          <button className="btn-primary !py-1 text-xs" onClick={() => saveGameEdit(g)}>保存并核验</button>
                          <button className="btn-ghost !py-1 text-xs" onClick={() => setEditGame(null)}>取消</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* ════════════════════════════════════════════════════════════
          User records — settlement
          ════════════════════════════════════════════════════════════ */}
      <Card title="我的记录" desc="每场结算后自动纳入训练集并重训">
        {records.length === 0 ? (
          <div className="py-6 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>
            暂无自定义记录。进行一场新对局后，可在此录入结算结果。
          </div>
        ) : (
          <div className="space-y-3">
            {records.map((r) => (
              <div
                key={r.id}
                className="rounded-xl border p-4"
                style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}
              >
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <Badge
                    className={
                      r.status === "completed"
                        ? ""
                        : ""
                    }
                  >
                    <span
                      className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium"
                      style={{
                        borderColor: r.status === "completed" ? "rgba(74,154,106,0.4)" : "rgba(201,154,62,0.4)",
                        background: r.status === "completed" ? "var(--jade-soft)" : "var(--amber-soft)",
                        color: r.status === "completed" ? "var(--jade-400)" : "var(--amber-400)",
                      }}
                    >
                      {r.status === "completed" ? "已结算" : r.status === "bid_placed" ? "已出价" : "草稿"}
                    </span>
                  </Badge>
                  <span style={{ color: "var(--text-tertiary)" }}>{r.created_at}</span>
                  {r.prediction && (
                    <span className="tabular-nums" style={{ color: "var(--text-tertiary)" }}>
                      预测全场 {fmtWan(r.prediction.full.ev)} · 推荐出价 {fmtWan(r.prediction.bid.recommended)}
                    </span>
                  )}
                  {typeof r.actual?.full_value === "number" && (
                    <span className="tabular-nums" style={{ color: "var(--jade-400)" }}>
                      实际 {fmtWan(r.actual.full_value as number)}
                    </span>
                  )}
                  <span className="ml-auto text-xs" style={{ color: "var(--text-tertiary)" }}>{r.note}</span>
                </div>
                {editing === r.id ? (
                  <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
                    {[
                      ["red_value", "红品总价值"],
                      ["full_value", "全场总价值"],
                      ["red_count", "红品件数"],
                      ["red_avg", "红品均格"],
                      ["deal_price", "成交价"],
                    ].map(([k, label]) => (
                      <div key={k}>
                        <label className="field-label">{label}</label>
                        <input
                          className="input"
                          type="number"
                          value={form[k] ?? ""}
                          onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                        />
                      </div>
                    ))}
                    <div className="col-span-2 md:col-span-5">
                      <label className="field-label">备注</label>
                      <input
                        className="input"
                        value={form.note ?? ""}
                        onChange={(e) => setForm({ ...form, note: e.target.value })}
                      />
                    </div>
                    <div className="col-span-2 flex gap-2 md:col-span-5">
                      <button className="btn-primary" onClick={() => settle(r.id)}>保存结算</button>
                      <button className="btn-ghost" onClick={() => setEditing(null)}>取消</button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex gap-2">
                    {r.status !== "completed" && (
                      <button className="btn-ghost !py-1.5 text-xs" onClick={() => setEditing(r.id)}>
                        录入结算
                      </button>
                    )}
                    <button
                      className="btn-ghost !py-1.5 text-xs"
                      style={{ color: "var(--vermilion-400)" }}
                      onClick={async () => {
                        await api.deleteRecord(r.id);
                        load();
                      }}
                    >
                      删除
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
