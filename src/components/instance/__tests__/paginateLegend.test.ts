import { describe, expect, it } from "vitest";
import { paginateLegend } from "@/components/instance/PingChart";

describe("paginateLegend", () => {
  const items = ["a", "b", "c", "d", "e", "f", "g"];

  it("条目不超过一页时不分页", () => {
    expect(paginateLegend(items.slice(0, 6), 6, 0)).toEqual({
      items: ["a", "b", "c", "d", "e", "f"],
      page: 0,
      pageCount: 1,
      paginated: false,
    });
  });

  it("超出一页时按页切片", () => {
    expect(paginateLegend(items, 6, 0)).toMatchObject({
      items: ["a", "b", "c", "d", "e", "f"],
      pageCount: 2,
      paginated: true,
    });
    expect(paginateLegend(items, 6, 1)).toMatchObject({
      items: ["g"],
      page: 1,
    });
  });

  it("页码越界时收敛到最后一页，不返回空页", () => {
    const result = paginateLegend(items, 3, 99);

    expect(result.page).toBe(2);
    expect(result.items).toEqual(["g"]);
  });

  it("负页码收敛到第一页", () => {
    expect(paginateLegend(items, 3, -5).page).toBe(0);
  });

  it("页大小非法时退回不分页，避免除零", () => {
    expect(paginateLegend(items, 0, 2)).toMatchObject({
      items,
      paginated: false,
      pageCount: 1,
    });
  });

  it("空列表不分页", () => {
    expect(paginateLegend([], 6, 3)).toEqual({
      items: [],
      page: 0,
      pageCount: 1,
      paginated: false,
    });
  });
});
