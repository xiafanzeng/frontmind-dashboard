import { describe, expect, it } from "vitest";

import { questionHistoryItemMatchesTarget } from "./QuestionIntakePanel";

describe("question demand history identity", () => {
  const target = {
    questionId: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
    question: "硅基流动有什么核心产品？",
  };

  it("uses the authoritative source question id whenever it exists", () => {
    expect(
      questionHistoryItemMatchesTarget(
        {
          sourceQuestionId: target.questionId,
          topic: "旧问题文本",
        },
        target,
      ),
    ).toBe(true);
    expect(
      questionHistoryItemMatchesTarget(
        {
          sourceQuestionId: "5a67e445-37bb-45ed-9268-4ca9437e4d72",
          topic: target.question,
        },
        target,
      ),
    ).toBe(false);
  });

  it("falls back only to exact normalized legacy text, never a substring", () => {
    expect(
      questionHistoryItemMatchesTarget(
        {
          sourceQuestionId: null,
          topic: "  硅基流动有什么核心产品？ \n",
        },
        target,
      ),
    ).toBe(true);
    expect(
      questionHistoryItemMatchesTarget(
        {
          sourceQuestionId: null,
          topic: "请说明硅基流动有什么核心产品？并给出价格",
        },
        target,
      ),
    ).toBe(false);
  });
});
