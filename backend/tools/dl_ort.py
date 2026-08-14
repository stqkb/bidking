# -*- coding: utf-8 -*-
"""下载 onnxruntime-gpu wheel（支持断点续传 + 完整性校验）。
用法: python tools/dl_ort.py
"""
from __future__ import annotations

import sys
import time
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen


OUT = Path(r"E:\桌面\拍卖预测\竞拍之王项目\data\wheels\onnxruntime_gpu-1.28.0-cp311-cp311-win_amd64.whl")
URL = ("https://files.pythonhosted.org/packages/d1/1b/"
       "a634783c2455cca7c66261dc4e3e16f4058047b79679925737a30dd4c76e/"
       "onnxruntime_gpu-1.28.0-cp311-cp311-win_amd64.whl")
CHUNK = 4 * 1024 * 1024


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    total = 241400000  # 已知大小 241.4MB，用于进度显示
    have = OUT.stat().st_size if OUT.exists() else 0
    if have >= total:
        print(f"已存在 {have / 1e6:.1f} MB，校验中…")
        return verify()
    if have:
        print(f"断点续传：已有 {have / 1e6:.1f} MB，继续下载")
    req = Request(URL, headers={"Range": f"bytes={have}-"} if have else {})
    mode = "ab" if have else "wb"
    start = time.time()
    last_report = time.time()
    last_bytes = have
    with open(OUT, mode) as f:
        while True:
            try:
                with urlopen(req, timeout=90) as r:
                    while True:
                        chunk = r.read(CHUNK)
                        if not chunk:
                            break
                        f.write(chunk)
                        f.flush()
                        have += len(chunk)
                        now = time.time()
                        if now - last_report >= 8:
                            speed = (have - last_bytes) / (now - last_report) / 1e6
                            print(f"  {have / 1e6:.0f} MB / {total / 1e6:.0f} MB ({have / total * 100:.1f}%)  {speed:.1f} MB/s")
                            last_report = now
                            last_bytes = have
            except Exception as e:  # noqa: BLE001
                print(f"  连接中断（{e!r}），3 秒后断点续传…")
                time.sleep(3)
                have = OUT.stat().st_size if OUT.exists() else 0
                req = Request(URL, headers={"Range": f"bytes={have}-"})
                continue
            break
    print(f"下载完成：{have / 1e6:.1f} MB，耗时 {(time.time() - start) / 60:.1f} 分钟")
    return verify()


def verify() -> int:
    print("校验 ZIP 完整性…")
    try:
        with zipfile.ZipFile(OUT) as z:
            bad = z.testzip()
            if bad:
                print(f"校验失败：坏条目 {bad}")
                return 1
            print(f"校验通过：{len(z.namelist())} 个条目")
            return 0
    except Exception as e:  # noqa: BLE001
        print(f"校验失败：{e!r}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
