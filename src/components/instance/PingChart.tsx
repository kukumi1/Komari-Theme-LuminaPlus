import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import UplotReact from "uplot-react";
import type uPlot from "uplot";
import { ChevronDown, ChevronUp, Eye, EyeOff, RefreshCw } from "lucide-react";
import { usePingRecords } from "@/hooks/useRecords";
import { InstancePanel, InstanceChartLoading } from "./InstancePanel";
import {
  buildChartTooltipHooks,
  colorForSeries,
  createTimeAxisFormatter,
  getAxisColors,
  toChartSeconds,
  useResponsiveChartSize,
  type ChartTooltipState,
} from "./chartShared";
import { ChartTooltip, CycleToggle, SwitchToggle } from "./ChartParts";
import { ChartRangeSlider, type ChartRangePreviewSeries } from "./ChartRangeSlider";
import { PingTaskStatsPopover } from "./PingTaskStatsPopover";
import {
  cutPeakValues,
  detectTypicalIntervalSeconds,
  downsampleAligned,
  insertMetricGapSentinels,
  smoothByCount,
  type MetricBucketStat,
} from "./chartData";
import {
  buildPingSeriesOverlay,
  drawPingOverlay,
  lossBandHeight,
  type LossMarkMode,
  type PingSeriesOverlay,
} from "./pingChartOverlay";
import {
  clampZoomWindow,
  FULL_ZOOM_WINDOW,
  rangeToZoomWindow,
  zoomWindowIndexRange,
  zoomWindowToRange,
  type ChartZoomWindow,
} from "./chartZoom";
import { latencyHeatColor, lossHeatColor } from "@/utils/metricTone";
import { historyChartRangeSeconds, historyCoverageLabel } from "@/utils/historyRange";
import { resolvePingChartInterval, resolvePingSampleCounts } from "@/utils/pingMetrics";
import { usePreferences } from "@/hooks/usePreferences";
import type { PingRecord, PingTaskStats } from "@/types/komari";
import type { TimedMetricPoint } from "./chartData";

interface WeightedLatency {
  value: number;
  weight: number;
}

function valueAtWeightedIndex(sorted: WeightedLatency[], index: number) {
  let offset = 0;
  for (const sample of sorted) {
    offset += sample.weight;
    if (index < offset) return sample.value;
  }
  return sorted[sorted.length - 1]?.value ?? null;
}

function percentileFromWeighted(sorted: WeightedLatency[], ratio: number) {
  const total = sorted.reduce((sum, sample) => sum + sample.weight, 0);
  if (total <= 0) return null;
  const index = (total - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = valueAtWeightedIndex(sorted, lower);
  const upperValue = valueAtWeightedIndex(sorted, upper);
  if (lowerValue == null || upperValue == null) return null;
  if (lower === upper) return lowerValue;
  const weight = index - lower;
  return lowerValue + (upperValue - lowerValue) * weight;
}

export function summarizePingRecords(records: PingRecord[]) {
  const samples = records.map((record) => ({
    record,
    ...resolvePingSampleCounts(record),
  }));
  const valid = samples
    .filter(({ record, valid: count }) => record.value >= 0 && count > 0)
    .map(({ record, valid: count }) => ({ value: record.value, weight: count }))
    .sort((a, b) => a.value - b.value);
  const total = samples.reduce((sum, sample) => sum + sample.total, 0);
  const lost = samples.reduce((sum, sample) => sum + sample.lost, 0);
  const validCount = valid.reduce((sum, sample) => sum + sample.weight, 0);

  let latest: number | null = null;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const { record, valid: count } = samples[index];
    if (record.value >= 0 && count > 0) {
      latest = record.value;
      break;
    }
  }

  return {
    latest,
    avg:
      validCount > 0
        ? valid.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / validCount
        : null,
    min: valid[0]?.value ?? null,
    max: valid[valid.length - 1]?.value ?? null,
    p50: percentileFromWeighted(valid, 0.5),
    p99: percentileFromWeighted(valid, 0.99),
    total,
    lost,
    loss: total > 0 ? (lost / total) * 100 : 0,
  };
}

const EMPTY_PING_STATS: PingTaskStats[] = [];

// 采样档位：点越多细节越全但线越跳、渲染越重。标准档是原来的固定值，
// 全量给"想看清每一次抖动"的场景，快速给长区间或线路特别多的场景。
type SampleTier = "full" | "standard" | "fast";
const SAMPLE_TIERS: readonly { value: SampleTier; label: string; points: number }[] = [
  { value: "full", label: "全量", points: 480 },
  { value: "standard", label: "标准", points: 160 },
  { value: "fast", label: "快速", points: 80 },
];
const LOSS_MARK_MODES: readonly { value: LossMarkMode; label: string }[] = [
  { value: "band", label: "色带" },
  { value: "line", label: "竖线" },
  { value: "off", label: "隐藏" },
];

