import { describe, expect, it } from "vitest";
import {
  clampZoomWindow,
  FULL_ZOOM_WINDOW,
  isFullZoomWindow,
  panZoomWindow,
  rangeToZoomWindow,
  wheelZoomScale,
  zoomWindowAtAnchor,
  zoomWindowIndexRange,
  zoomWindowToRange,
} from "@/components/instance/chartZoom";

describe("clampZoomWindow", () => {
  it("把反向拖出来的窗口摆正", () => {
    expect(clampZoomWindow({ start: 0.8, end: 0.2 })).toEqual({ start: 0.2, end: 0.8 });
  });

  it("过窄的窗口以中点为锚展开到最小宽度", () => {
    const window = clampZoomWindow({ start: 0.5, end: 0.5 });

    expect(window.end - window.start).toBeCloseTo(0.02, 10);
    expect((window.start + window.end) / 2).toBeCloseTo(0.5, 10);
  });

  it("贴边的过窄窗口向内展开而不越界", () => {
    expect(clampZoomWindow({ start: 0, end: 0.001 })).toEqual({ start: 0, end: 0.02 });
    expect(clampZoomWindow({ start: 0.999, end: 1 })).toEqual({ start: 0.98, end: 1 });
  });

  it("非有限值退回全量窗口", () => {
    expect(clampZoomWindow({ start: Number.NaN, end: 1 })).toEqual(FULL_ZOOM_WINDOW);
  });
});

describe("zoomWindowToRange / rangeToZoomWindow", () => {
  it("比例与绝对区间可以来回换算", () => {
    const full: [number, number] = [1000, 2000];
    const window = { start: 0.25, end: 0.75 };

    expect(zoomWindowToRange(full, window)).toEqual([1250, 1750]);
    expect(rangeToZoomWindow(full, [1250, 1750])).toEqual(window);
  });

  it("零宽的完整轴不做换算", () => {
    expect(zoomWindowToRange([500, 500], { start: 0.2, end: 0.4 })).toEqual([500, 500]);
    expect(rangeToZoomWindow([500, 500], [500, 500])).toEqual(FULL_ZOOM_WINDOW);
  });
});

describe("panZoomWindow", () => {
  it("平移时保持窗口宽度", () => {
    const window = panZoomWindow({ start: 0.2, end: 0.4 }, 0.1);

    expect(window.start).toBeCloseTo(0.3, 10);
    expect(window.end).toBeCloseTo(0.5, 10);
  });

  it("碰到两端贴边停住而不压缩宽度", () => {
    const atStart = panZoomWindow({ start: 0.2, end: 0.4 }, -1);
    const atEnd = panZoomWindow({ start: 0.6, end: 0.8 }, 1);

    expect(atStart.start).toBe(0);
    expect(atStart.end).toBeCloseTo(0.2, 10);
    expect(atEnd.start).toBeCloseTo(0.8, 10);
    expect(atEnd.end).toBe(1);
  });
});

describe("zoomWindowAtAnchor", () => {
  /** 锚点在窗口内的相对位置，换算成占完整时间轴的比例。 */
  const anchorRatio = (window: { start: number; end: number }, anchor: number) =>
    window.start + anchor * (window.end - window.start);

  it("放大时锚点指着的时刻钉在原地", () => {
    const before = { start: 0.2, end: 0.8 };
    const after = zoomWindowAtAnchor(before, 0.25, 0.5);

    expect(after.end - after.start).toBeCloseTo(0.3, 10);
    expect(anchorRatio(after, 0.25)).toBeCloseTo(anchorRatio(before, 0.25), 10);
  });

  it("缩小时锚点同样钉在原地", () => {
    const before = { start: 0.4, end: 0.6 };
    const after = zoomWindowAtAnchor(before, 0.75, 2);

    expect(after.end - after.start).toBeCloseTo(0.4, 10);
    expect(anchorRatio(after, 0.75)).toBeCloseTo(anchorRatio(before, 0.75), 10);
  });

  it("锚点贴边时窗口被推回 [0, 1] 内且不压缩宽度", () => {
    const atStart = zoomWindowAtAnchor({ start: 0, end: 0.2 }, 0, 2);
    const atEnd = zoomWindowAtAnchor({ start: 0.8, end: 1 }, 1, 2);

    expect(atStart).toEqual({ start: 0, end: 0.4 });
    expect(atEnd.start).toBeCloseTo(0.6, 10);
    expect(atEnd.end).toBeCloseTo(1, 10);
  });

  it("放大到最小宽度后不再变窄", () => {
    const window = zoomWindowAtAnchor({ start: 0.5, end: 0.52 }, 0.5, 0.1);

    expect(window.end - window.start).toBeCloseTo(0.02, 10);
  });

  it("已是全量窗口时继续缩小仍是全量", () => {
    expect(zoomWindowAtAnchor(FULL_ZOOM_WINDOW, 0.5, 4)).toEqual(FULL_ZOOM_WINDOW);
  });

  it("非法入参原样返回", () => {
    const window = { start: 0.2, end: 0.8 };

    expect(zoomWindowAtAnchor(window, Number.NaN, 0.5)).toBe(window);
    expect(zoomWindowAtAnchor(window, 0.5, 0)).toBe(window);
    expect(zoomWindowAtAnchor({ start: 0.5, end: 0.5 }, 0.5, 0.5)).toEqual({
      start: 0.5,
      end: 0.5,
    });
  });
});

describe("wheelZoomScale", () => {
  it("向下滚是缩小、向上滚是放大", () => {
    expect(wheelZoomScale(120)).toBeGreaterThan(1);
    expect(wheelZoomScale(-120)).toBeLessThan(1);
  });

  it("鼠标滚一格约 1.2 倍", () => {
    expect(wheelZoomScale(120)).toBeCloseTo(1.2, 10);
  });

  it("一来一回抵消回原样", () => {
    expect(wheelZoomScale(53) * wheelZoomScale(-53)).toBeCloseTo(1, 10);
  });

  it("按 deltaMode 折算行与页", () => {
    expect(wheelZoomScale(7.5, 1)).toBeCloseTo(wheelZoomScale(120), 10);
    expect(wheelZoomScale(0.3, 2)).toBeCloseTo(wheelZoomScale(120), 10);
  });

  it("一次猛滑的位移被封顶", () => {
    expect(wheelZoomScale(99999)).toBeCloseTo(wheelZoomScale(400), 10);
    expect(wheelZoomScale(-99999)).toBeCloseTo(wheelZoomScale(-400), 10);
  });

  it("没有位移或非有限值时倍率为 1", () => {
    expect(wheelZoomScale(0)).toBe(1);
    expect(wheelZoomScale(Number.NaN)).toBe(1);
  });
});

describe("isFullZoomWindow", () => {
  it("识别全量窗口", () => {
    expect(isFullZoomWindow(FULL_ZOOM_WINDOW)).toBe(true);
    expect(isFullZoomWindow({ start: 0, end: 0.9 })).toBe(false);
  });
});

describe("zoomWindowIndexRange", () => {
  it("返回落在区间内的首尾下标", () => {
    expect(zoomWindowIndexRange([10, 20, 30, 40, 50], [20, 40])).toEqual({
      fromIndex: 1,
      toIndex: 3,
    });
  });

  it("区间内没有点时返回空区间", () => {
    expect(zoomWindowIndexRange([10, 20], [100, 200])).toEqual({
      fromIndex: 0,
      toIndex: -1,
    });
    expect(zoomWindowIndexRange([], [0, 1])).toEqual({ fromIndex: 0, toIndex: -1 });
  });
});
