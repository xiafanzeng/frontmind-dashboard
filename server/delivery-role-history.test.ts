import { describe, expect, it } from "vitest";

import { deliveryHistoryTimestamp } from "./delivery-role-service";

describe("delivery history timestamps", () => {
  it("accepts decoded dates and raw driver timestamp strings", () => {
    const date = new Date("2026-07-31T08:00:00.000Z");

    expect(deliveryHistoryTimestamp(date)).toBe(date.getTime());
    expect(deliveryHistoryTimestamp("2026-07-31T08:00:00.000Z")).toBe(
      date.getTime(),
    );
  });

  it("returns a controlled Chinese error for invalid driver values", () => {
    expect(() => deliveryHistoryTimestamp("not-a-date")).toThrow(
      "任务记录的时间数据无效，请稍后重试",
    );
  });
});
