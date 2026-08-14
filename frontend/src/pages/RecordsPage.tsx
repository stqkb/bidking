import { Fragment, useCallback, useEffect, useState } from "react";
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

  const profitChartOption = (() => {
    // 收益规律：x=局号，y=收益；蓝色=本人竞拍成功，灰色=未成功/未标记
    const won = games.filter((g) => g.won === 1 && g.profit !== null);
    const notWon = games.filter((g) => g.won !== 1 && g.profit !== null);
    if (won.length + notWon.length === 0) return null;
    return {
      tooltip: {
        trigger: "item",
        formatter: (p: any) => `局 ${p.data[0]}：${p.data[1] >= 0 ? "+" : ""}${fmtMoney(p.data[1])}`,
      },
      legend: { textStyle: { color: "#94a3b8" }, top: 0 },
      grid: { left: 72, right: 20, top: 32, bottom: 40 },
      xAxis: {
        type: "value",
        name: "局号",
        axisLabel: { color: "#94a3b8" },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      yAxis: {
        type: "value",
        name: "收益",
        axisLabel: { color: "#94a3b8", formatter: (v: number) => fmtWan(v) },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      series: [
        {
          name: "本人竞拍成功",
          type: "line",
          data: won.map((g) => [g.game_no, g.profit]),
          symbolSize: 9,
          itemStyle: { color: "#3b82f6" },
          lineStyle: { color: "#3b82f6", width: 2 },
        },
        {
          name: "未成功/未标记",
          type: "line",
          data: notWon.map((g) => [g.game_no, g.profit]),
          symbolSize: 6,
          itemStyle: { color: "#64748b" },
          lineStyle: { color: "#64748b", type: "dashed", width: 1 },
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

      <Card title="历史对局（31 局初始数据）" desc="来自你的实战记录，点击行展开红品清单">
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
              {games.map((g) => (
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
                              className="rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs text-slate-600"
                            >
                              {it.name} · {it.grid_cells}格 · {fmtMoney(it.trade_price ?? it.sys_price ?? 0)}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {profitChartOption && (
        <Card
          title="收益走势"
          desc="蓝色 = 本人竞拍成功，灰色 = 未成功/未标记；点击表格「竞拍」列标记，收益规律仅统计本人竞拍成功的对局"
        >
          <Chart option={profitChartOption} height={300} />
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
