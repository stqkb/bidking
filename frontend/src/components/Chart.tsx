import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { CHART } from "../theme/chartTokens";

interface Props {
  // echarts 配置对象类型较严，业务侧以 any 传递（运行时由 echarts 校验）
  option: any;
  height?: number;
  className?: string;
  /** 无障碍：图表语义描述，作为容器 role="img" 的 aria-label */
  ariaLabel?: string;
}

export default function Chart({ option, height = 260, className, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    // 统一深色主题：背景透明、tooltip 用面板色（业务侧已指定的样式保持优先）
    const merged = {
      backgroundColor: "transparent",
      ...option,
      tooltip: {
        backgroundColor: CHART.tooltipBg,
        borderColor: CHART.tooltipBorder,
        borderWidth: 1,
        borderRadius: 8,
        padding: [8, 12],
        textStyle: { color: CHART.textPrimary, fontSize: 12 },
        ...(option?.tooltip ?? {}),
      },
    };
    chartRef.current.setOption(merged, true);
  }, [option]);

  return (
    <div
      ref={ref}
      className={className}
      style={{ height }}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
    />
  );
}
