import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Card, Stat } from "../components/Card";
import Chart from "../components/Chart";
import type { ModelStatus } from "../types";
import { fmtMoney, fmtPct } from "../utils";

export default function ModelPage() {
  const [st, setSt] = useState<ModelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [visionSt, setVisionSt] = useState<any>(null);
  const [visionBusy, setVisionBusy] = useState(false);

  const load = useCallback(async () => {
    setSt(await api.modelStatus());
  }, []);

  useEffect(() => {
    load().catch(() => {});
    api.visionModelStatus().then(setVisionSt).catch(() => {});
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  const retrain = async () => {
    setBusy(true);
    setMsg("重训已在后台启动，完成后自动刷新…");
    try {
      await api.retrain();
    } finally {
      setTimeout(() => {
        setBusy(false);
        setMsg("");
        load();
      }, 3000);
    }
  };

  const rebuildVision = async () => {
    setVisionBusy(true);
    setMsg("正在重建红品识别特征库（GPU）…");
    try {
      const r = await api.visionModelRebuild();
      setVisionSt(await api.visionModelStatus());
      setMsg(`特征库重建完成：${r.samples} 样本 / ${r.distinct_names} 藏品（${r.device}）`);
    } finally {
      setTimeout(() => {
        setVisionBusy(false);
        setMsg("");
      }, 2500);
    }
  };

  const calibOption = useMemo(() => {
    const c = st?.calibration_curve;
    if (!c || c.pred.length === 0) return null;
    return {
      tooltip: { trigger: "axis" },
      legend: { textStyle: { color: "#94a3b8" }, top: 0 },
      grid: { left: 56, right: 20, top: 34, bottom: 36 },
      xAxis: {
        type: "value",
        name: "预测",
        axisLabel: { color: "#94a3b8", formatter: (v: number) => (v / 10000).toFixed(0) + "万" },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      yAxis: {
        type: "value",
        name: "实际",
        axisLabel: { color: "#94a3b8", formatter: (v: number) => (v / 10000).toFixed(0) + "万" },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      series: [
        {
          type: "line",
          name: "校准曲线",
          data: c.pred.map((p, i) => [p, c.actual[i]]),
          smooth: true,
          symbolSize: 10,
          itemStyle: { color: "#10b981" },
          lineStyle: { color: "#10b981", width: 2 },
        },
        {
          type: "line",
          name: "理想一致",
          data: [
            [0, 0],
            [5000000, 5000000],
          ],
          lineStyle: { type: "dashed", color: "#475569" },
          symbol: "none",
        },
      ],
    };
  }, [st]);

  const impOption = useMemo(() => {
    const imp = st?.importance;
    if (!imp || Object.keys(imp).length === 0) return null;
    const names: Record<string, string> = {
      red_avg: "红品均格",
      red_count: "红品件数",
      red_grids: "红品总格数",
      known_size: "已知红品格数",
      log_known_value: "已知红品价值(log)",
      known_ratio: "已知价值/图鉴均值比",
      game_no_norm: "场次(时间漂移)",
      rule_red_log: "规则红品估值(log)",
      rule_full_log: "规则全场估值(log)",
    };
    const data = Object.entries(imp)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => ({ name: names[k] ?? k, value: +v.toFixed(3) }));
    return {
      tooltip: { trigger: "item" },
      grid: { left: 130, right: 30, top: 10, bottom: 20 },
      xAxis: {
        type: "value",
        axisLabel: { color: "#94a3b8" },
        splitLine: { lineStyle: { color: "#1e293b" } },
      },
      yAxis: { type: "category", data: data.map((d) => d.name), axisLabel: { color: "#cbd5e1" } },
      series: [
        {
          type: "bar",
          data: data.map((d) => d.value),
          itemStyle: { color: "#818cf8", borderRadius: [0, 6, 6, 0] },
          barWidth: 14,
        },
      ],
    };
  }, [st]);

  if (!st) return <Card className="py-10 text-center text-slate-500">加载中…</Card>;

  return (
    <div className="space-y-5">
      {msg && (
        <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-2.5 text-sm text-indigo-600">
          {msg}
        </div>
      )}
      <Card
        title="模型状态"
        desc="以规则估值为先验的残差回归集成：贝叶斯岭 + 高斯过程 + 梯度提升"
        right={
          <button className="btn-primary !py-2 text-xs" onClick={retrain} disabled={busy}>
            {busy ? "重训中…" : "立即重训"}
          </button>
        }
      >
        {!st.trained ? (
          <div className="py-6 text-center text-sm text-slate-500">
            模型未训练（样本不足 {st.n} 条）。完成结算后自动重训，或点击右上角手动重训。
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="训练样本" value={`${st.n} 局`} sub={`训练于 ${st.trained_at?.slice(5, 16) ?? "—"}`} />
              <Stat label="MAE（原始金币）" value={fmtMoney(st.loocv?.full.mae_orig)} sub="留一交叉验证" />
              <Stat label="MAPE" value={fmtPct(st.loocv?.full.mape_pct)} sub="留一交叉验证" tone="accent" />
              <Stat label="R²（log）" value={st.loocv?.full.r2_log.toFixed(3)} sub="留一交叉验证" tone="ok" />
              <Stat label="区间覆盖率" value={st.loocv ? st.loocv.coverage_pct + "%" : "—"} sub="p10–p90 经验区间" tone="money" />
            </div>
            {st.chrono && (
              <div className="mt-3 flex flex-wrap gap-4 rounded-xl border border-ink-700/70 bg-ink-900/50 px-4 py-3 text-xs text-slate-500">
                <span>按时间序切分（前 70% 训练）：</span>
                <span>MAPE {fmtPct(st.chrono.full.mape_pct)}</span>
                <span>R² {st.chrono.full.r2_log.toFixed(3)}</span>
                <span>区间覆盖率 {st.chrono.coverage_pct}%</span>
              </div>
            )}
          </>
        )}
      </Card>

      <Card
        title="红品识别模型"
        desc="ResNet50 特征库 + 图库匹配：样本越多、越准确；重建可刷新 GPU 特征缓存"
        right={
          <button className="btn-primary !py-2 text-xs" onClick={rebuildVision} disabled={visionBusy}>
            {visionBusy ? "重建中…" : "重建特征库"}
          </button>
        }
      >
        {!visionSt?.trained ? (
          <div className="py-6 text-center text-sm text-slate-500">
            红品识别模型未就绪：请先在「图像学习」页框选藏品图标入库。
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="学习样本" value={visionSt.samples} sub={`图库条目 ${visionSt.total_entries}`} />
              <Stat label="藏品数" value={visionSt.distinct_names} />
              <Stat label="手工学习" value={visionSt.learn_samples} tone="accent" />
              <Stat label="推理设备" value={visionSt.gpu_name ? "GPU" : "CPU"} sub={visionSt.gpu_name ?? visionSt.device} tone="ok" />
              <Stat label="FP16" value={visionSt.fp16 ? "启用" : "关闭"} tone="money" />
            </div>
            {visionSt.distribution && (
              <div className="mt-3 flex flex-wrap gap-4 rounded-xl border border-ink-700/70 bg-ink-900/50 px-4 py-3 text-xs text-slate-500">
                <span>同款中位相似度 {visionSt.distribution.same?.median ?? "—"}</span>
                <span>异款最高 {visionSt.distribution.diff?.max ?? "—"}</span>
                <span>区分度（同款中位−异款最高）{visionSt.distribution.gap_median_vs_max ?? "—"}</span>
              </div>
            )}
          </>
        )}
      </Card>

      {calibOption && (
        <Card title="校准曲线" desc="预测均值 vs 实际均值（分桶）">
          <Chart option={calibOption} height={280} />
        </Card>
      )}

      {impOption && (
        <Card title="特征重要性" desc="梯度提升成员的特征贡献">
          <Chart option={impOption} height={320} />
        </Card>
      )}

      <Card title="持续学习说明" desc="">
        <ul className="list-inside list-disc space-y-1 text-sm leading-relaxed text-slate-500">
          <li>每完成一场结算（历史复盘页录入真值），系统自动把该场加入训练集并后台重训。</li>
          <li>新对局估值时，若模型已训练（≥6 样本），会用模型修正规则估值并给出经验区间。</li>
          <li>样本越少区间越宽；积累到 20–40 场后误差会明显收敛。</li>
        </ul>
      </Card>
    </div>
  );
}
