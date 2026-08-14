import { useEffect, useRef } from "react";
import * as echarts from "echarts";

interface Props {
  // echarts 配置对象类型较严，业务侧以 any 传递（运行时由 echarts 校验）
  option: any;
  height?: number;
  className?: string;
}

export default function Chart({ option, height = 260, className }: Props) {
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
    chartRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={ref} className={className} style={{ height }} />;
}
