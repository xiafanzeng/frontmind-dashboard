#!/usr/bin/env python3
"""
品牌定位校验器（V2 — 深度业务逻辑 + AI 友好反馈）
用途：校验 S4_{brand}_定位声明.json 是否符合 S4 品牌定位分析师的输出标准。

用法：
  python3 positioning_validator.py <positioning_json> [facts_json] [--ai-feedback]

新增能力（V2）：
  - 深度业务逻辑校验：定位声明与事实图谱的支撑事实自动比对
  - 差异化矩阵的竞品覆盖度和评分合理性检查
  - 价值三角三层之间的逻辑一致性检查
  - AI 友好反馈：--ai-feedback 输出 JSON 格式的修正建议
"""

import os
import sys
import json
import argparse


class PositioningValidationResult:
    """校验结果收集器（V2：支持 AI 友好反馈）"""

    def __init__(self):
        self.errors = []
        self.warnings = []
        self.ai_fixes = []

    def error(self, msg: str, fix: str = ""):
        self.errors.append(f"[错误] {msg}")
        if fix:
            self.ai_fixes.append({"severity": "error", "message": msg, "fix_action": fix})

    def warn(self, msg: str, fix: str = ""):
        self.warnings.append(f"[警告] {msg}")
        if fix:
            self.ai_fixes.append({"severity": "warning", "message": msg, "fix_action": fix})

    @property
    def passed(self) -> bool:
        return len(self.errors) == 0

    def summary(self) -> str:
        lines = ["=" * 60, "品牌定位校验报告（V2）", "=" * 60]
        if self.errors:
            lines.append(f"\n错误（{len(self.errors)} 项）：")
            for e in self.errors:
                lines.append(f"  {e}")
        if self.warnings:
            lines.append(f"\n警告（{len(self.warnings)} 项）：")
            for w in self.warnings:
                lines.append(f"  {w}")
        lines.append(f"\n{'✅ 校验通过' if self.passed else '❌ 校验失败'}")
        return "\n".join(lines)

    def ai_feedback_json(self) -> str:
        return json.dumps({
            "validator": "S4_品牌定位校验器",
            "passed": self.passed,
            "error_count": len(self.errors),
            "warning_count": len(self.warnings),
            "fix_actions": self.ai_fixes,
            "instruction_to_s0": (
                "请将以上 fix_actions 逐条传递给 S4 节点进行修复。"
                "S4 修复后需重新提交校验。"
            )
        }, ensure_ascii=False, indent=2)


