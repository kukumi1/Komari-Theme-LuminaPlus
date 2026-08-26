import type uPlot from "uplot";

// PingChart 的 uPlot 覆盖层：丢包竖线 + 极值 pin。
// 对齐数据里 null = 真实断点(丢包/中断)、undefined = off-phase 无采样，两者语义不同，
// 只有 null 才是「这一刻探测失败」，才值得在图上立一条竖线。

export type ChartSeriesValues = ReadonlyArray<number | null | undefined>;

export interface PingExtremePoint {
  index: number;
  value: number;
}

export interface PingSeriesOverlay {
  color: string;
  lossIndices: number[];
  /**
   * 丢包密到几乎全丢时，竖线会把整个绘图区涂成实色反而读不出信息，此时跳过竖线。
   * 色带不受影响——它画在绘图区之外，整条轨道变红本身就是正确的表达。
   */
  suppressLossLines: boolean;
  max: PingExtremePoint | null;
  min: PingExtremePoint | null;
}

export interface PingOverlayRange {
  fromIndex: number;
  toIndex: number;
}

// 丢包比例超过这个值就不画竖线：整段几乎全丢时逐点画会把绘图区涂成实色，
// 反而什么都读不出来。哪吒面板的服务监控图同款处理(lossRate > 99 时清空 markLine)。
const LOSS_MARK_SUPPRESS_RATIO = 0.99;
// 样本太少时不启用上面的抑制，否则「唯一一次采样正好丢包」会被判成全丢而不画。
const LOSS_MARK_SUPPRESS_MIN_SAMPLES = 10;

export function buildPingSeriesOverlay(
  values: ChartSeriesValues,
  color: string,
  range?: PingOverlayRange,
): PingSeriesOverlay {
  const fromIndex = Math.max(0, range?.fromIndex ?? 0);
  const toIndex = Math.min(values.length - 1, range?.toIndex ?? values.length - 1);
  const lossIndices: number[] = [];
  let max: PingExtremePoint | null = null;
  let min: PingExtremePoint | null = null;
  let validCount = 0;

  for (let index = fromIndex; index <= toIndex; index += 1) {
    const value = values[index];
    if (value === null) {
      lossIndices.push(index);
      continue;
    }
    // 0 是亚毫秒成功探测，负值不该出现在图数据里(上游已转成 null)，一并当作无效跳过。
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    validCount += 1;
    if (max == null || value > max.value) max = { index, value };
    if (min == null || value < min.value) min = { index, value };
  }

  const sampled = validCount + lossIndices.length;

  return {
    color,
    lossIndices,
    suppressLossLines:
      sampled >= LOSS_MARK_SUPPRESS_MIN_SAMPLES &&
      lossIndices.length / sampled > LOSS_MARK_SUPPRESS_RATIO,
    max,
    // 极值相等时只保留 max，避免两个 pin 完全重叠在同一点上。
    min: min != null && max != null && min.index === max.index ? null : min,
  };
}

// 丢包的两种画法：竖线直接压在曲线上，密集时会糊住图；色带把丢包挪到主绘图区上方
// 的独立横带里，完全不侵占曲线的视觉空间。线路少、丢包稀疏时竖线更直观，反之用色带。
export type LossMarkMode = "line" | "band" | "off";

const LOSS_LINE_ALPHA = 0.42;
const LOSS_LINE_WIDTH = 1;

const BAND_OUTER_MARGIN = 6;
const BAND_ROW_GAP = 3;
const BAND_ROW_HEIGHT_MAX = 5;
const BAND_ROW_HEIGHT_MIN = 2;
const BAND_TRACK_ALPHA = 0.3;
const BAND_LOSS_COLOR = "#e5484d";
const BAND_MAX_HEIGHT = 72;

/** 色带占用的高度(CSS px)，主图的顶部 padding 要按它撑开才不会盖住曲线。 */
export function lossBandHeight(rowCount: number): number {
  if (rowCount <= 0) return 0;
  return Math.min(
    BAND_MAX_HEIGHT,
    BAND_OUTER_MARGIN * 2 + rowCount * BAND_ROW_HEIGHT_MAX + (rowCount - 1) * BAND_ROW_GAP,
  );
}

// 线路多到撑破高度上限时压缩行高而不是让色带无限长高，图表本身的空间要优先保住。
function bandRowHeight(rowCount: number): number {
  if (rowCount <= 0) return 0;
  const available = BAND_MAX_HEIGHT - BAND_OUTER_MARGIN * 2 - (rowCount - 1) * BAND_ROW_GAP;
  return Math.max(BAND_ROW_HEIGHT_MIN, Math.min(BAND_ROW_HEIGHT_MAX, available / rowCount));
}
const PIN_RADIUS = 9;
const PIN_TIP = 7;
const PIN_FILL_ALPHA = 0.55;
const PIN_FONT_SIZE = 8;