// 纵轴起点。从 0 起能看出延迟的绝对量级——基线低的线路就是贴着底的一条平线，
// 尖峰才会窜起来；自适应放大到 [min, max] 区间看细节，但基线稳定时几毫秒的正常抖动
// 也会被放大成剧烈起伏，容易误判成线路不稳。
type YAxisMode = "zero" | "auto";
const Y_AXIS_MODES: readonly { value: YAxisMode; label: string }[] = [
  { value: "zero", label: "从0起" },
  { value: "auto", label: "自适应" },
];
// 从 0 起时顶部留的余量，只为让最高的尖峰不贴着上边框。
const Y_AXIS_ZERO_HEADROOM = 1.04;
// 顶部 padding 的基础值，色带模式下还要再加上色带自身的高度。
const CHART_PADDING_TOP = 10;
// 图例一律铺开显示，保证图上每条线都能在图例里找到对应。只有铺开后超过这个行数
// 才给一个收起入口，免得线路特别多时把图表挤到屏幕外。
const LEGEND_COLLAPSED_ROWS = 2;
const LEGEND_ROW_GAP = 8;

/**
 * 图例折叠的几何计算。rowHeight 由实际渲染的 chip 测得(字号、缩放都会影响它)，
 * 没测到时返回 overflows=false，让图例保持完全铺开——宁可高一点，也不要因为算错高度
 * 把内容切掉半行。
 */
export function legendCollapseGeometry(
  contentHeight: number,
  rowHeight: number,
  maxRows = LEGEND_COLLAPSED_ROWS,
  rowGap = LEGEND_ROW_GAP,
): { overflows: boolean; collapsedHeight: number } {
  if (!(rowHeight > 0) || !(contentHeight > 0) || maxRows <= 0) {
    return { overflows: false, collapsedHeight: 0 };
  }
  const collapsedHeight = rowHeight * maxRows + rowGap * (maxRows - 1);
  // 留 1px 容差：子像素行高下 contentHeight 常比理论值大零点几，不该因此冒出收起按钮。
  return { overflows: contentHeight > collapsedHeight + 1, collapsedHeight };
}
/**
 * 丢弃已经不存在的线路的隐藏状态，保持引用不变以免触发无谓重渲染。
 *
 * tasks 为空时原样返回：切换时间范围会换 queryKey，新数据到达前 tasks 是空数组，
 * 那是"还没加载"而不是"任务都被删了"——按后者处理会把用户选好的筛选一起清掉。
 */
export function pruneHiddenTasks<T extends { id: number }>(
  hidden: Set<number>,
  tasks: readonly T[],
): Set<number> {
  if (tasks.length === 0 || hidden.size === 0) return hidden;
  const validIds = new Set(tasks.map((task) => task.id));
  const next = new Set([...hidden].filter((taskId) => validIds.has(taskId)));
  return next.size === hidden.size ? hidden : next;
}

// 1 即关闭平滑(smoothByCount 对 <=1 原样返回);保留常量便于调参,非削峰模式当前不平滑。
const SMOOTH_WINDOW_POINTS = 1;
const SMOOTH_WINDOW_POINTS_PEAK = 13;

