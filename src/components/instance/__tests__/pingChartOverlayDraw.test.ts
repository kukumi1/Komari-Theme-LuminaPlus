import { describe, expect, it } from "vitest";
import type uPlot from "uplot";
import {
  buildPingSeriesOverlay,
  drawPingOverlay,
  type PingSeriesOverlay,
} from "@/components/instance/pingChartOverlay";

interface CanvasCall {
  method: string;
  args: unknown[];
}

interface TrackedCanvasState {
  globalAlpha: number;
  lineWidth: number;
  strokeStyle: string;
  fillStyle: string;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
}

const INITIAL_CANVAS_STATE: TrackedCanvasState = {
  globalAlpha: 1,
  lineWidth: 1,
  strokeStyle: "",
  fillStyle: "",
  font: "",
  textAlign: "start",
  textBaseline: "alphabetic",
};

// save/restore 必须真的还原绘制状态，否则「透明度有没有泄漏」这类断言测的是 double 自己。
function fakeContext() {
  const calls: CanvasCall[] = [];
  const stack: TrackedCanvasState[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const ctx = {
    ...INITIAL_CANVAS_STATE,
    calls,
    save() {
      calls.push({ method: "save", args: [] });
      stack.push({
        globalAlpha: ctx.globalAlpha,
        lineWidth: ctx.lineWidth,
        strokeStyle: ctx.strokeStyle,
        fillStyle: ctx.fillStyle,
        font: ctx.font,
        textAlign: ctx.textAlign,
        textBaseline: ctx.textBaseline,
      });
    },
    restore() {
      calls.push({ method: "restore", args: [] });
      const snapshot = stack.pop();
      if (snapshot) Object.assign(ctx, snapshot);
    },
    beginPath: record("beginPath"),
    closePath: record("closePath"),
    rect: record("rect"),
    fillRect: record("fillRect"),
    clip: record("clip"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    arc: record("arc"),
    stroke: record("stroke"),
    fill: record("fill"),
    fillText: record("fillText"),
  };
  return ctx;
}

// x 直接当像素用；y 翻转成「值越大越靠上」，与真实图表一致。
function fakePlot(times: number[], ctx: ReturnType<typeof fakeContext>) {
  return {
    ctx,
    data: [times] as unknown as uPlot.AlignedData,
    bbox: { left: 0, top: 0, width: 400, height: 200 },
    over: { clientWidth: 400 },
    valToPos: (value: number, scaleKey: string) =>
      scaleKey === "x" ? value : 200 - value,
  } as unknown as uPlot;
}

function callsOf(ctx: ReturnType<typeof fakeContext>, method: string) {
  return ctx.calls.filter((call) => call.method === method);
}

describe("drawPingOverlay", () => {
  const times = [0, 10, 20, 30];

  it("为每个丢包点画一条竖线", () => {
    const ctx = fakeContext();
    const overlay = buildPingSeriesOverlay([5, null, 8, null], "#f00");

    drawPingOverlay(fakePlot(times, ctx), [overlay], {
      lossMarkMode: "line",
      showExtremePins: false,
    });

    const moves = callsOf(ctx, "moveTo");
    expect(moves).toHaveLength(2);
    expect(moves.map((call) => call.args[0])).toEqual([10.5, 30.5]);
    expect(callsOf(ctx, "fillText")).toHaveLength(0);
  });

  it("为极值画出带取整数值的 pin", () => {
    const ctx = fakeContext();
    const overlay = buildPingSeriesOverlay([5.4, 120.6, 60, 30], "#f00");

    drawPingOverlay(fakePlot(times, ctx), [overlay], {
      lossMarkMode: "off",
      showExtremePins: true,
    });

    expect(callsOf(ctx, "fillText").map((call) => call.args[0])).toEqual(["121", "5"]);
    expect(callsOf(ctx, "arc")).toHaveLength(2);
  });

  it("两项都关闭时不碰画布", () => {
    const ctx = fakeContext();
    const overlay = buildPingSeriesOverlay([5, null], "#f00");

    drawPingOverlay(fakePlot(times, ctx), [overlay], {
      lossMarkMode: "off",
      showExtremePins: false,
    });

    expect(ctx.calls).toHaveLength(0);
  });

  it("没有可见线路时不碰画布", () => {
    const ctx = fakeContext();

    drawPingOverlay(fakePlot(times, ctx), [] as PingSeriesOverlay[], {
      lossMarkMode: "line",
      showExtremePins: true,
    });

    expect(ctx.calls).toHaveLength(0);
  });

  it("色带模式给每条线路画一条轨道，并在丢包处补红点", () => {
    const ctx = fakeContext();
    const first = buildPingSeriesOverlay([5, null, 8, null], "#f00");
    const second = buildPingSeriesOverlay([9, 9, 9, 9], "#00f");

    drawPingOverlay(fakePlot(times, ctx), [first, second], {
      lossMarkMode: "band",
      showExtremePins: false,
    });

    // 2 条轨道 + first 的 2 个丢包点
    expect(callsOf(ctx, "fillRect")).toHaveLength(4);
    expect(callsOf(ctx, "moveTo")).toHaveLength(0);
  });

  it("色带不受竖线抑制影响：几乎全丢时仍然逐点画红块", () => {
    const ctx = fakeContext();
    const overlay = buildPingSeriesOverlay(
      Array.from({ length: 20 }, () => null),
      "#f00",
    );
    const plotTimes = Array.from({ length: 20 }, (_, index) => index);

    expect(overlay.suppressLossLines).toBe(true);

    drawPingOverlay(fakePlot(plotTimes, ctx), [overlay], {
      lossMarkMode: "band",
      showExtremePins: false,
    });

    // 1 条轨道 + 20 个丢包点
    expect(callsOf(ctx, "fillRect")).toHaveLength(21);
  });

  it("竖线模式在几乎全丢时跳过该线路，避免涂实绘图区", () => {
    const ctx = fakeContext();
    const overlay = buildPingSeriesOverlay(
      Array.from({ length: 20 }, () => null),
      "#f00",
    );
    const plotTimes = Array.from({ length: 20 }, (_, index) => index);

    drawPingOverlay(fakePlot(plotTimes, ctx), [overlay], {
      lossMarkMode: "line",
      showExtremePins: false,
    });

    expect(callsOf(ctx, "moveTo")).toHaveLength(0);
  });

  it("save/restore 成对出现，不把裁剪或透明度泄漏给后续绘制", () => {
    const ctx = fakeContext();
    const overlay = buildPingSeriesOverlay([5, null, 90], "#f00");

    drawPingOverlay(fakePlot(times, ctx), [overlay], {
      lossMarkMode: "line",
      showExtremePins: true,
    });

    expect(callsOf(ctx, "save")).toHaveLength(callsOf(ctx, "restore").length);
    expect(callsOf(ctx, "clip")).toHaveLength(1);
    expect(ctx.globalAlpha).toBe(1);
  });
});
