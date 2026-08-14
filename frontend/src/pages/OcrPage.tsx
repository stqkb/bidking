import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Badge, Card, Stat } from "../components/Card";
import type { OcrItem, OcrTask } from "../types";
import { fmtMoney } from "../utils";

export default function OcrPage() {
  const [tasks, setTasks] = useState<OcrTask[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [edits, setEdits] = useState<Record<number, OcrItem[]>>({});
  const [zoom, setZoom] = useState<number | null>(null);
  const [settleEdits, setSettleEdits] = useState<Record<number, Record<string, number | null>>>({});
  const [autoClip, setAutoClip] = useState(false);
  const lastClipHash = useRef("");
  const [recPath, setRecPath] = useState("");
  const [recResult, setRecResult] = useState<any>(null);
  const [recBusy, setRecBusy] = useState(false);
  const [recMsg, setRecMsg] = useState("");
  const [recPaths, setRecPaths] = useState<string[]>([]);
  const [recSaving, setRecSaving] = useState(false);

  const load = useCallback(async () => {
    const r = await api.ocrStatus();
    setTasks(r.tasks);
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const scan = async () => {
    setBusy(true);
    setMsg("正在扫描截图目录并识别…（30 张约需 1-2 分钟）");
    try {
      const r = await api.ocrScan();
      setMsg(`扫描完成：新增 ${r.added} 张，失败 ${r.failed} 张`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const itemsOf = (t: OcrTask): OcrItem[] => edits[t.id] ?? t.result.items ?? [];

  const setItem = (tid: number, idx: number, patch: Partial<OcrItem>) => {
    setEdits((m) => {
      const list = (m[tid] ?? tasks.find((t) => t.id === tid)?.result.items ?? []).map((it, i) =>
        i === idx ? { ...it, ...patch } : it,
      );
      return { ...m, [tid]: list };
    });
  };

  const confirm = async (t: OcrTask) => {
    const items = itemsOf(t).map((it) => ({
      name: it.name,
      price: it.price,
      grid_cells: it.grid_cells,
    }));
    const settlement = t.kind === "auction" ? (settleEdits[t.id] ?? {}) : undefined;
    const r = await api.ocrConfirm(t.id, items, settlement);
    setMsg(
      r.ok
        ? t.kind === "auction"
          ? `已确认并入训练：对局 #${r.game_no ?? ""}，模型后台重训中`
          : `已确认：覆盖图鉴原价 ${r.updated_catalog ?? 0} 件，新增 ${r.added_catalog ?? 0} 件；模型后台重训中`
        : r.error ?? "确认失败",
    );
    await load();
  };

  const summaryOf = (t: OcrTask) => {
    const items = itemsOf(t);
    const count = items.length;
    const cells = items.reduce((s, it) => s + (it.grid_cells || 0), 0);
    const total = items.reduce((s, it) => s + (it.price || 0), 0);
    return { count, cells, total };
  };

  const gridPending = tasks.filter((t) => t.kind === "grid" && t.status === "pending");
  const gridTotals = gridPending.reduce(
    (acc, t) => {
      const s = summaryOf(t);
      acc.items += s.count;
      acc.value += s.total;
      return acc;
    },
    { items: 0, value: 0 },
  );

  const processPath = async (path: string) => {
    setMsg("正在识别截图…");
    const r = await api.ocrProcessCapture(path);
    setMsg(r.ok ? `识别完成：${r.items} 件，已加入待确认列表` : r.error ?? "识别失败");
    await load();
  };

  const capture = async () => {
    const r = await fetch("/api/capture", { method: "POST" });
    const j = await r.json();
    if (!j.ok) {
      setMsg(j.error ?? "截图失败");
      return;
    }
    await processPath(j.path);
  };

  const sampleClip = async () => {
    const r = await fetch("/api/clipboard", { method: "POST" });
    const j = await r.json();
    if (!j.ok) {
      setMsg(j.error ?? "剪贴板没有图片");
      return;
    }
    lastClipHash.current = j.hash;
    await processPath(j.path);
  };

  const recognizePath = async (path: string) => {
    setRecPath(path);
    setRecBusy(true);
    setRecMsg("");
    try {
      const r = await api.ocrRecognize(path);
      if (!r.ok) setRecMsg(r.error ?? "识别失败");
      else setRecResult(r);
    } finally {
      setRecBusy(false);
    }
  };
  const recCapture = async () => {
    const j = await (await fetch("/api/capture", { method: "POST" })).json();
    if (j.ok) recognizePath(j.path);
    else setRecMsg(j.error ?? "截图失败");
  };
  const recClip = async () => {
    const j = await (await fetch("/api/clipboard", { method: "POST" })).json();
    if (j.ok) recognizePath(j.path);
    else setRecMsg(j.error ?? "剪贴板没有图片");
  };
  const recUploadMulti = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setRecBusy(true);
    setRecMsg("");
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append("files", f);
      const up = await (await fetch("/api/vision/upload_multi", { method: "POST", body: fd })).json();
      if (!up.paths || up.paths.length === 0) {
        setRecMsg("上传失败：没有可识别的图片");
        return;
      }
      const r = await api.ocrRecognizeMulti(up.paths);
      if (!r.ok) setRecMsg(r.error ?? "识别失败");
      else {
        setRecResult(r);
        setRecPaths(up.paths);
      }
    } catch (e) {
      setRecMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRecBusy(false);
    }
  };

  const saveMulti = async () => {
    if (recPaths.length === 0) {
      setRecMsg("没有可保存的图片，请先上传识别");
      return;
    }
    setRecSaving(true);
    try {
      const r = await api.ocrSaveMulti(recPaths);
      setRecMsg(
        r.saved
          ? `已保存为对局 #${r.game_no}，红品 ${r.red_count} 件 / ${r.total_cells} 格，模型后台重训中`
          : r.error ?? "保存失败",
      );
    } finally {
      setRecSaving(false);
    }
  };
  const recUpload = async (f: File | undefined) => {
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    const j = await (await fetch("/api/vision/upload", { method: "POST", body: fd })).json();
    recognizePath(j.path);
  };

  useEffect(() => {
    if (!autoClip) return;
    let first = true;
    const loadClip = async () => {
      try {
        const r = await fetch("/api/clipboard", { method: "POST" });
        const j = await r.json();
        if (!j.ok) return;
        if (first) {
          first = false;
          lastClipHash.current = j.hash;
          return;
        }
        if (j.hash && j.hash !== lastClipHash.current) {
          lastClipHash.current = j.hash;
          await processPath(j.path);
        }
      } catch { /* ignore */ }
    };
    loadClip();
    const timer = setInterval(loadClip, 2000);
    return () => clearInterval(timer);
  }, [autoClip]);

  const pending = tasks.filter((t) => t.status === "pending");
  const done = tasks.filter((t) => t.status === "confirmed");
  const failed = tasks.filter((t) => t.status === "failed");

  return (
    <div className="space-y-5">
      {msg && (
        <div className="rounded-xl border border-gold-400/30 bg-gold-soft px-4 py-2.5 text-sm text-gold-400">
          {msg}
        </div>
      )}
      <Card
        title="多图识别（只给图片，自动识别红品与成交价）"
        desc="可一次上传多张截图：对局图出红品清单，结算图出成交价/总价值，自动合并；也支持截取 / 剪贴板 / 单图上传"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-primary !py-2 text-xs" onClick={recCapture} disabled={recBusy}>
              📷 截取并识别
            </button>
            <button className="btn-ghost !py-2 text-xs" onClick={recClip} disabled={recBusy}>
              📋 剪贴板识别
            </button>
            <label className="btn-ghost !py-2 text-xs">
              多图上传识别
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => recUploadMulti(e.target.files)} />
            </label>
          </div>
        }
      >
        {recMsg && <div className="mb-2 text-sm text-amber-400">{recMsg}</div>}
        {recBusy && <div className="py-3 text-sm text-content-secondary">识别中…（多张约 5-20 秒）</div>}
        {recResult?.ok && (
          <div className="space-y-3">
            {recResult.image_count > 1 && (
              <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-700">
                已合并 {recResult.image_count} 张图的识别结果
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Stat label="成交价" value={recResult.settlement?.deal_price != null ? fmtMoney(recResult.settlement.deal_price) : "未识别"} tone="money" />
              <Stat label="藏品总价值" value={recResult.settlement?.total_value != null ? fmtMoney(recResult.settlement.total_value) : "—"} />
              <Stat label="红品件数" value={recResult.red_count} tone="accent" />
              <Stat label="格数合计" value={recResult.total_cells} />
              <Stat label="红品价值合计" value={fmtMoney(recResult.red_value)} tone="ok" />
            </div>
            {recResult.image_count > 1 && (
              <div className="flex items-center gap-2">
                <button className="btn-primary !py-2 text-xs" onClick={saveMulti} disabled={recSaving}>
                  {recSaving ? "保存中…" : "💾 保存并入训练"}
                </button>
                <span className="text-[11px] text-content-secondary">
                  将合并结果保存为一条历史对局，用于模型训练
                </span>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-content-secondary">
                    <th className="py-1.5 pr-3">藏品</th>
                    <th className="py-1.5 pr-3">格数</th>
                    <th className="py-1.5 pr-3">价值</th>
                    <th className="py-1.5">红色占比</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {(recResult.items ?? []).filter((it: any) => it.is_red).map((it: any, i: number) => {
                    const m = it.matches?.[0];
                    return (
                      <tr key={i} className="border-t border-ink-700/60 text-content-primary">
                        <td className="py-1.5 pr-3">
                          {it.name}
                          {it.source_image && (
                            <span className="ml-1.5 text-[10px] text-sky-600">{it.source_image}</span>
                          )}
                          {it.visual?.[0] && (
                            <span className="ml-1.5 text-[10px] text-fuchsia-600">视觉:{it.visual[0].name}({it.visual[0].score})</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3">{it.grid_cells || "—"} 格</td>
                        <td className="py-1.5 pr-3 text-jade-400">{m?.value ? fmtMoney(m.value) : "—"}</td>
                        <td className="py-1.5">{((it.red_ratio ?? 0) * 100).toFixed(0)}%</td>
                      </tr>
                    );
                  })}
                  {(recResult.items ?? []).filter((it: any) => it.is_red).length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-3 text-center text-content-secondary">
                        未检测到红色背景的红品（图片可能是结算界面）
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {((recResult.items ?? []).length - (recResult.items ?? []).filter((it: any) => it.is_red).length) > 0 && (
                <div className="mt-1 text-[11px] text-content-secondary">
                  已按红色背景过滤，忽略非红品/UI 文字 {((recResult.items ?? []).length - (recResult.items ?? []).filter((it: any) => it.is_red).length)} 项
                </div>
              )}
            </div>
          </div>
        )}
      </Card>
      <Card
        title={`截图识别（待确认 ${pending.length} · 已确认 ${done.length} · 失败 ${failed.length}）`}
        desc="扫描「截图输入」目录，自动裁切九宫格、读取名称与价格，并匹配图鉴"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-primary !py-2 text-xs" onClick={scan} disabled={busy}>
              {busy ? "识别中…" : "扫描并识别"}
            </button>
            <button className="btn-ghost !py-2 text-xs" onClick={capture} disabled={busy}>
              📷 截取游戏画面
            </button>
            <button className="btn-ghost !py-2 text-xs" onClick={sampleClip} disabled={busy}>
              📋 采样剪贴板截图
            </button>
            <label className="flex items-center gap-1.5 text-xs text-content-secondary">
              <input
                type="checkbox"
                className="accent-indigo-500"
                checked={autoClip}
                onChange={(e) => setAutoClip(e.target.checked)}
              />
              自动采样识别 Win+Shift+S
            </label>
          </div>
        }
      >
        <p className="text-xs leading-relaxed text-content-secondary">
          名称/价格可直接在表格里修改；确认后：**价格以图片识别为准**，图鉴中同名条目直接覆盖系统价（原价），交易行价按 ×1.15（含税）同步，没有的按「名称+格数+价格」新增，并自动重训模型。
          已确认的图片会归档到「截图输入\已处理」。截图/剪贴板截取的图会直接自动识别进待确认列表。
        </p>
        {gridPending.length > 0 && (
          <div className="mt-3 rounded-xl border border-jade-400/30 bg-jade-soft px-4 py-2.5 text-sm text-jade-400">
            识别摘要：当前待确认 {gridPending.length} 张图 · 红品共 <b>{gridTotals.items}</b> 件 · 红品总价值{" "}
            <b>{fmtMoney(gridTotals.value)}</b>
          </div>
        )}
      </Card>

      {pending.map((t) => (
        <Card
          key={t.id}
          title={`${t.shape} · ${t.path.split(/[\\/]/).pop()}`}
          desc={`识别于 ${t.created_at?.slice(5, 16) ?? ""} · ${
            t.kind === "auction"
              ? `红品 ${itemsOf(t).length} 件 · 藏品总价值 ${fmtMoney(t.result.settlement?.total_value ?? 0)} · 成交价 ${fmtMoney(t.result.settlement?.deal_price ?? 0)}`
              : (() => {
                  const s = summaryOf(t);
                  return `红品 ${s.count} 件 · 格数合计 ${s.cells} · 红品总价值 ${fmtMoney(s.total)}`;
                })()
          }`}
          right={
            <div className="flex gap-2">
              <button className="btn-primary !py-1.5 text-xs" onClick={() => confirm(t)}>
                确认并入
              </button>
              <button
                className="btn-ghost !py-1.5 text-xs text-vermilion-400"
                onClick={async () => {
                  await api.ocrDelete(t.id);
                  load();
                }}
              >
                删除
              </button>
            </div>
          }
        >
          <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
            <div>
              <button
                className="group relative block w-full overflow-hidden rounded-xl border border-ink-700 bg-ink-900"
                onClick={() => setZoom(t.id)}
              >
                <img
                  src={`/api/ocr/image/${t.id}`}
                  alt="原图"
                  className="h-44 w-full object-contain transition group-hover:scale-[1.03]"
                />
                <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-content-primary">
                  点击放大
                </span>
              </button>
              {itemsOf(t).some((it) => !it.matched) && (
                <div className="mt-1.5 text-[11px] text-amber-400">⚠ 含未匹配项，请放大核对</div>
              )}
              {itemsOf(t).length === 0 && (
                <div className="mt-1.5 text-[11px] text-amber-400">⚠ 未识别到藏品，请查看原图</div>
              )}
            </div>
            <div className="min-w-0">
              {t.kind === "auction" && (
                <div className="mb-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
                  <div className="mb-2 text-xs font-semibold text-sky-700">
                    结算识别 · 红品 {itemsOf(t).length} 件 · 识别格数{" "}
                    {itemsOf(t).reduce((s, it) => s + (it.grid_cells || 0), 0)}（可编辑）
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      ["total_value", "藏品总价值"],
                      ["deal_price", "成交价"],
                      ["profit", "收益"],
                    ] as const).map(([k, label]) => {
                      const v = settleEdits[t.id]?.[k] ?? t.result.settlement?.[k] ?? "";
                      return (
                        <div key={k}>
                          <label className="field-label">{label}</label>
                          <input
                            className="input !py-1 text-sm"
                            type="number"
                            value={v}
                            onChange={(e) =>
                              setSettleEdits((m) => ({
                                ...m,
                                [t.id]: {
                                  ...(m[t.id] ?? t.result.settlement ?? {}),
                                  [k]: e.target.value === "" ? null : Number(e.target.value),
                                },
                              }))
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
          {itemsOf(t).length === 0 ? (
            <div className="flex h-full items-center justify-center py-10 text-center text-sm text-content-secondary">
              未识别到藏品（可能是空图或识别失败）
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-content-secondary">
                    <th className="py-1.5 pr-3">名称</th>
                    <th className="py-1.5 pr-3">价格（原价）</th>
                    <th className="py-1.5 pr-3">格数</th>
                    <th className="py-1.5 pr-3">图鉴匹配</th>
                    <th className="py-1.5">置信度</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {itemsOf(t).map((it, i) => {
                    const m = it.matches?.[0];
                    return (
                      <tr key={i} className="border-t border-ink-700/60 text-content-primary">
                        <td className="py-1.5 pr-3">
                          <input
                            className="input !py-1 text-sm"
                            value={it.name}
                            onChange={(e) => setItem(t.id, i, { name: e.target.value })}
                          />
                        </td>
                        <td className="py-1.5 pr-3">
                          <input
                            className="input !py-1 text-sm"
                            type="number"
                            value={it.price}
                            onChange={(e) => setItem(t.id, i, { price: Number(e.target.value) })}
                          />
                          <span className="ml-1 inline-flex flex-col gap-0.5 align-middle">
                            {it.price_suspect && (
                              <span className="text-[10px] text-amber-400">价格存疑</span>
                            )}
                            {it.matched && it.price_mismatch && (
                              <span className="text-[10px] text-sky-600">将以图片价覆盖</span>
                            )}
                            {it.matched && it.price_suspect && (
                              <button
                                className="text-[10px] text-jade-400 hover:underline"
                                onClick={() =>
                                  setItem(t.id, i, { price: it.matches?.[0]?.value ?? it.price })
                                }
                              >
                                用图鉴价 {fmtMoney(it.matches?.[0]?.value)}
                              </button>
                            )}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3">
                          <input
                            className="input !py-1 w-16 text-sm"
                            type="number"
                            value={it.grid_cells}
                            onChange={(e) => setItem(t.id, i, { grid_cells: Number(e.target.value) })}
                          />
                          格
                        </td>
                        <td className="py-1.5 pr-3">
                          {it.matched && m ? (
                            <span className="text-jade-400">
                              {m.name}（{m.grid_cells}格 · 系统价 {fmtMoney(m.value)} / 交易行价 {fmtMoney(m.current_value ?? m.value * 1.15)} 含税）
                              {it.matched_by_price && (
                                <span className="ml-1 text-amber-400">按价格匹配</span>
                              )}
                            </span>
                          ) : (
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="text-amber-400">未匹配</span>
                              {it.matches?.map((mm, k) => (
                                <button
                                  key={k}
                                  className="rounded-md border border-amber-500/40 bg-amber-soft px-1.5 py-0.5 text-[11px] text-amber-400 hover:bg-amber-500/20"
                                  onClick={() => setItem(t.id, i, { name: mm.name })}
                                >
                                  按价格匹配：{mm.name}
                                </button>
                              ))}
                            </span>
                          )}
                          {t.kind === "auction" &&
                            (() => {
                              const top = it.visual?.find((v) => v.score >= 0.9);
                              return top ? (
                                <div className="mt-0.5 text-[11px] text-fuchsia-600">
                                  视觉识别：{top.name}（{top.score.toFixed(2)}）
                                </div>
                              ) : (
                                <div className="mt-0.5 text-[11px] text-content-secondary">
                                  图库暂无此藏品图，确认后自动学习
                                </div>
                              );
                            })()}
                        </td>
                        <td className="py-1.5">{(it.name_conf * 100).toFixed(0)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
            </div>
          </div>
        </Card>
      ))}

      {pending.length === 0 && tasks.length > 0 && (
        <Card className="py-8 text-center text-content-secondary">没有待确认的识别结果</Card>
      )}
      {tasks.length === 0 && (
        <Card className="py-10 text-center text-content-secondary">
          先把截图放进「截图输入」对应格数文件夹，然后点「扫描并识别」
        </Card>
      )}
      {zoom !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
          onClick={() => setZoom(null)}
        >
          <img
            src={`/api/ocr/image/${zoom}`}
            alt="放大原图"
            className="max-h-full max-w-full rounded-xl shadow-2xl"
          />
          <button
            className="absolute right-5 top-5 rounded-full bg-ink-800 px-3 py-1.5 text-sm text-content-primary"
            onClick={() => setZoom(null)}
          >
            ✕ 关闭
          </button>
        </div>
      )}
    </div>
  );
}
