import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import BoardEditor from "../components/BoardEditor";
import { Badge, Card, Stat } from "../components/Card";
import type { CnnStatus } from "../types";
import { fmtMoney } from "../utils";

const EMPTY_BOARD = () => Array.from({ length: 16 }, () => Array(16).fill(0));

export default function CnnPage() {
  const [st, setSt] = useState<CnnStatus | null>(null);
  const [board, setBoard] = useState<number[][]>(EMPTY_BOARD);
  const [pred, setPred] = useState<{ value?: number; count?: number; error?: string; calibrated?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setSt(await api.cnnStatus());
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const train = async () => {
    setBusy(true);
    setMsg("CNN 正在后台训练（约 1 分钟）：4 万张合成布局 + 31 局真实校准…");
    try {
      await api.cnnTrain();
      let done = false;
      for (let i = 0; i < 30 && !done; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const s = await api.cnnStatus();
        if (s.trained) {
          done = true;
          setSt(s);
        }
      }
      setMsg(done ? "训练完成 ✓" : "仍在训练，请稍后刷新");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const predict = async () => {
    setPred(null);
    const r = await api.cnnPredict(board);
    setPred(r);
  };

  return (
    <div className="space-y-5">
      {msg && (
        <div className="rounded-xl border border-fuchsia-500/30 bg-fuchsia-500/10 px-4 py-2.5 text-sm text-fuchsia-600">
          {msg}
        </div>
      )}
      <Card
        title="深度卷积模块（棋盘布局 CNN）"
        desc="3 层卷积 + 全连接：图鉴合成 4 万张布局预训练，再用 31 局真实数据线性校准"
        right={
          !st?.trained ? (
            <button className="btn-primary !py-2 text-xs" onClick={train} disabled={busy}>
              {busy ? "训练中…" : "开始训练 CNN"}
            </button>
          ) : (
            <Badge className="border-jade-400/40 bg-jade-soft text-jade-400">已训练</Badge>
          )
        }
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="合成布局" value={st?.n_synth ? st.n_synth.toLocaleString() : "—"} sub={`${st?.epochs ?? "—"} epochs`} />
          <Stat label="测试损失" value={st?.te_loss?.toFixed(3) ?? "—"} sub="合成测试集 MSE" />
          <Stat label="真实校准样本" value={st?.calib?.ok ? `${st.calib.n} 局` : "—"} sub={`相关 ${st?.calib?.corr?.toFixed(2) ?? "—"}`} />
          <Stat label="校准参数" value={st?.calib?.ok ? `斜率 ${st.calib.slope?.toFixed(2)}` : "—"} sub="log 空间线性校准" tone="accent" />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-content-secondary">
          说明：20–40 个真实样本不足以端到端训练深度网络，因此先用 188 件图鉴按格数分布随机合成大量布局预训练 CNN，
          再用你的 31 局真实结果做线性校准。它是规则引擎的辅助估值模块，不取代表格 ML 主模型。
        </p>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="布局画板" desc="把看到的红品形状摆进 16×16 棋盘（只认形状，不填价值）">
          <BoardEditor board={board} onChange={setBoard} />
        </Card>
        <Card title="CNN 预测结果">
          {!st?.trained ? (
            <div className="flex h-64 items-center justify-center text-content-secondary">
              请先训练 CNN 模型
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Stat
                  label="红品总值估计"
                  value={pred?.value ? fmtMoney(pred.value) : "—"}
                  tone="money"
                  sub={pred?.calibrated ? "已用 31 局真实校准" : "仅合成模型"}
                />
                <Stat label="红品件数估计" value={pred?.count ? Math.round(pred.count) : "—"} sub="CNN 输出" />
              </div>
              {pred?.error && (
                <div className="rounded-xl border border-vermilion-400/30 bg-vermilion-soft px-3 py-2 text-sm text-vermilion-400">
                  {pred.error}
                </div>
              )}
              <button className="btn-primary w-full" onClick={predict} disabled={busy}>
                用当前棋盘预测
              </button>
              <p className="text-xs leading-relaxed text-content-secondary">
                提示：也可以回到「新对局估值」，勾选“附加棋盘布局（CNN 融合估值）”，
                估值接口会把 CNN 结果与规则引擎按 50/50 融合。
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
