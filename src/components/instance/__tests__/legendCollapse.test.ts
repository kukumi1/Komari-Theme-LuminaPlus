import { describe, expect, it } from "vitest";
import { legendCollapseGeometry } from "@/components/instance/PingChart";

describe("legendCollapseGeometry", () => {
  it("内容超过两行时给出收起高度", () => {
    // 三行 chip：30*3 + 8*2 = 106
    expect(legendCollapseGeometry(106, 30)).toEqual({
      overflows: true,
      collapsedHeight: 68,
    });
  });

  it("正好两行时不需要收起", () => {
    expect(legendCollapseGeometry(68, 30)).toMatchObject({ overflows: false });
  });

  it("子像素行高的零点几差值不触发收起", () => {
    expect(legendCollapseGeometry(68.6, 30)).toMatchObject({ overflows: false });
    expect(legendCollapseGeometry(70, 30)).toMatchObject({ overflows: true });
  });

  it("还没测到行高时保持完全铺开，不冒出收起按钮", () => {
    expect(legendCollapseGeometry(500, 0)).toEqual({
      overflows: false,
      collapsedHeight: 0,
    });
  });

  it("内容高度为 0（尚未挂载）时同样不收起", () => {
    expect(legendCollapseGeometry(0, 30)).toMatchObject({ overflows: false });
  });

  it("行数可配，单行阈值不含行间距", () => {
    expect(legendCollapseGeometry(40, 30, 1)).toEqual({
      overflows: true,
      collapsedHeight: 30,
    });
  });

  it("非法行数退回不收起，避免算出负高度", () => {
    expect(legendCollapseGeometry(500, 30, 0)).toEqual({
      overflows: false,
      collapsedHeight: 0,
    });
  });
});
