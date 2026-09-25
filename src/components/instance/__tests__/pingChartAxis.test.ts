import { describe, expect, it } from "vitest";
import { lossAxisTop, niceAxisTop } from "@/components/instance/PingChart";

describe("niceAxisTop", () => {
  it("向上取整到好读的整刻度", () => {
    expect(niceAxisTop(240)).toBe(250);
    expect(niceAxisTop(82)).toBe(100);
    expect(niceAxisTop(1000)).toBe(1200);
    expect(niceAxisTop(176)).toBe(200);
  });

  it("结果不带浮点尾巴", () => {
    for (const max of [110, 1100, 11000, 45, 450]) {
      const top = niceAxisTop(max);
      expect(Number.isInteger(top)).toBe(true);
    }
  });

  it("留出余量，最高的尖峰不会贴着上边框", () => {
    for (const max of [240, 82, 1000, 33, 199]) {
      expect(niceAxisTop(max)).toBeGreaterThan(max);
    }
  });

  it("整站都是个位数毫秒时守住地板，不把噪声放大回来", () => {
    expect(niceAxisTop(2)).toBe(20);
    expect(niceAxisTop(14)).toBe(20);
  });

  it("没有可用数据时退回地板", () => {
    expect(niceAxisTop(0)).toBe(20);
    expect(niceAxisTop(-5)).toBe(20);
    expect(niceAxisTop(Number.NaN)).toBe(20);
    expect(niceAxisTop(Number.NEGATIVE_INFINITY)).toBe(20);
  });
});

describe("lossAxisTop", () => {
  it("落到刚好容得下的档位", () => {
    expect(lossAxisTop(0)).toBe(5);
    expect(lossAxisTop(5)).toBe(5);
    expect(lossAxisTop(5.1)).toBe(10);
    expect(lossAxisTop(24)).toBe(25);
    expect(lossAxisTop(100)).toBe(100);
  });

  it("没有可用数据或超出 100% 时不越界", () => {
    expect(lossAxisTop(Number.NEGATIVE_INFINITY)).toBe(5);
    expect(lossAxisTop(Number.NaN)).toBe(5);
    expect(lossAxisTop(200)).toBe(100);
  });
});
