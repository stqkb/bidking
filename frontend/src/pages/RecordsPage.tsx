import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Badge, Card } from "../components/Card";
import Chart from "../components/Chart";
import type { GameRecord, UserRecord } from "../types";
import { fmtMoney, fmtWan } from "../utils";

export default function RecordsPage() {
  const [games, setGames] = useState<GameRecord[]>([]);
  const [records, setRecords] = useState<UserRecord[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [sortBy, setSortBy] = useState<"game_no" | "profit_desc" | "profit_asc">("game_no");
  const [profitFilter, setProfitFilter] = useState<"all" | "pos" | "neg">("all");
  const [wonFilter, setWonFilter] = useState<"all" | "won" | "not">("all");
  const [editGame, setEditGame] = useState<number | null>(null);
  const [gameForm, setGameForm] = useState<{ total_value: string; deal_price: string; profit: string }>({
    total_value: "",
    deal_price: "",
    profit: "",
  });

  // 历史对局排序与过滤
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
    // 未标记/未成功 → 本人竞拍成功；已成功 → 取消
    const next = g.won === 1 ? 0 : 1;
    await api.updateGameWon(g.game_no, next === 1);
    await load();
  };

  const startEditGame = (g: GameRecord) => {
    setEditGame(g.game_no);
    setOpen(g.game_no);  // 同时展开明细显示编辑表单
    setGameForm({
      total_value: g.full_value != null ? String(g.full_value) : "",
      deal_price: g.deal_price != null ? String(g.deal_price) : "",
      profit: g.profit != null ? String(g.profit) : "",
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

  const chartOption = (() => {
    const done = records.filter(
      (r) => r.status === "completed" && r.prediction?.full?.ev && r.actual?.full_value,
    );
    if (done.length === 0) return null;
    return {
      tooltip: { trigger: "item" },
      grid: { left: 56, right: 20, top: 20, bottom: 40 },
      xAxis: {
        type: "value",
        name: "预测",
        axisLabel: { color: "#94a3b8", formatter: (v: number) => fmtWan(v) },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      yAxis: {
        type: "value",
        name: "实际",
        axisLabel: { color: "#94a3b8", formatter: (v: number) => fmtWan(v) },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      series: [
        {
          type: "scatter",
          symbolSize: 12,
          data: done.map((r) => [r.prediction!.full.ev, r.actual!.full_value as number]),
          itemStyle: { color: "#10b981" },
        },
        {
          type: "line",
          data: [
            [0, 0],
            [4000000, 4000000],
          ],
          lineStyle: { type: "dashed", color: "#475569" },
          symbol: "none",
        },
      ],
    };
  })();

  // 收益走势：三个独立小图（总价值 / 全部收益 / 本人竞拍成功收益），避免多线同轴互相干扰
  const totalChartOption = (() => {
    const ordered = [...games].sort((a, b) => a.game_no - b.game_no);
    const vv = ordered.filter((g) => g.full_value !== null);
    if (vv.length === 0) return null;
    return {
      tooltip: {
        trigger: "item",
        formatter: (p: any) => `局 ${p.data[0]}：总价值 ${fmtMoney(p.data[1])}`,
      },
      grid: { left: 72, right: 20, top: 20, bottom: 36 },
      xAxis: { type: "value", name: "局号", axisLabel: { color: "#94a3b8" }, splitLine: { lineStyle: { color: "#1e293b" } } },
      yAxis: {
        type: "value",
        name: "总价值",
        axisLabel: { color: "#94a3b8", formatter: (v: number) => fmtWan(v) },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      series: [
        {
          name: "历史对局总价值",
          type: "line",
          data: vv.map((g) => [g.game_no, g.full_value]),
          symbolSize: 6,
          itemStyle: { color: "#f59e0b" },
          lineStyle: { color: "#f59e0b", width: 2 },
        },
      ],
    };
  })();

  const profitChartOption = (() => {
    const ordered = [...games].sort((a, b) => a.game_no - b.game_no);
    const pp = ordered.filter((g) => g.profit !== null);
    if (pp.length === 0) return null;
    return {
      tooltip: {
        trigger: "item",
        formatter: (p: any) => `局 ${p.data[0]}：${p.data[1] >= 0 ? "+" : ""}${fmtMoney(p.data[1])}`,
      },
      grid: { left: 72, right: 20, top: 20, bottom: 36 },
      xAxis: { type: "value", name: "局号", axisLabel: { color: "#94a3b8" }, splitLine: { lineStyle: { color: "#1e293b" } } },
      yAxis: {
        type: "value",
        name: "收益",
        axisLabel: { color: "#94a3b8", formatter: (v: number) => fmtWan(v) },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      series: [
        {
          name: "历史对局收益",
          type: "line",
          data: pp.map((g) => [g.game_no, g.profit]),
          symbolSize: 7,
          itemStyle: { color: "#38bdf8" },
          lineStyle: { color: "#38bdf8", width: 1.5 },
        },
      ],
    };
  })();

  const wonChartOption = (() => {
    // 本人竞拍成功的局按拍下次序 1..N 连续排列（原局号不连续，避免折线断开）
    const ordered = [...games].sort((a, b) => a.game_no - b.game_no);
    const wp = ordered.filter((g) => g.won === 1 && g.profit !== null);
    if (wp.length === 0) return null;
    return {
      tooltip: {
        trigger: "item",
        formatter: (p: any) =>
          `第 ${p.data[0]} 次拍下（原局 ${wp[p.dataIndex].game_no}）：${p.data[1] >= 0 ? "+" : ""}${fmtMoney(p.data[1])}`,
      },
      grid: { left: 72, right: 20, top: 20, bottom: 36 },
      xAxis: { type: "value", name: "拍下次序", min: 1, axisLabel: { color: "#94a3b8" }, splitLine: { lineStyle: { color: "#1e293b" } } },
      yAxis: {
        type: "value",
        name: "收益",
        axisLabel: { color: "#94a3b8", formatter: (v: number) => fmtWan(v) },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      series: [
        {
          name: "本人竞拍成功收益",
          type: "line",
          data: wp.map((g, i) => [i + 1, g.profit]),
          symbolSize: 8,
          itemStyle: { color: "#10b981" },
          lineStyle: { color: "#10b981", width: 2.5 },
        },
      ],
    };
  })();

  return (
    <div className="space-y-5">
      {msg && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600">
          {msg}
        </div>
      )}

      <Card title={`历史对局（${games.length} 局）`} desc="来自你的实战记录，点击行展开红品清单">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select
            className="input w-36 !py-1 text-xs"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          >
            <option value="game_no">按局号</option>
            <option value="profit_desc">收益 高→低</option>
            <option value="profit_asc">收益 低→高</option>
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
          <span className="text-[11px] text-slate-500">当前 {filteredGames.length} 局</span>
        </div>
        <div className="max-h-[460px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-ink-850">
              <tr className="text-left text-xs text-slate-500">
                <th className="py-2 pr-3">局</th>
                <th className="py-2 pr-3">格数组合</th>
                <th className="py-2 pr-3">件数</th>
                <th className="py-2 pr-3">均格</th>
                <th className="py-2 pr-3">红品价值</th>
                <th className="py-2 pr-3">全场总价值</th>
                <th className="py-2 pr-3">成交价</th>
                <th className="py-2 pr-3">盈亏</th>
                <th className="py-2">竞拍</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {filteredGames.map((g) => (
                <Fragment key={g.game_no}>
                  <tr
                    onClick={() => setOpen(open === g.game_no ? null : g.game_no)}
                    className="cursor-pointer border-t border-ink-700/60 text-slate-600 transition hover:bg-ink-800/50"
                  >
                    <td className="py-2 pr-3">{g.game_no}</td>
                    <td className="py-2 pr-3 text-slate-500">{g.grid_combo}</td>
                    <td className="py-2 pr-3">{g.red_count}</td>
                    <td className="py-2 pr-3">{g.red_avg}</td>
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
                      {g.profit_ok === 0 && (
                        <span
                          className="ml-1 rounded bg-rose-500/15 px-1 py-0.5 text-[10px] text-rose-400"
                          title="收益核验不通过（收益 ≠ 总价值 − 成交价），未进入模型训练"
                        >
                          ⚠核验不过
                        </span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditGame(g);
                        }}
                        title="修改总价值/成交价/收益"
                        className={`ml-1.5 rounded px-1.5 py-0.5 text-[11px] transition ${
                          g.profit_ok === 0
                            ? "bg-rose-500/20 text-rose-300 hover:bg-rose-500/30"
                            : "bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25"
                        }`}
                      >
                        ✎ 修改
                      </button>
                    </td>
                    <td className="py-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleWon(g);
                        }}
                        title="点击切换：未标记 → 本人竞拍成功 → 未成功（收益规律仅统计成功局）"
                        className={`rounded px-1.5 py-0.5 text-[11px] transition ${
                          g.won === 1
                            ? "bg-emerald-500/15 text-emerald-600"
                            : g.won === 0
                              ? "bg-slate-500/15 text-slate-400"
                              : "bg-ink-800 text-slate-500 hover:text-slate-400"
                        }`}
                      >
                        {g.won === 1 ? "✓ 成功" : g.won === 0 ? "未成功" : "未标记"}
                      </button>
                    </td>
                  </tr>
                  {open === g.game_no && (
                    <tr key={`${g.game_no}-detail`} className="border-t border-ink-800 bg-ink-900/40">
                      <td colSpan={9} className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          {g.items.map((it, i) => (
                            <span
                              key={i}
                              className="rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs text-slate-200"
                            >
                              {it.name} · {it.grid_cells}格 · {fmtMoney(it.trade_price ?? it.sys_price ?? 0)}
                            </span>
                          ))}
                        </div>
                        {editGame === g.game_no && (
                          <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-2.5">
                            <div>
                              <label className="mb-0.5 block text-[10px] text-slate-400">总价值</label>
                              <input
                                className="input w-32 !py-1 text-xs"
                                type="number"
                                value={gameForm.total_value}
                                onChange={(e) => setGameForm({ ...gameForm, total_value: e.target.value })}
                              />
                            </div>
                            <div>
                              <label className="mb-0.5 block text-[10px] text-slate-400">成交价</label>
                              <input
                                className="input w-32 !py-1 text-xs"
                                type="number"
                                value={gameForm.deal_price}
                                onChange={(e) => setGameForm({ ...gameForm, deal_price: e.target.value })}
                              />
                            </div>
                            <div>
                              <label className="mb-0.5 block text-[10px] text-slate-400">收益（= 总价值 − 成交价）</label>
                              <input
                                className="input w-32 !py-1 text-xs"
                                type="number"
                                value={gameForm.profit}
                                onChange={(e) => setGameForm({ ...gameForm, profit: e.target.value })}
                              />
                            </div>
                            <button className="btn-primary !py-1 text-xs" onClick={() => saveGameEdit(g)}>
                              保存并核验
                            </button>
                            <button className="btn-ghost !py-1 text-xs" onClick={() => setEditGame(null)}>
                              取消
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {(totalChartOption || profitChartOption || wonChartOption) && (
        <Card
          title="收益走势"
          desc="三个走势图分开查看：① 历史对局总价值 ② 历史对局收益 ③ 本人竞拍成功的收益（在表格「竞拍」列标记本人是否拍下）"
        >
          {totalChartOption && (
            <div className="mb-4">
              <div className="mb-1 text-xs font-medium text-amber-400">① 历史对局总价值</div>
              <Chart option={totalChartOption} height={200} />
            </div>
          )}
          {profitChartOption && (
            <div className="mb-4">
              <div className="mb-1 text-xs font-medium text-sky-400">② 历史对局收益</div>
              <Chart option={profitChartOption} height={200} />
            </div>
          )}
          {wonChartOption && (
            <div>
              <div className="mb-1 text-xs font-medium text-emerald-400">③ 本人竞拍成功的收益（按拍下次序 1..N，悬停显示原局号）</div>
              <Chart option={wonChartOption} height={200} />
            </div>
          )}
        </Card>
      )}

      {chartOption && (
        <Card title="我的记录：预测 vs 实际" desc="已完成结算的预测误差（虚线为理想一致线）">
          <Chart option={chartOption} height={260} />
        </Card>
      )}

      <Card title="我的记录" desc="每场结算后自动纳入训练集并重训">
        {records.length === 0 ? (
          <div className="py-6 text-center text-sm text-slate-400">
            暂无自定义记录。进行一场新对局后，可在此录入结算结果。
          </div>
        ) : (
          <div className="space-y-3">
            {records.map((r) => (
              <div key={r.id} className="rounded-xl border border-ink-700/70 bg-ink-900/50 p-4">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <Badge
                    className={
                      r.status === "completed"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-600"
                    }
                  >
                    {r.status === "completed" ? "已结算" : r.status === "bid_placed" ? "已出价" : "草稿"}
                  </Badge>
                  <span className="text-slate-500">{r.created_at}</span>
                  {r.prediction && (
                    <span className="text-slate-600 tabular-nums">
                      预测全场 {fmtWan(r.prediction.full.ev)} · 推荐出价 {fmtWan(r.prediction.bid.recommended)}
                    </span>
                  )}
                  {typeof r.actual?.full_value === "number" && (
                    <span className="text-emerald-600 tabular-nums">实际 {fmtWan(r.actual.full_value as number)}</span>
                  )}
                  <span className="ml-auto text-xs text-slate-500">{r.note}</span>
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
                      <button className="btn-primary" onClick={() => settle(r.id)}>
                        保存结算
                      </button>
                      <button className="btn-ghost" onClick={() => setEditing(null)}>
                        取消
                      </button>
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
                      className="btn-ghost !py-1.5 text-xs text-rose-600 hover:!border-rose-500/40"
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
