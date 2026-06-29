#!/usr/bin/env python3
"""
话语 Token 校验器（V2 — 深度业务逻辑 + AI 友好反馈）
用途：校验 S6_{brand}_话语token.json 是否符合 S6 品牌话语体系的输出标准。

用法：
  python3 token_validator.py <token_json> [--schema <schema_json>] [--ai-feedback]

V2 新增校验规则：
  1-9: 原有规则（见下方）
  10: 高频词与禁用词交叉检查
  11: 句式模板中的占位符格式校验（必须包含 {{品牌名}} 等变量）
  12: 口号候选的长度与重复性检查
  13: Do/Don't 对的语义对称性检查
  14: Messaging House 三支柱主题不重复检查
  15: 旧版术语残留检测（如"购买"→"决策"）
  16: AI 友好 JSON 修正建议输出
"""

import os
import sys
import json
import argparse


# 旧版术语检测
DEPRECATED_TERMS = {
    "购买": "决策（decision）",
    "售后": "使用（usage）",
    "post-purchase": "usage",
    "复购": "拥护（advocacy）",
}


def validate_token(token_path: str, schema_path: str = None,
                   ai_feedback: bool = False) -> int:
    """
    校验话语 Token JSON（V2）。

    Returns:
        0 = 通过, 1 = 失败
    """
    errors = []
    warnings = []
    ai_fixes = []

    def add_error(msg: str, fix: str = ""):
        errors.append(f"[错误] {msg}")
        if fix:
            ai_fixes.append({"severity": "error", "message": msg, "fix_action": fix})

    def add_warn(msg: str, fix: str = ""):
        warnings.append(f"[警告] {msg}")
        if fix:
            ai_fixes.append({"severity": "warning", "message": msg, "fix_action": fix})

    # 1. 加载 JSON
    try:
        with open(token_path, "r", encoding="utf-8") as f:
            token = json.load(f)
    except FileNotFoundError:
        print(f"[错误] 文件不存在：{token_path}")
        return 1
    except json.JSONDecodeError as e:
        print(f"[错误] JSON 格式错误：{e}")
        if ai_feedback:
            print(json.dumps({
                "validator": "S6_话语Token校验器",
                "passed": False,
                "fix_actions": [{
                    "severity": "fatal",
                    "message": f"JSON 解析失败：{e}",
                    "fix_action": "检查 JSON 语法错误（如缺少逗号、引号不匹配等），修复后重新提交。"
                }]
            }, ensure_ascii=False, indent=2))
        return 1

    # 2. 必要字段检查
    required_fields = [
        "meta", "tone_tokens", "messaging_house",
        "high_freq_words", "banned_words", "sentence_patterns",
        "slogan_candidates", "do_dont_pairs"
    ]
    for field in required_fields:
        if field not in token:
            add_error(
                f"缺少必要字段：{field}",
                f"在 JSON 根对象中添加 \"{field}\" 字段。"
            )

    if errors:
        _print_report(errors, warnings, ai_fixes, ai_feedback)
        return 1

    # 3. Tone 4 维度校验
    tone = token.get("tone_tokens", {})
    tone_dims = {
        "formal_casual": "正式-随意",
        "serious_funny": "严肃-幽默",
        "respectful_irreverent": "尊重-不羁",
        "matter_of_fact_enthusiastic": "务实-热情"
    }
    for dim, name in tone_dims.items():
        val = tone.get(dim)
        if val is None:
            add_error(
                f"Tone 维度缺失：{dim}（{name}）",
                f"在 tone_tokens 中添加 \"{dim}\" 字段，值为 1-5 的整数。"
                f"1 代表维度左侧（如正式），5 代表右侧（如随意）。"
            )
        elif not isinstance(val, (int, float)) or val < 1 or val > 5:
            add_error(
                f"Tone 维度 {dim} 打分无效（应为 1-5）：{val}",
                f"将 {dim} 的值修改为 1-5 之间的整数。"
            )

    tone_desc = tone.get("tone_description", "")
    if len(str(tone_desc)) < 30:
        add_error(
            f"语调描述过短（{len(str(tone_desc))} 字，最低 30 字）",
            f"将 tone_description 扩展至至少 30 字，描述品牌的整体语调风格和使用场景。"
        )

    # 4. 高频词校验
    high_freq = token.get("high_freq_words", [])
    if not isinstance(high_freq, list):
        add_error("high_freq_words 应为数组", "将 high_freq_words 修改为字符串数组。")
    elif len(high_freq) < 30:
        add_error(
            f"高频词不足：{len(high_freq)}/30",
            f"请补充 {30 - len(high_freq)} 个高频词。高频词应包含品牌核心术语、"
            f"行业关键词和差异化用语。"
        )
    else:
        # 检查重复
        dupes = [w for w in set(high_freq) if high_freq.count(w) > 1]
        if dupes:
            add_warn(
                f"高频词存在重复：{dupes[:5]}",
                f"去除重复的高频词：{dupes[:5]}"
            )

    # 5. 禁用词校验
    banned = token.get("banned_words", [])
    if not isinstance(banned, list):
        add_error("banned_words 应为数组", "将 banned_words 修改为字符串数组。")
    elif len(banned) < 15:
        add_error(
            f"禁用词不足：{len(banned)}/15",
            f"请补充 {15 - len(banned)} 个禁用词。禁用词应包含竞品名称、"
            f"行业敏感词和品牌不希望使用的表达。"
        )

    # 6. 句式模板校验
    patterns = token.get("sentence_patterns", [])
    if not isinstance(patterns, list):
        add_error("sentence_patterns 应为数组", "将 sentence_patterns 修改为对象数组。")
    elif len(patterns) < 5:
        add_error(
            f"句式模板不足：{len(patterns)}/5",
            f"请补充 {5 - len(patterns)} 个句式模板。"
        )
    else:
        # 检查占位符格式
        has_placeholder = False
        for i, p in enumerate(patterns):
            template_text = p.get("template", "") if isinstance(p, dict) else str(p)
            if "{{" in template_text and "}}" in template_text:
                has_placeholder = True
            elif "{" in template_text and "}" in template_text:
                has_placeholder = True
        if not has_placeholder:
            add_warn(
                "句式模板中未检测到占位符变量（如 {{品牌名}}、{{产品}}）",
                "建议在句式模板中使用 {{品牌名}}、{{产品}}、{{场景}} 等占位符，"
                "以便执行层自动填充。"
            )

    # 7. 品牌口号候选校验
    slogans = token.get("slogan_candidates", [])
    if not isinstance(slogans, list):
        add_error("slogan_candidates 应为数组", "将 slogan_candidates 修改为对象数组。")
    elif len(slogans) < 3:
        add_error(
            f"品牌口号候选不足：{len(slogans)}/3",
            f"请补充 {3 - len(slogans)} 个口号候选。"
        )
    else:
        slogan_texts = []
        for i, s in enumerate(slogans):
            if not isinstance(s, dict) or "text" not in s:
                add_error(
                    f"口号候选 #{i+1} 缺少 text 字段",
                    f"为 slogan_candidates[{i}] 添加 text 字段。"
                )
            else:
                text = s["text"]
                slogan_texts.append(text)
                if len(text) > 20:
                    add_warn(
                        f"口号候选 #{i+1} 过长（{len(text)} 字），好口号通常 ≤ 20 字",
                        f"将口号 '{text}' 精简至 20 字以内。"
                    )
        # 检查口号重复
        if len(slogan_texts) != len(set(slogan_texts)):
            add_error(
                "口号候选存在重复",
                "去除重复的口号候选，确保每条口号都是独特的。"
            )

    # 8. Do/Don't 校验
    pairs = token.get("do_dont_pairs", [])
    if not isinstance(pairs, list):
        add_error("do_dont_pairs 应为数组", "将 do_dont_pairs 修改为对象数组。")
    elif len(pairs) < 10:
        add_error(
            f"Do/Don't 对数不足：{len(pairs)}/10",
            f"请补充 {10 - len(pairs)} 对 Do/Don't。"
        )
    else:
        for i, p in enumerate(pairs):
            if not isinstance(p, dict):
                add_error(f"Do/Don't #{i+1} 格式错误", f"将 do_dont_pairs[{i}] 修改为包含 do 和 dont 字段的对象。")
            elif "do" not in p or "dont" not in p:
                add_error(
                    f"Do/Don't #{i+1} 缺少 do 或 dont 字段",
                    f"为 do_dont_pairs[{i}] 补充缺失的 do 或 dont 字段。"
                )
            else:
                # 语义对称性检查：do 和 dont 不应完全相同
                if p.get("do", "").strip() == p.get("dont", "").strip():
                    add_warn(
                        f"Do/Don't #{i+1} 的 do 和 dont 内容完全相同",
                        f"修改 do_dont_pairs[{i}]，确保 do 和 dont 是对立的表达。"
                    )

    # 9. Messaging House 校验
    house = token.get("messaging_house", {})
    core_msg = house.get("core_message", "")
    if not core_msg:
        add_error(
            "Messaging House 缺少 core_message",
            "在 messaging_house 中添加 core_message 字段，描述品牌的核心信息主张。"
        )
    elif len(str(core_msg)) < 10:
        add_error(
            f"Messaging House core_message 过短（{len(str(core_msg))} 字）",
            "将 core_message 扩展至至少 10 字，清晰表达品牌的核心信息。"
        )

    pillar_themes = []
    for pillar_key in ["pillar_1", "pillar_2", "pillar_3"]:
        pillar = house.get(pillar_key, {})
        points = pillar.get("key_points", [])
        theme = pillar.get("theme", pillar.get("title", ""))
        if theme:
            pillar_themes.append(theme)
        if len(points) < 3:
            add_error(
                f"Messaging House {pillar_key} 关键信息点不足：{len(points)}/3",
                f"为 {pillar_key} 补充至少 {3 - len(points)} 个 key_points。"
            )

    # 三支柱主题不重复检查
    if len(pillar_themes) == 3 and len(set(pillar_themes)) < 3:
        add_warn(
            "Messaging House 三支柱主题存在重复",
            "确保 pillar_1/2/3 的 theme 各不相同，分别覆盖品牌的不同价值维度。"
        )

    evidence = house.get("evidence_bricks", [])
    if len(evidence) < 3:
        add_warn(
            f"证据砖不足：{len(evidence)}/3（建议补充）",
            f"为 messaging_house.evidence_bricks 补充至少 {3 - len(evidence)} 条证据。"
        )

    # 10. 高频词与禁用词交叉检查
    if isinstance(high_freq, list) and isinstance(banned, list):
        overlap = set(high_freq) & set(banned)
        if overlap:
            add_error(
                f"高频词与禁用词重叠：{overlap}",
                f"从 high_freq_words 或 banned_words 中移除重叠词：{overlap}。"
                f"一个词不能同时被推荐使用和禁止使用。"
            )

    # 11. 旧版术语残留检测
    full_text = json.dumps(token, ensure_ascii=False)
    deprecated_found = {}
    for old_term, new_term in DEPRECATED_TERMS.items():
        if old_term in full_text:
            deprecated_found[old_term] = new_term
    if deprecated_found:
        add_warn(
            f"检测到旧版术语残留：{deprecated_found}",
            f"请进行全局替换：{deprecated_found}。"
            f"确保与 shared/output-format-standard.md 的术语标准一致。"
        )

    # 12. JSON Schema 校验（如果提供了 schema）
    if schema_path:
        try:
            import jsonschema
            with open(schema_path, "r", encoding="utf-8") as f:
                schema = json.load(f)
            jsonschema.validate(token, schema)
        except ImportError:
            add_warn("jsonschema 库未安装，跳过 Schema 校验", "")
        except Exception as e:
            add_error(f"Schema 校验失败：{e}", "根据 Schema 错误信息修复对应字段。")

    _print_report(errors, warnings, ai_fixes, ai_feedback)
    return 0 if not errors else 1


