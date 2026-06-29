#!/usr/bin/env python3
"""
问答矩阵校验器
用途：校验 S8_{brand}_问答矩阵.json 是否符合 S8 问答架构师的输出标准。

用法：
  python3 qa_matrix_validator.py <qa_matrix_json> [--verbal-tokens <verbal_json>]

校验规则：
  1. JSON 格式合法
  2. 问答总数 ≥ 30 条
  3. 5 个问题阶段均有覆盖（各阶段达到最低数量）
     问题阶段统一枚举值：awareness / consideration / decision / usage / advocacy
  4. 每条标准答案 100-2000 字
  5. 每条问答包含所有必填属性
  6. question_id 格式合法且无重复
  7. 话语 Token 命中率抽检（如提供话语 Token）
"""

import os
import sys
import json
import re
import argparse
from collections import Counter


# ============================================================
# 问题阶段统一枚举值（全工作流唯一标准）
# 与 SKILL.md、qa_matrix_schema.json、qa_tree_schema.json、
# content_calendar_schema.json、shared/output-format-standard.md 完全一致
# ============================================================
STAGE_MINIMUMS = {
    "awareness": 5,
    "consideration": 8,
    "decision": 8,
    "usage": 5,
    "advocacy": 4,
}

REQUIRED_FIELDS = [
    "question_id", "question", "question_stage", "source",
    "intent_type", "standard_answer", "content_type",
    "target_platform", "priority", "assigned_to"
]


def validate_qa_matrix(matrix_path: str, verbal_path: str = None) -> int:
    """
    校验问答矩阵 JSON。

    Args:
        matrix_path: 问答矩阵 JSON 文件路径
        verbal_path: 话语 Token JSON 文件路径（可选）

    Returns:
        0 = 通过, 1 = 失败
    """
    errors = []
    warnings = []

    # 1. 加载 JSON
    try:
        with open(matrix_path, "r", encoding="utf-8") as f:
            matrix = json.load(f)
    except FileNotFoundError:
        print(f"[错误] 文件不存在：{matrix_path}")
        return 1
    except json.JSONDecodeError as e:
        print(f"[错误] JSON 格式错误：{e}")
        return 1

    questions = matrix.get("questions", [])

    # 2. 总数校验
    if len(questions) < 30:
        errors.append(f"问答总数不足：{len(questions)}/30")

    # 3. 阶段分布校验
    stage_counts = Counter(q.get("question_stage", "") for q in questions)

    # 检查是否使用了非标准枚举值
    valid_stages = set(STAGE_MINIMUMS.keys())
    invalid_stages = set(stage_counts.keys()) - valid_stages - {""}
    if invalid_stages:
        errors.append(
            f"使用了非标准问题阶段枚举值：{invalid_stages}。"
            f"唯一合法枚举值为：{sorted(valid_stages)}"
        )

    for stage, minimum in STAGE_MINIMUMS.items():
        actual = stage_counts.get(stage, 0)
        if actual < minimum:
            errors.append(f"阶段 {stage} 问答不足：{actual}/{minimum}")

    # 4. 逐条校验
    seen_ids = set()
    for i, q in enumerate(questions):
        prefix = f"Q[{i}]"

        # 必填字段
        for field in REQUIRED_FIELDS:
            if field not in q:
                errors.append(f"{prefix} 缺少必填字段：{field}")

        # ID 格式与唯一性
        qid = q.get("question_id", "")
        if qid:
            if not re.match(r"^(AW|CO|DE|US|AD)_\d{3}$", qid):
                warnings.append(f"{prefix} question_id 格式建议：{qid}（应为 AW/CO/DE/US/AD_NNN）")
            if qid in seen_ids:
                errors.append(f"{prefix} question_id 重复：{qid}")
            seen_ids.add(qid)

        # 标准答案长度
        answer = q.get("standard_answer", "")
        if len(answer) < 100:
            errors.append(f"{prefix} 标准答案过短：{len(answer)} 字（最低 100 字）")
        elif len(answer) > 2000:
            warnings.append(f"{prefix} 标准答案较长：{len(answer)} 字（建议 ≤ 2000 字）")

        # 平台列表
        platforms = q.get("target_platform", [])
        if not platforms:
            errors.append(f"{prefix} target_platform 为空")

    # 5. 话语 Token 命中率抽检
    if verbal_path:
        try:
            with open(verbal_path, "r", encoding="utf-8") as f:
                verbal = json.load(f)
            high_freq = verbal.get("high_freq_words", [])
            banned = verbal.get("banned_words", [])

            # 抽检前 5 条
            sample = questions[:5]
            for q in sample:
                answer = q.get("standard_answer", "").lower()
                qid = q.get("question_id", "?")

                # 高频词命中
                hits = sum(1 for w in high_freq if w.lower() in answer)
                hit_rate = hits / len(high_freq) * 100 if high_freq else 0

                if hit_rate < 10:
                    warnings.append(f"{qid} 高频词命中率偏低：{hit_rate:.1f}%")

                # 禁用词检查
                violations = [w for w in banned if w.lower() in answer]
                if violations:
                    errors.append(f"{qid} 使用了禁用词：{violations}")

        except Exception as e:
            warnings.append(f"话语 Token 加载失败，跳过命中率检查：{e}")

    # 6. 优先级分布检查
    priority_counts = Counter(q.get("priority", "") for q in questions)
    p0_count = priority_counts.get("P0", 0)
    if p0_count < 5:
        warnings.append(f"P0 优先级问答偏少：{p0_count}（建议 ≥ 5）")

    # 7. S2 场景背景使用检查（v3.5 更新）
    s2_sources = [q for q in questions if q.get("source", "").startswith("S2_")]
    if len(s2_sources) == 0:
        warnings.append("未检测到 S2 场景树背景来源的问答；可结合 S2 意图图谱补充长尾内容，但不得把 S2 当作监控题源")

    _print_report(errors, warnings, len(questions), dict(stage_counts))
    return 0 if not errors else 1


def _print_report(errors: list, warnings: list, total: int, stages: dict):
    """打印校验报告。"""
    print("=" * 60)
    print("问答矩阵校验报告")
    print("=" * 60)
    print(f"\n总计：{total} 条问答")
    print(f"阶段分布：{stages}")
    print(f"\n合法问题阶段枚举值：awareness / consideration / decision / usage / advocacy")

    if errors:
        print(f"\n错误（{len(errors)} 项）：")
        for e in errors:
            print(f"  [错误] {e}")

    if warnings:
        print(f"\n警告（{len(warnings)} 项）：")
        for w in warnings:
            print(f"  [警告] {w}")

    if not errors:
        print("\n✅ 校验通过")
    else:
        print("\n❌ 校验失败")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="问答矩阵校验器")
    parser.add_argument("qa_matrix_json", help="问答矩阵 JSON 文件路径")
    parser.add_argument("--verbal-tokens", default=None, help="话语 Token JSON 路径（可选）")
    args = parser.parse_args()
    sys.exit(validate_qa_matrix(args.qa_matrix_json, args.verbal_tokens))