export function PingChart({
  uuid,
  hours,
  active = true,
}: {
  uuid: string;
  hours: number;
  active?: boolean;
}) {
  const {
    data,
    isError,
    isFetching,
    isLoading,
    refetch: refetchRecords,
  } = usePingRecords(uuid, hours, active);
  // stats 随 records 同一次请求返回(getPingRecords includeStats),不再单独发起查询。
  const pingStats = data?.stats ?? EMPTY_PING_STATS;
  const { resolvedAppearance } = usePreferences();
  const { w, h, ref: chartSizeRef } = useResponsiveChartSize("wide");
  const [hiddenTasks, setHiddenTasks] = useState<Set<number>>(new Set());
  const [connectNulls, setConnectNulls] = useState(false);
  const [cutPeak, setCutPeak] = useState(false);
  const [lossMarkMode, setLossMarkMode] = useState<LossMarkMode>("band");
  const [showExtremePins, setShowExtremePins] = useState(true);
  const [sampleTier, setSampleTier] = useState<SampleTier>("standard");
  const [yAxisMode, setYAxisMode] = useState<YAxisMode>("zero");
  const [legendCollapsed, setLegendCollapsed] = useState(false);
  const [legendMetrics, setLegendMetrics] = useState({ contentHeight: 0, rowHeight: 0 });
  const legendRef = useRef<HTMLDivElement>(null);
  const legendRegionId = useId();
  const [zoomWindow, setZoomWindow] = useState<ChartZoomWindow>(FULL_ZOOM_WINDOW);
  const chartRef = useRef<uPlot.AlignedData>([[]]);
  // 缩放、覆盖层和丢包率都通过 ref 喂给 uPlot，让 options 对象保持稳定引用——
  // 否则每拖一下滑块 uplot-react 就会销毁重建图表，入场动画会反复重放。
  const plotRef = useRef<uPlot | null>(null);
  const xRangeRef = useRef<[number, number]>([0, 1]);
  const fullXRangeRef = useRef<[number, number] | null>(null);
  const yRangeRef = useRef<[number, number]>([0, 100]);
  const overlaysRef = useRef<PingSeriesOverlay[]>([]);
  const lossByTaskRef = useRef<Map<number, number>>(new Map());
  const overlayFlagsRef = useRef({ lossMarkMode, showExtremePins });
  const yAxisModeRef = useRef<YAxisMode>(yAxisMode);
  const bucketsRef = useRef<Array<Array<MetricBucketStat | null>> | null>(null);
  const applyZoomRef = useRef<(next: ChartZoomWindow) => void>(() => {});
  const [tooltip, setTooltip] = useState<ChartTooltipState>({
    show: false,
    left: 0,
    top: 0,
    rows: [],
    time: "",
  });
  const isDark = resolvedAppearance === "dark";
  const maxRenderPoints =
    SAMPLE_TIERS.find((tier) => tier.value === sampleTier)?.points ?? 160;
  // API 顺序与后台任务权重一致，响应本身不一定包含可重排的权重。
  const tasks = useMemo(() => [...(data?.tasks ?? [])], [data]);
  const taskLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const label = task.name || `任务 #${task.id}`;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return new Map(
      tasks.map((task) => {
        const baseLabel = task.name || `任务 #${task.id}`;
        const label = (counts.get(baseLabel) ?? 0) > 1 ? `${baseLabel} #${task.id}` : baseLabel;
        return [task.id, label] as const;
      }),
    );
  }, [tasks]);
  const taskColors = useMemo(
    () => new Map(tasks.map((task, index) => [task.id, colorForSeries(index, tasks.length)] as const)),
    [tasks],
  );
  const taskKeySet = useMemo(() => new Set(tasks.map((task) => String(task.id))), [tasks]);
  const taskKeys = useMemo(() => tasks.map((task) => String(task.id)), [tasks]);
  const taskIndexById = useMemo(
    () => new Map(tasks.map((task, index) => [task.id, index] as const)),
    [tasks],
  );
  const visibleTasks = useMemo(
    () => tasks.filter((task) => !hiddenTasks.has(task.id)),
    [hiddenTasks, tasks],
  );
  const visibleTaskIds = useMemo(
    () => new Set(visibleTasks.map((task) => task.id)),
    [visibleTasks],
  );

  useEffect(() => {
    setHiddenTasks(new Set());
    setLegendCollapsed(false);
  }, [uuid]);

  useEffect(() => {
    setHiddenTasks((prev) => pruneHiddenTasks(prev, tasks));
  }, [tasks]);

  // 只依赖 data:切换削峰等开关时不重跑解析/排序。
  const sortedRecords = useMemo(
    () =>
      (data?.records ?? [])
        .map((record) => ({
          record,
          time: toChartSeconds(record.time),
        }))
        .filter(({ time }) => time > 0)
        .sort((left, right) => left.time - right.time),
    [data],
  );

  const chartBundle = useMemo(() => {
    if (!data?.records.length || !tasks.length) return null;
    const pointMap = new Map<number, TimedMetricPoint>();
    const taskIntervals = tasks
      .map((task) => task.interval)
      .filter((value): value is number => typeof value === "number" && value > 0);
    const detectedInterval = detectTypicalIntervalSeconds(
      sortedRecords.map(({ time }) => time),
      60,
    );
    const fallbackInterval = resolvePingChartInterval(
      data.intervalSeconds,
      taskIntervals.length > 0 ? Math.min(...taskIntervals) : null,
      detectedInterval,
    );
    const tolerance = Math.min(6, Math.max(0.8, fallbackInterval * 0.25));

    // 升序游标把邻近任务采样合并到同一时间锚点，保持 O(n)。
    let lastAnchor = Number.NEGATIVE_INFINITY;
    for (const { record, time } of sortedRecords) {
      if (!taskKeySet.has(String(record.task_id))) continue;
      const anchor = time - lastAnchor <= tolerance ? lastAnchor : time;
      if (anchor === time) lastAnchor = time;
      const current = pointMap.get(anchor) ?? { time: anchor };
      // 0 是亚毫秒成功，负值才表示丢包。
      current[String(record.task_id)] = record.value >= 0 ? record.value : null;
      pointMap.set(anchor, current);
    }

    let chartPoints = [...pointMap.values()].sort((a, b) => a.time - b.time);
    if (cutPeak && taskKeys.length > 0) {
      chartPoints = cutPeakValues(chartPoints, taskKeys);
    }
    chartPoints = insertMetricGapSentinels(chartPoints, {
      intervals: new Map(
        tasks.map((task) => [
          String(task.id),
          resolvePingChartInterval(data.intervalSeconds, task.interval, fallbackInterval),
        ] as const),
      ),
      defaultInterval: fallbackInterval,
      matchToleranceRatio: 0.25,
    });
    const times = chartPoints.map((point) => point.time);
    // undefined 表示错相采样，null 表示真实断点。
    const perTask = taskKeys.map((taskKey) =>
      chartPoints.map((point) => point[taskKey]),
    );

    const reduced = downsampleAligned(times, perTask, maxRenderPoints, !cutPeak);
    const smoothed = smoothByCount(
      reduced.perTask,
      cutPeak ? SMOOTH_WINDOW_POINTS_PEAK : SMOOTH_WINDOW_POINTS,
    );

    return {
      data: [reduced.times, ...smoothed] as uPlot.AlignedData,
      buckets: reduced.buckets,
    };
  }, [cutPeak, data, maxRenderPoints, sortedRecords, taskKeySet, taskKeys, tasks]);

  const chart = chartBundle?.data ?? null;

  useEffect(() => {
    if (chart) chartRef.current = chart;
  }, [chart]);

  // 桶统计走 ref：它只在 tooltip 现算时被读到，不该让整个 options 因它重建。
  bucketsRef.current = chartBundle?.buckets ?? null;

  const requestedXRange = useMemo(() => historyChartRangeSeconds(data), [data]);
  const coverageMeta = useMemo(() => {
    if (!data) return null;
    const taskIntervals = tasks
      .map((task) => task.interval)
      .filter((value) => Number.isFinite(value) && value > 0);
    return {
      rangeStartMs: data.rangeStartMs,
      rangeEndMs: data.rangeEndMs,
      intervalSeconds:
        data.intervalSeconds ??
        (taskIntervals.length > 0 ? Math.min(...taskIntervals) : undefined),
    };
  }, [data, tasks]);
  const coverageLabel = useMemo(() => {
    const times = chart?.[0];
    if (!times?.length) return null;
    return historyCoverageLabel(coverageMeta, times[0], times[times.length - 1]);
  }, [chart, coverageMeta]);

  // 时间轴的完整跨度：优先用后端声明的请求区间，缺失时退回实际数据首尾。
  // 缩放窗口是它的比例切片，主图 x scale 只由这里派生。
  const fullXRange = useMemo<[number, number] | null>(() => {
    if (requestedXRange) return requestedXRange;
    const times = chart?.[0];
    if (!times?.length) return null;
    const start = times[0];
    const end = times[times.length - 1];
    return end > start ? [start, end] : null;
  }, [chart, requestedXRange]);

  const zoomedXRange = useMemo<[number, number] | null>(
    () => (fullXRange ? zoomWindowToRange(fullXRange, zoomWindow) : null),
    [fullXRange, zoomWindow],
  );

  // 可见区间内一个点都没有时退回 null，让下游按「整段」处理而不是按空区间处理。
  const visibleIndexRange = useMemo(() => {
    const times = chart?.[0];
    if (!times?.length || !zoomedXRange) return null;
    const range = zoomWindowIndexRange(times as ReadonlyArray<number>, zoomedXRange);
    return range.toIndex >= 0 ? range : null;
  }, [chart, zoomedXRange]);

  const overlays = useMemo<PingSeriesOverlay[]>(() => {
    if (!chart) return [];
    return tasks
      .filter((task) => visibleTaskIds.has(task.id))
      .map((task) => {
        const seriesIndex = (taskIndexById.get(task.id) ?? 0) + 1;
        const values = (chart[seriesIndex] ?? []) as ReadonlyArray<number | null | undefined>;
        return buildPingSeriesOverlay(
          values,
          taskColors.get(task.id) ?? colorForSeries(seriesIndex - 1, tasks.length),
          visibleIndexRange ?? undefined,
        );
      });
  }, [chart, taskColors, taskIndexById, tasks, visibleIndexRange, visibleTaskIds]);

  // y 轴跟随可见区间重算：放大到某一小段后，纵向也应该铺满这段的量级，
  // 否则缩放只是横向拉伸，看不清细节。
  const yRange = useMemo<[number, number]>(() => {
    if (!chart) return [0, 100];
    const fromIndex = visibleIndexRange?.fromIndex ?? 0;
    const toIndex = visibleIndexRange?.toIndex ?? (chart[0]?.length ?? 1) - 1;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < tasks.length; index += 1) {
      if (!visibleTaskIds.has(tasks[index].id)) continue;
      const series = chart[index + 1] as Array<number | null | undefined> | undefined;
      if (!series) continue;
      for (let cursor = fromIndex; cursor <= toIndex; cursor += 1) {
        const value = series[cursor];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
    }
    if (min === Number.POSITIVE_INFINITY) return [0, 100];
    if (yAxisMode === "zero") {
      return [0, Math.max(max * Y_AXIS_ZERO_HEADROOM, 1)];
    }
    if (min === max) {
      const pad = Math.max(5, min * 0.1);
      return [Math.max(0, min - pad), max + pad];
    }
    const pad = Math.max(5, (max - min) * 0.12);
    return [Math.max(0, min - pad), max + pad];
  }, [chart, tasks, visibleIndexRange, visibleTaskIds, yAxisMode]);

  // 这些 ref 必须在 render 期间对齐：uPlot 挂载那一帧就会调用 scales 的 range() 和 draw hook，
  // 放到 effect 里赋值会晚一帧，首帧会用上一轮(甚至初始占位)的区间和覆盖层画一次。
  overlaysRef.current = overlays;
  overlayFlagsRef.current = { lossMarkMode, showExtremePins };
  fullXRangeRef.current = fullXRange;
  yAxisModeRef.current = yAxisMode;
  if (zoomedXRange) xRangeRef.current = zoomedXRange;
  yRangeRef.current = yRange;

  useEffect(() => {
    plotRef.current?.redraw();
  }, [overlays, showExtremePins, lossMarkMode]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    // scales 的 range 函数会读上面的 ref 覆盖这里传入的值；传当前值只是为了触发一次重算。
    if (zoomedXRange) plot.setScale("x", { min: zoomedXRange[0], max: zoomedXRange[1] });
    plot.setScale("y", { min: yRange[0], max: yRange[1] });
  }, [yRange, zoomedXRange]);

  // 换节点或换时间范围后旧的缩放窗口不再有意义，回到全量。
  useEffect(() => {
    setZoomWindow(FULL_ZOOM_WINDOW);
  }, [hours, uuid]);

  const applyZoomWindow = useCallback((next: ChartZoomWindow) => {
    setZoomWindow(clampZoomWindow(next));
  }, []);

  const resetZoomWindow = useCallback(() => setZoomWindow(FULL_ZOOM_WINDOW), []);

  applyZoomRef.current = applyZoomWindow;

  const baseOptions = useMemo<Omit<uPlot.Options, "width" | "height"> | null>(() => {
    if (!chart) return null;
    const { grid, text } = getAxisColors(isDark);
    const tooltipHooks = buildChartTooltipHooks({
      dataRef: chartRef,
      rangeHours: hours,
      // 带桶统计的行比原来长不少，宽度估小了浮层会在贴近右边缘时算错翻转位置。
      estimatedWidth: 240,
      setTooltip,
      buildRows: (idx) =>
        visibleTasks
          .map((task) => {
            const taskIndex = taskIndexById.get(task.id) ?? 0;
            const raw = chartRef.current[taskIndex + 1]?.[idx] as number | null | undefined;
            return {
              taskId: task.id,
              taskIndex,
              label: taskLabels.get(task.id) ?? `任务 #${task.id}`,
              raw: typeof raw === "number" && Number.isFinite(raw) ? raw : null,
              color: taskColors.get(task.id) ?? colorForSeries(taskIndex, tasks.length),
            };
          })
          .sort((a, b) => {
            if (a.raw == null) return b.raw == null ? 0 : 1;
            if (b.raw == null) return -1;
            return b.raw - a.raw;
          })
          .map(({ label, raw, color, taskId, taskIndex }) => {
            // 对标哪吒服务监控图的图例格式「名称 丢包%: 延迟 ms」，
            // 悬停时不用回头去看图例就知道这条线当前的健康度。
            const loss = lossByTaskRef.current.get(taskId);
            const bucket = bucketsRef.current?.[taskIndex]?.[idx] ?? null;
            return {
              label: loss == null ? label : `${label} ${loss.toFixed(1)}%`,
              value: raw == null ? "—" : `${raw.toFixed(1)} ms`,
              color,
              // 这一格背后压了多次探测时才有意义：单次采样的 min/max/avg 就是它自己。
              note:
                bucket && bucket.count > 1
                  ? `均 ${bucket.avg.toFixed(1)} / 低 ${bucket.min.toFixed(1)} / 高 ${bucket.max.toFixed(1)} ms · ${bucket.count} 次`
                  : undefined,
            };
          }),
    });
    return {
      // 色带占用顶部 padding，绘图区要相应下移，否则色带会盖在曲线上。
      padding: [
        CHART_PADDING_TOP +
          (lossMarkMode === "band" ? lossBandHeight(visibleTasks.length) : 0),
        14,
        12,
        2,
      ],
      // setScale: false —— 拖拽出的选区交给 setSelect hook 换算成缩放窗口，
      // 由窗口统一驱动 x scale，避免 uPlot 自缩放与滑块两套状态打架。
      // dist 要求先拖够 8px 才算选区，否则想点一下图表却抖了两像素就会意外缩放。
      cursor: { drag: { x: true, y: false, setScale: false, dist: 8 } },
      legend: { show: false },
      scales: {
        x: { time: true, auto: false, range: () => xRangeRef.current },
        y: { auto: false, range: () => yRangeRef.current },
      },
      axes: [
        {
          stroke: text,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid },
          size: 36,
          values: createTimeAxisFormatter(hours),
        },
        {
          stroke: text,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid },
          size: 54,
          // 自适应模式下轴基本不会正好落在 0，出现 0 说明贴着底、标签会和 x 轴挤在一起，
          // 所以隐藏；从 0 起时 0 是有意义的基准刻度，要显示。
          values: (_self, splits) =>
            splits.map((value) =>
              value === 0 && yAxisModeRef.current !== "zero" ? "" : `${Math.round(value)} ms`,
            ),
        },
      ],
      series: [
        { label: "time" },
        ...tasks.map((task, index) => ({
          label: taskLabels.get(task.id) ?? `任务 #${task.id}`,
          stroke: taskColors.get(task.id) ?? colorForSeries(index, tasks.length),
          width: 1.7,
          spanGaps: connectNulls,
          show: !hiddenTasks.has(task.id),
          points: { show: false },
        })),
      ],
      hooks: {
        init: [
          (u) => {
            u.root.setAttribute("role", "img");
            u.root.setAttribute("aria-label", `Ping 延迟历史图表，共 ${tasks.length} 条线路`);
          },
          tooltipHooks.onInit,
        ],
        destroy: [tooltipHooks.onDestroy],
        setCursor: [tooltipHooks.onSetCursor],
        draw: [
          (u) => {
            drawPingOverlay(u, overlaysRef.current, overlayFlagsRef.current);
          },
        ],
        setSelect: [
          (u) => {
            if (u.select.width <= 0) return;
            const full = fullXRangeRef.current;
            const from = u.posToVal(u.select.left, "x");
            const to = u.posToVal(u.select.left + u.select.width, "x");
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            if (!full) return;
            applyZoomRef.current(rangeToZoomWindow(full, [from, to]));
          },
        ],
      },
    };
    // lossMarkMode 只在这里影响 padding；覆盖层本身走 ref，不需要重建图表。
  }, [chart, connectNulls, hiddenTasks, hours, isDark, lossMarkMode, taskColors, taskIndexById, taskLabels, tasks, visibleTasks]);

  const options = useMemo<uPlot.Options | null>(
    () => (baseOptions ? { ...baseOptions, width: w, height: h } : null),
    [baseOptions, w, h],
  );

  const taskStats = useMemo(() => {
    const grouped = new Map<number, PingRecord[]>();
    // 复用已按时间升序的 sortedRecords,分组后桶内天然有序,免去逐桶重排序和重复 Date.parse。
    for (const { record } of sortedRecords) {
      const bucket = grouped.get(record.task_id);
      if (bucket) bucket.push(record);
      else grouped.set(record.task_id, [record]);
    }

    const serverStats = new Map(
      pingStats
        .filter((stat) => !stat.client || stat.client === uuid)
        .map((stat) => [stat.taskId, stat] as const),
    );

    return tasks.map((task, index) => {
      const records = grouped.get(task.id) ?? [];
      const server = serverStats.get(task.id);
      // server stats 命中时跳过本地全量统计(排序/分位数不便宜)。
      const fallback = server ? null : summarizePingRecords(records);
      const latest = server ? server.latest : fallback?.latest ?? null;
      const avg = server ? server.avg : fallback?.avg ?? null;
      const min = server ? server.min : fallback?.min ?? null;
      const max = server ? server.max : fallback?.max ?? null;
      const p50 = server ? server.p50 : fallback?.p50 ?? null;
      const p99 = server ? server.p99 : fallback?.p99 ?? null;
      const fallbackVolatility =
        p50 != null && p99 != null
          ? Math.max(0, p99 - p50) / Math.min(50, Math.max(10, p50))
          : null;
      const volatility =
        server && Number.isFinite(server.p99P50Ratio)
          ? server.p99P50Ratio
          : fallbackVolatility;
      const total = server?.total ?? fallback?.total ?? 0;
      const lost = server
        ? Math.max(0, server.total - server.valid)
        : fallback?.lost ?? 0;
      const loss = server?.loss ?? (total > 0 ? fallback?.loss ?? 0 : task.loss);
      return {
        ...task,
        latest,
        avg,
        min,
        max,
        p50,
        p99,
        volatility,
        total,
        lost,
        loss,
        color: taskColors.get(task.id) ?? colorForSeries(index, tasks.length),
      };
    });
  }, [pingStats, sortedRecords, taskColors, tasks, uuid]);

  const lossByTask = useMemo(
    () => new Map(taskStats.map((task) => [task.id, task.loss])),
    [taskStats],
  );
  // 同上：tooltip 的行是在 uPlot 的 hook 里现算的，走 ref 才能读到最新丢包率
  // 而不必让整个 options 依赖 taskStats。
  lossByTaskRef.current = lossByTask;

  // 缩放条的缩略曲线直接复用主图已降采样的数据，两者不会出现形状对不上的情况。
  const previewSeries = useMemo<ChartRangePreviewSeries[]>(() => {
    if (!chart) return [];
    return visibleTasks.map((task) => {
      const seriesIndex = (taskIndexById.get(task.id) ?? 0) + 1;
      return {
        values: (chart[seriesIndex] ?? []) as ReadonlyArray<number | null | undefined>,
        color: taskColors.get(task.id) ?? colorForSeries(seriesIndex - 1, tasks.length),
      };
    });
  }, [chart, taskColors, taskIndexById, tasks.length, visibleTasks]);

  // 收起时容器被 max-height 限制，ResizeObserver 不会再因内容换行而触发，所以额外挂 window
  // resize：窗口变窄导致图例多占一行时，收起态下也要重新判断还需不需要收起入口。
  useEffect(() => {
    const container = legendRef.current;
    if (!container) return;
    const measure = () => {
      const firstChip = container.querySelector<HTMLElement>(".instance-ping-task");
      const next = {
        contentHeight: container.scrollHeight,
        rowHeight: firstChip?.offsetHeight ?? 0,
      };
      setLegendMetrics((prev) =>
        prev.contentHeight === next.contentHeight && prev.rowHeight === next.rowHeight
          ? prev
          : next,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(container);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [taskStats.length]);

  const legendGeometry = legendCollapseGeometry(
    legendMetrics.contentHeight,
    legendMetrics.rowHeight,
  );
  // 线路减少到放得下之后，收起状态自动失效——不必额外 effect 去同步它。
  const legendIsCollapsed = legendCollapsed && legendGeometry.overflows;

  const refetchAll = () => {
    void refetchRecords();
  };

  const toggleTask = (taskId: number) => {
    setHiddenTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const toggleAll = () => {
    setHiddenTasks((prev) => (prev.size === 0 ? new Set(tasks.map((task) => task.id)) : new Set()));
  };

  if (isLoading) {
    return <InstanceChartLoading title="Ping 图表" />;
  }

  if (isError && !data?.records.length) {
    return (
      <InstancePanel title="Ping 图表">
        <div className="instance-empty">
          <span>延迟历史加载失败</span>
          <button
            type="button"
            className="instance-toggle-button"
            onClick={refetchAll}
            disabled={isFetching}
            aria-busy={isFetching}
          >
            {isFetching ? "重试中" : "重试"}
          </button>
        </div>
      </InstancePanel>
    );
  }

  if (!data?.records.length) {
    return (
      <InstancePanel title="Ping 图表">
        <div className="instance-empty">暂无延迟记录</div>
      </InstancePanel>
    );
  }

  return (
    <InstancePanel title="Ping 图表" description={coverageLabel ?? undefined}>
      <div className="instance-ping-toolbar">
        <SwitchToggle
          label="削峰平滑"
          active={cutPeak}
          onToggle={() => setCutPeak((value) => !value)}
          title="对尖峰值做轻度平滑，仅影响图线显示"
        />
        <SwitchToggle
          label="断点连线"
          active={connectNulls}
          onToggle={() => setConnectNulls((value) => !value)}
          title="关闭：如实显示中断/丢包断点；开启：跨过所有空缺连成完整曲线（更好看，但看不出掉线）。注：偶尔漏一两次采样的小空缺始终自动桥接，不受此开关影响。"
        />
        <CycleToggle
          label="丢包"
          options={LOSS_MARK_MODES}
          value={lossMarkMode}
          onChange={setLossMarkMode}
          title="色带：丢包画在图上方的独立横带里，不遮挡曲线；竖线：在丢包时刻直接立一条同色竖线；隐藏：不标记"
        />
        <CycleToggle
          label="采样"
          options={SAMPLE_TIERS}
          value={sampleTier}
          onChange={setSampleTier}
          title="图上保留多少个数据点。全量最细但线更跳，快速最平滑但会吞掉短暂尖峰"
        />
        <CycleToggle
          label="纵轴"
          options={Y_AXIS_MODES}
          value={yAxisMode}
          onChange={setYAxisMode}
          title="从0起：看延迟的绝对量级，线路稳定时就是一条贴底的平线；自适应：放大到实际区间看细节，但正常的小幅抖动也会被放大"
        />
        <SwitchToggle
          label="极值标记"
          active={showExtremePins}
          onToggle={() => setShowExtremePins((value) => !value)}
          title="在每条线当前可见区间的最高/最低点标出数值气泡"
        />
        <button type="button" className="instance-toggle-button" onClick={toggleAll}>
          {hiddenTasks.size === 0 ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
          {hiddenTasks.size === 0 ? "隐藏全部" : "显示全部"}
        </button>
        <button
          type="button"
          className="instance-toggle-button"
          onClick={refetchAll}
          disabled={isFetching}
          aria-busy={isFetching}
        >
          <RefreshCw size={14} aria-hidden />
          {isFetching ? "刷新中" : isError ? "刷新失败，重试" : "刷新"}
        </button>
      </div>

      <div
        ref={legendRef}
        id={legendRegionId}
        className="instance-ping-tasks"
        data-collapsed={legendIsCollapsed ? "true" : "false"}
        style={
          legendIsCollapsed ? { maxHeight: legendGeometry.collapsedHeight } : undefined
        }
      >
        {taskStats.map((task) => {
          const visible = !hiddenTasks.has(task.id);
          const label = taskLabels.get(task.id) ?? `任务 #${task.id}`;
          return (
            <div
              key={task.id}
              className="instance-ping-task"
              data-visible={visible ? "true" : "false"}
              style={{ borderColor: visible ? task.color : "var(--border-subtle)" }}
            >
              <button
                type="button"
                className="instance-ping-task-main"
                aria-pressed={visible}
                onClick={() => toggleTask(task.id)}
              >
                <span className="instance-ping-task-dot" style={{ background: task.color }} aria-hidden />
                <span className="instance-ping-task-name">{label}</span>
                <span
                  className="instance-ping-task-primary"
                  style={{
                    color:
                      task.latest != null
                        ? latencyHeatColor(task.latest)
                        : "var(--text-tertiary)",
                  }}
                >
                  {task.latest != null ? `${task.latest.toFixed(1)} ms` : "—"}
                </span>
                <span
                  className="instance-ping-task-loss"
                  style={{ color: lossHeatColor(task.loss) }}
                >
                  {task.loss.toFixed(1)}%
                </span>
              </button>
              <PingTaskStatsPopover
                stat={{
                  name: label,
                  type: task.type,
                  target: task.target,
                  interval: task.interval,
                  latest: task.latest,
                  avg: task.avg,
                  min: task.min,
                  max: task.max,
                  p50: task.p50,
                  p99: task.p99,
                  volatility: task.volatility,
                  total: task.total,
                  lost: task.lost,
                  loss: task.loss,
                }}
              />
            </div>
          );
        })}
      </div>

      {legendGeometry.overflows && (
        <div className="instance-legend-toggle-row">
          <button
            type="button"
            className="instance-toggle-button instance-legend-toggle"
            onClick={() => setLegendCollapsed((value) => !value)}
            aria-expanded={!legendIsCollapsed}
            aria-controls={legendRegionId}
          >
            {legendIsCollapsed ? (
              <>
                <ChevronDown size={14} aria-hidden />
                展开全部 {taskStats.length} 条
              </>
            ) : (
              <>
                <ChevronUp size={14} aria-hidden />
                收起
              </>
            )}
          </button>
        </div>
      )}

      <div ref={chartSizeRef} className="instance-uplot-wrap is-large">
        {chart && options && visibleTasks.length > 0 ? (
          <>
            <UplotReact
              key={`${uuid}-${hours}-${cutPeak ? "smooth" : "raw"}-${connectNulls ? "span" : "gap"}`}
              options={options}
              data={chart}
              onCreate={(plot) => {
                plotRef.current = plot;
              }}
              onDelete={() => {
                plotRef.current = null;
              }}
            />
            <ChartTooltip tooltip={tooltip} />
          </>
        ) : (
          <div className="instance-empty">当前已隐藏全部线路，点击上方按钮可恢复显示</div>
        )}
      </div>

      {chart && options && visibleTasks.length > 0 && fullXRange && (
        <ChartRangeSlider
          window={zoomWindow}
          series={previewSeries}
          onChange={applyZoomWindow}
          onReset={resetZoomWindow}
        />
      )}
    </InstancePanel>
  );
}