def _print_report(errors: list, warnings: list, ai_fixes: list = None,
                  ai_feedback: bool = False):
    """打印校验报告。"""
    print("=" * 60)
    print("话语 Token 校验报告（V2）")
    print("=" * 60)

    if errors:
        print(f"\n错误（{len(errors)} 项）：")
        for e in errors:
            print(f"  {e}")

    if warnings:
        print(f"\n警告（{len(warnings)} 项）：")
        for w in warnings:
            print(f"  {w}")

    if not errors:
        print("\n✅ 校验通过")
    else:
        print("\n❌ 校验失败")

    if ai_feedback and ai_fixes:
        print("\n--- AI 修正建议（JSON）---")
        print(json.dumps({
            "validator": "S6_话语Token校验器",
            "passed": len(errors) == 0,
            "error_count": len(errors),
            "warning_count": len(warnings),
            "fix_actions": ai_fixes,
            "instruction_to_s0": (
                "请将以上 fix_actions 逐条传递给 S6 节点进行修复。"
                "S6 修复后需重新提交校验。"
            )
        }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="话语 Token 校验器（V2）")
    parser.add_argument("token_json", help="话语 Token JSON 文件路径")
    parser.add_argument("--schema", default=None, help="JSON Schema 文件路径（可选）")
    parser.add_argument("--ai-feedback", action="store_true",
                        help="输出 AI 可解析的 JSON 修正建议")
    args = parser.parse_args()
    sys.exit(validate_token(args.token_json, args.schema, args.ai_feedback))
