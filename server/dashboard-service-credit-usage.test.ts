import { describe, expect, it } from "vitest";

import {
  aggregateSharedKeyCreditUsagePage,
  getShanghaiCalendarMonthPeriod,
} from "./dashboard-service";

describe("shared API Key credit usage", () => {
  it("shows the shared pool total without exposing another account's task details", () => {
    const now = Date.now();
    const result = aggregateSharedKeyCreditUsagePage({
      tasks: [
        {
          id: "task-current-account",
          created_at: now,
          metadata: {
            credit_usage: 120,
            task_title: "当前账号品牌分析",
          },
        },
        {
          id: "task-other-account",
          created_at: now,
          metadata: {
            credit_usage: 80,
            task_title: "其他账号机密任务",
          },
        },
      ],
      ownedTaskIds: new Set(["task-current-account"]),
      cutoff: now - 30 * 24 * 60 * 60 * 1_000,
      seenTaskIds: new Set(),
    });

    expect(result.totalUsed).toBe(200);
    expect(result.accountUsed).toBe(120);
    expect(result.recentTasks).toEqual([
      expect.objectContaining({
        id: "task-current-account",
        title: "当前账号品牌分析",
        creditUsage: 120,
      }),
    ]);
    expect(JSON.stringify(result.recentTasks)).not.toContain(
      "其他账号机密任务",
    );
  });

  it("does not count duplicate tasks twice across pages", () => {
    const now = Date.now();
    const seenTaskIds = new Set<string>();
    const task = {
      id: "task-shared-page-boundary",
      created_at: now,
      credit_usage: 36,
    };

    const first = aggregateSharedKeyCreditUsagePage({
      tasks: [task],
      ownedTaskIds: new Set(["task-shared-page-boundary"]),
      cutoff: now - 1_000,
      seenTaskIds,
    });
    const second = aggregateSharedKeyCreditUsagePage({
      tasks: [task],
      ownedTaskIds: new Set(["task-shared-page-boundary"]),
      cutoff: now - 1_000,
      seenTaskIds,
    });

    expect(first.totalUsed).toBe(36);
    expect(first.accountUsed).toBe(36);
    expect(second.totalUsed).toBe(0);
    expect(second.accountUsed).toBe(0);
    expect(second.recentTasks).toEqual([]);
  });

  it("uses a Beijing-time calendar month instead of a rolling 30-day window", () => {
    const period = getShanghaiCalendarMonthPeriod(
      Date.parse("2026-07-31T20:30:00.000Z"),
    );

    expect(period).toMatchObject({
      key: "2026-08",
      label: "2026 年 8 月",
      timezone: "Asia/Shanghai",
      startAt: Date.parse("2026-07-31T16:00:00.000Z"),
      endAt: Date.parse("2026-08-31T16:00:00.000Z"),
    });
  });

  it("excludes next-month tasks from both the Key pool and account ledger", () => {
    const period = getShanghaiCalendarMonthPeriod(
      Date.parse("2026-07-15T00:00:00.000Z"),
    );
    const result = aggregateSharedKeyCreditUsagePage({
      tasks: [
        {
          id: "next-month",
          created_at: period.endAt,
          credit_usage: 90,
        },
        {
          id: "current-month",
          created_at: period.endAt - 1,
          credit_usage: 45,
        },
      ],
      ownedTaskIds: new Set(["next-month", "current-month"]),
      cutoff: period.startAt,
      endExclusive: period.endAt,
      seenTaskIds: new Set(),
    });

    expect(result.totalUsed).toBe(45);
    expect(result.accountUsed).toBe(45);
    expect(result.recentTasks.map((task) => task.id)).toEqual([
      "current-month",
    ]);
  });
});