function pinPath(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  tipLength: number,
  pointingDown: boolean,
) {
  const direction = pointingDown ? 1 : -1;
  // 圆心到切点的夹角：让三角形两边正好贴着圆周，画出水滴形而不是「圆上挂个三角」。
  const spread = Math.PI / 3;
  const base = pointingDown ? Math.PI / 2 : -Math.PI / 2;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, base + spread, base - spread + Math.PI * 2);
  ctx.lineTo(centerX, centerY + direction * (radius + tipLength));
  ctx.closePath();
}

function drawPin(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  value: number,
  color: string,
  ratio: number,
  bbox: uPlot.BBox,
  preferAbove: boolean,
) {
  const radius = PIN_RADIUS * ratio;
  const tipLength = PIN_TIP * ratio;
  const offset = radius + tipLength;
  // 贴着绘图区边缘时把 pin 翻到点的另一侧，避免被裁掉只剩半个气泡。
  const fitsAbove = point.y - offset - radius >= bbox.top;
  const fitsBelow = point.y + offset + radius <= bbox.top + bbox.height;
  const above = preferAbove ? fitsAbove || !fitsBelow : fitsAbove && !fitsBelow;
  const centerY = above ? point.y - offset : point.y + offset;

  ctx.save();
  ctx.globalAlpha = PIN_FILL_ALPHA;
  ctx.fillStyle = color;
  pinPath(ctx, point.x, centerY, radius, tipLength, above);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.font = `600 ${PIN_FONT_SIZE * ratio}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(Math.round(value)), point.x, centerY);
  ctx.restore();
}

// 主绘图区上方的丢包色带：每条线路一条横轨，轨道底色用线路自己的颜色(便于和曲线对应)，
// 探测失败的时刻在轨上打红点。轨道横向与时间轴严格对齐，所以红点的位置可以直接和下方
// 曲线对照着看。
function drawLossBand(
  ctx: CanvasRenderingContext2D,
  u: uPlot,
  overlays: readonly PingSeriesOverlay[],
  ratio: number,
) {
  const times = u.data[0];
  const rowHeight = bandRowHeight(overlays.length) * ratio;
  const rowGap = BAND_ROW_GAP * ratio;
  const left = u.bbox.left;
  const width = u.bbox.width;
  // 从色带底部(紧贴绘图区)往上排，线路顺序与图例一致。
  const bandBottom = u.bbox.top - BAND_OUTER_MARGIN * ratio;
  const dotWidth = Math.max(1.5 * ratio, rowHeight * 0.5);

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, 0, width, u.bbox.top);
  ctx.clip();

  overlays.forEach((overlay, index) => {
    const top = bandBottom - (overlays.length - index) * rowHeight - (overlays.length - 1 - index) * rowGap;

    ctx.globalAlpha = BAND_TRACK_ALPHA;
    ctx.fillStyle = overlay.color;
    ctx.fillRect(left, top, width, rowHeight);

    ctx.globalAlpha = 1;
    ctx.fillStyle = BAND_LOSS_COLOR;
    for (const lossIndex of overlay.lossIndices) {
      const time = times[lossIndex];
      if (typeof time !== "number") continue;
      const x = u.valToPos(time, "x", true);
      ctx.fillRect(x - dotWidth / 2, top, dotWidth, rowHeight);
    }
  });

  ctx.restore();
}

/** 在 uPlot 的 draw hook 中调用：先画丢包标记垫底，再画极值 pin 压在最上层。 */
export function drawPingOverlay(
  u: uPlot,
  overlays: readonly PingSeriesOverlay[],
  options: { lossMarkMode: LossMarkMode; showExtremePins: boolean },
) {
  if (overlays.length === 0) return;
  if (options.lossMarkMode === "off" && !options.showExtremePins) return;

  const ctx = u.ctx;
  const times = u.data[0];
  const ratio = u.bbox.width / Math.max(1, u.over.clientWidth);

  // 色带画在绘图区上方的 padding 里，必须在 clip 之前画，否则会被裁掉。
  if (options.lossMarkMode === "band") {
    drawLossBand(ctx, u, overlays, ratio);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
  ctx.clip();

  if (options.lossMarkMode === "line") {
    ctx.lineWidth = LOSS_LINE_WIDTH * ratio;
    for (const overlay of overlays) {
      if (overlay.suppressLossLines) continue;
      ctx.save();
      ctx.globalAlpha = LOSS_LINE_ALPHA;
      ctx.strokeStyle = overlay.color;
      ctx.beginPath();
      for (const index of overlay.lossIndices) {
        const time = times[index];
        if (typeof time !== "number") continue;
        const x = Math.round(u.valToPos(time, "x", true)) + 0.5;
        ctx.moveTo(x, u.bbox.top);
        ctx.lineTo(x, u.bbox.top + u.bbox.height);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  if (options.showExtremePins) {
    for (const overlay of overlays) {
      for (const extreme of [overlay.max, overlay.min]) {
        if (!extreme) continue;
        const time = times[extreme.index];
        if (typeof time !== "number") continue;
        drawPin(
          ctx,
          {
            x: u.valToPos(time, "x", true),
            y: u.valToPos(extreme.value, "y", true),
          },
          extreme.value,
          overlay.color,
          ratio,
          u.bbox,
          extreme === overlay.max,
        );
      }
    }
  }

  ctx.restore();
}
