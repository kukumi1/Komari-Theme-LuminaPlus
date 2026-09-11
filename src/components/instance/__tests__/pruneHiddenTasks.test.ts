import { describe, expect, it } from "vitest";
import { pruneHiddenTasks } from "@/components/instance/PingChart";

const tasks = [{ id: 1 }, { id: 2 }, { id: 3 }];

describe("pruneHiddenTasks", () => {
  it("切换时间范围、数据还没回来时保住筛选状态", () => {
    const hidden = new Set([1, 2]);

    expect(pruneHiddenTasks(hidden, [])).toBe(hidden);
  });

  it("线路真的消失时丢弃它的隐藏状态", () => {
    const hidden = new Set([1, 99]);

    expect([...pruneHiddenTasks(hidden, tasks)]).toEqual([1]);
  });

  it("没有变化时返回原引用，避免无谓重渲染", () => {
    const hidden = new Set([1, 3]);

    expect(pruneHiddenTasks(hidden, tasks)).toBe(hidden);
  });

  it("空的隐藏集合直接原样返回", () => {
    const hidden = new Set<number>();

    expect(pruneHiddenTasks(hidden, tasks)).toBe(hidden);
  });

  it("全部线路都消失时清空", () => {
    expect(pruneHiddenTasks(new Set([7, 8]), tasks).size).toBe(0);
  });
});