def validate_positioning(pos_path: str, facts_path: str = None,
                         ai_feedback: bool = False) -> int:
    """
    校验品牌定位声明

    Returns:
        0 = 通过, 1 = 失败
    """
    result = PositioningValidationResult()

    # 加载文件
    try:
        with open(pos_path, "r", encoding="utf-8") as f:
            pos = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"[错误] 无法加载定位声明：{e}")
        return 1

    facts = None
    if facts_path:
        try:
            with open(facts_path, "r", encoding="utf-8") as f:
                facts = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError) as e:
            result.warn(
                f"无法加载事实图谱（将跳过证据溯源校验）：{e}",
                "确保品牌事实图谱文件路径正确且 JSON 格式合法。"
            )

    # ========== 1. 四要素校验 ==========
    stmt = pos.get("positioning_statement", {})
    four_elements = {
        "target_audience": "目标人群",
        "brand": "品牌",
        "category": "品类归属",
        "differentiator": "差异化价值点"
    }
    for key, name in four_elements.items():
        val = stmt.get(key, "")
        if not val or len(str(val).strip()) < 2:
            result.error(
                f"定位声明缺少四要素之「{name}」",
                f"在 positioning_statement.{key} 中填入品牌的{name}。"
                f"该字段不能为空且长度至少 2 个字符。"
            )

    # 定位声明完整句校验
    full_statement = stmt.get("full_statement", "")
    if not full_statement or len(full_statement) < 20:
        result.error(
            "定位声明缺少完整句（full_statement），或长度不足 20 字",
            "在 positioning_statement.full_statement 中填入完整的定位声明句式："
            "「对于[目标人群]，[品牌]是[品类]中唯一能[差异点]的品牌，因为[证据]。」"
        )

    # ========== 2. 证据数量与质量校验 ==========
    evidence = stmt.get("evidence", [])
    if len(evidence) < 3:
        result.error(
            f"支撑证据不足：{len(evidence)}/3",
            f"至少添加 3 条支撑证据到 positioning_statement.evidence 数组中。"
            f"每条证据应包含具体的数据、案例或资质。"
        )

    # 深度校验：证据是否有实质内容（非空话）
    vague_evidence = []
    for i, ev in enumerate(evidence):
        ev_text = str(ev)
        if len(ev_text) < 10:
            vague_evidence.append(i)
    if vague_evidence:
        result.warn(
            f"以下证据内容过短（<10 字），可能缺乏实质性：索引 {vague_evidence}",
            f"为索引 {vague_evidence} 的证据补充具体数据、案例名称或资质编号。"
        )

    # ========== 3. 价值三角校验 ==========
    triangle = pos.get("value_triangle", {})
    triangle_layers = {
        "functional_value": "功能价值",
        "emotional_value": "情感价值",
        "self_expression_value": "自我表达价值"
    }
    filled_layers = 0
    for key, name in triangle_layers.items():
        val = triangle.get(key, "")
        if not val or len(str(val).strip()) < 5:
            result.error(
                f"价值三角缺少「{name}」或内容过短（<5 字）",
                f"在 value_triangle.{key} 中填入品牌的{name}描述，至少 5 个字符。"
            )
        else:
            filled_layers += 1

    # 价值三角层级递进逻辑检查
    if filled_layers == 3:
        func_val = str(triangle.get("functional_value", ""))
        emot_val = str(triangle.get("emotional_value", ""))
        # 简单检查：情感价值不应与功能价值完全相同
        if func_val == emot_val:
            result.warn(
                "功能价值与情感价值内容完全相同，缺乏层级递进",
                "功能价值应描述产品的具体功能利益（如'检测速度快'），"
                "情感价值应描述用户的心理感受（如'安心'、'信赖'）。请区分两者。"
            )

    # ========== 4. 差异化矩阵校验 ==========
    matrix = pos.get("differentiation_matrix", [])
    if isinstance(matrix, list):
        if len(matrix) < 5:
            result.error(
                f"差异化矩阵维度不足：{len(matrix)}/5",
                f"至少添加 5 个评估维度到 differentiation_matrix 数组中。"
                f"建议维度：技术能力、服务质量、价格竞争力、品牌知名度、客户满意度等。"
            )

        # 深度校验：评分合理性
        for idx, item in enumerate(matrix):
            if not isinstance(item, dict):
                continue
            brand_score = item.get("brand_score")
            if brand_score is not None:
                if not isinstance(brand_score, (int, float)):
                    result.error(
                        f"differentiation_matrix[{idx}].brand_score 必须是数字",
                        f"将 brand_score 修改为 0-10 之间的数字。"
                    )
                elif brand_score < 0 or brand_score > 10:
                    result.warn(
                        f"differentiation_matrix[{idx}].brand_score = {brand_score}，超出 0-10 范围",
                        f"将 brand_score 修改为 0-10 之间的数字。"
                    )

            # 竞品数量
            competitors = [k for k in item.keys()
                           if k not in ("dimension", "weight", "brand_score", "description")]
            if len(competitors) < 3:
                result.warn(
                    f"维度「{item.get('dimension', '?')}」竞品数不足：{len(competitors)}/3（建议 ≥ 5）",
                    f"为该维度添加更多竞品的评分数据。"
                )
                break

        # 深度校验：品牌是否在所有维度都是最高分（不合理）
        all_best = True
        for item in matrix:
            if not isinstance(item, dict):
                continue
            brand_score = item.get("brand_score", 0)
            competitors = {k: v for k, v in item.items()
                           if k not in ("dimension", "weight", "brand_score", "description")
                           and isinstance(v, (int, float))}
            if competitors and brand_score <= max(competitors.values()):
                all_best = False
                break
        if all_best and len(matrix) >= 3:
            result.warn(
                "品牌在所有差异化维度均为最高分，可能存在评分偏差",
                "请客观评估：品牌不太可能在所有维度都优于所有竞品。"
                "请重新审视评分，确保至少有 1-2 个维度竞品得分更高。"
            )
    else:
        result.error(
            "差异化矩阵格式错误（应为数组）",
            "将 differentiation_matrix 修改为 JSON array，每个元素包含 dimension、brand_score 和竞品评分。"
        )

    # ========== 5. 证据溯源校验（深度比对） ==========
    if facts and evidence:
        facts_text = json.dumps(facts, ensure_ascii=False).lower()
        traceable = 0
        untraceable_indices = []
        for i, ev in enumerate(evidence):
            ev_str = str(ev).lower()
            # 提取关键词（长度 > 2 的词）
            keywords = [w for w in ev_str.replace(",", " ").replace("，", " ").split() if len(w) > 2]
            if not keywords:
                continue
            matched = sum(1 for kw in keywords if kw in facts_text)
            if matched >= max(1, len(keywords) * 0.3):
                traceable += 1
            else:
                untraceable_indices.append(i)

        if len(evidence) > 0 and traceable < len(evidence) * 0.5:
            result.warn(
                f"证据溯源率偏低：{traceable}/{len(evidence)} 条可追溯到事实图谱。"
                f"不可追溯的证据索引：{untraceable_indices}",
                f"请检查索引 {untraceable_indices} 的证据是否来自客户资料。"
                f"如果是新推导的证据，请确保在事实图谱中有对应的 facts 支撑。"
            )

    # ========== 输出结果 ==========
    print(result.summary())

    if ai_feedback:
        print("\n--- AI 修正建议（JSON）---")
        print(result.ai_feedback_json())

    return 0 if result.passed else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="品牌定位校验器（V2）")
    parser.add_argument("positioning_json", help="定位声明 JSON 文件路径")
    parser.add_argument("facts_json", nargs="?", default=None,
                        help="品牌事实图谱 JSON 文件路径（可选）")
    parser.add_argument("--ai-feedback", action="store_true",
                        help="输出 AI 可解析的 JSON 修正建议")
    args = parser.parse_args()
    sys.exit(validate_positioning(args.positioning_json, args.facts_json, args.ai_feedback))
