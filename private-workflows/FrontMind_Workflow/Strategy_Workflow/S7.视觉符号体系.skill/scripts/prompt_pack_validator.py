#!/usr/bin/env python3
"""
视觉 Prompt 包校验器（v2.6 — 视觉资产锚定校验）
用途：校验 S7_{brand}_视觉Prompt包.json 是否符合 S7 视觉符号体系 v2.6 的输出标准。

用法：
  python3 prompt_pack_validator.py <prompt_pack_json> \
    [--verbal-tokens <verbal_json>] \
    [--visual-manifest <visual_manifest_json>] \
    [--ai-feedback]

v2.6 新增校验规则：
  - work_mode 字段存在且合法
  - visual_asset_summary 与 S1 视觉资产清单一致性
  - 每条 motif 的 color_source 和 reference_assets 字段存在
  - 约束模式下 color_hex 至少 1 个来自 S1 提取的真实色值
  - visual_motifs 结构替代旧版 prompts 结构
"""

import os
import sys
import json
import re
import argparse


HEX_PATTERN = re.compile(r"^#[0-9A-Fa-f]{6}$")
ASPECT_RATIO_PATTERN = re.compile(r"^\d+:\d+$")

VALID_WORK_MODES = {"constrained", "semi_constrained", "inference_only"}
VALID_BRANCHES = {"A", "B"}
VALID_MOTIF_TYPES = {"符号化识别演绎", "核心业务场景", "品牌情感意境"}
VALID_COLOR_SOURCES = {"S1_extracted", "inferred", "mixed"}
VALID_TOOLS = {"Midjourney", "Flux.1", "SDXL", "Lovart", "即梦"}

REQUIRED_MOTIF_FIELDS = [
    "motif_id", "motif_type", "positive_prompt", "style_keywords",
    "color_hex", "color_source", "composition", "negative_prompt",
    "reference_assets"
]

# MJ 特定参数标记（不应出现在 positive_prompt 中）
MJ_PROMPT_MARKERS = ["--ar", "--stylize", "--s ", "--chaos", "--quality",
                     "--q ", "--style", "--weird", "--w "]


def validate_prompt_pack(pack_path: str, verbal_path: str = None,
                         visual_manifest_path: str = None,
                         ai_feedback: bool = False) -> int:
    """
    校验视觉 Prompt 包（v2.6）。

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

    # ── 1. 加载 JSON ──
    try:
        with open(pack_path, "r", encoding="utf-8") as f:
            pack = json.load(f)
    except FileNotFoundError:
        print(f"[错误] 文件不存在：{pack_path}")
        return 1
    except json.JSONDecodeError as e:
        print(f"[错误] JSON 格式错误：{e}")
        return 1

    # ── 2. 顶层字段检查 ──
    for field in ["meta", "visual_identity", "visual_motifs"]:
        if field not in pack:
            # 兼容旧版 prompts 字段
            if field == "visual_motifs" and "prompts" in pack:
                add_warn(
                    "使用了旧版 'prompts' 字段，v2.6 应使用 'visual_motifs'",
                    "将 'prompts' 重构为 'visual_motifs' 数组格式。"
                )
            else:
                add_error(f"缺少顶层字段：{field}", f"在 JSON 根对象中添加 \"{field}\" 字段。")

    if any("[错误]" in e and "缺少顶层字段" in e for e in errors):
        _print_report(errors, warnings, ai_fixes, ai_feedback)
        return 1

    # ── 3. Meta 检查 ──
    meta = pack.get("meta", {})
    branch = meta.get("branch", "B")
    work_mode = meta.get("work_mode", "")
    total = meta.get("total_prompts", 0)

    if branch not in VALID_BRANCHES:
        add_error(f"meta.branch 值无效：{branch}", f"修改为 'A' 或 'B'。")

    if not work_mode:
        add_error(
            "meta.work_mode 字段缺失（v2.6 必填）",
            "添加 work_mode 字段，值为 constrained/semi_constrained/inference_only。"
        )
    elif work_mode not in VALID_WORK_MODES:
        add_error(
            f"meta.work_mode 值无效：{work_mode}",
            f"修改为以下之一：{sorted(VALID_WORK_MODES)}"
        )

    # ── 4. Visual Asset Summary 检查（v2.6 新增） ──
    vas = pack.get("visual_asset_summary")
    if vas is None:
        if work_mode in ("constrained", "semi_constrained"):
            add_warn(
                "缺少 visual_asset_summary（约束/半约束模式下建议提供）",
                "从 S1 视觉资产清单中提取关键数据填入 visual_asset_summary。"
            )
    else:
        # 校验 visual_asset_summary 与 S1 清单一致性
        if visual_manifest_path:
            try:
                with open(visual_manifest_path, "r", encoding="utf-8") as f:
                    manifest = json.load(f)
                manifest_primary = manifest.get("extracted_palette", {}).get("primary_color_guess")
                vas_primary = vas.get("primary_color")
                if manifest_primary and vas_primary and manifest_primary != vas_primary:
                    add_error(
                        f"visual_asset_summary.primary_color ({vas_primary}) 与 S1 清单 ({manifest_primary}) 不一致",
                        f"将 primary_color 修改为 S1 清单中的值：{manifest_primary}"
                    )
            except Exception as e:
                add_warn(f"S1 视觉资产清单加载失败，跳过一致性校验：{e}", "")

    # ── 5. Visual Identity 检查 ──
    vi = pack.get("visual_identity", {})

    # layer_1_symbolic
    l1 = vi.get("layer_1_symbolic", {})
    if not l1.get("asset_inheritance"):
        add_error("layer_1_symbolic.asset_inheritance 为空", "填写资产继承说明。")
    if not l1.get("super_sign"):
        add_error("layer_1_symbolic.super_sign 为空", "填写视觉符号体系定义。")

    # layer_2_language
    l2 = vi.get("layer_2_language", {})
    primary_color_raw = l2.get("primary_color", "")
    # 支持字符串或对象格式
    if isinstance(primary_color_raw, dict):
        primary_color = primary_color_raw.get("hex", "")
    else:
        primary_color = primary_color_raw

    if primary_color and not HEX_PATTERN.match(primary_color):
        add_error(
            f"主色 hex 格式无效：{primary_color}",
            "将 primary_color 修改为合法的 6 位 hex 格式，如 #6B21A8。"
        )

    for sc in l2.get("secondary_colors", []):
        color_val = sc.get("hex", sc) if isinstance(sc, dict) else sc
        if color_val and not HEX_PATTERN.match(color_val):
            add_error(f"辅色 hex 格式无效：{color_val}", "修改为合法的 hex 格式。")

    style_kw = l2.get("style_keywords", [])
    if len(style_kw) < 3:
        add_error(
            f"视觉风格关键词不足：{len(style_kw)}/3",
            f"在 style_keywords 中添加至少 {3 - len(style_kw)} 个风格关键词。"
        )

    # layer_3_emotion
    l3 = vi.get("layer_3_emotion", {})
    if not l3.get("core_vibe"):
        add_error("layer_3_emotion.core_vibe 为空", "填写核心情感调性。")

    # ── 6. Visual Motifs 检查 ──
    motifs = pack.get("visual_motifs", [])
    if not isinstance(motifs, list):
        add_error("visual_motifs 应为数组", "将 visual_motifs 修改为数组。")
        motifs = []

    if len(motifs) < 3:
        add_error(
            f"visual_motifs 数量不足：{len(motifs)}/3（最少 3 条）",
            f"补充至少 {3 - len(motifs)} 条视觉母题。"
        )
    elif len(motifs) > 5:
        add_warn(
            f"visual_motifs 数量过多：{len(motifs)}/5（最多 5 条）",
            f"精简至 5 条以内，保留最具代表性的母题。"
        )

    # 收集所有 motif 中使用的色值，用于后续约束模式校验
    all_motif_colors = set()

    for i, motif in enumerate(motifs):
        prefix = f"visual_motifs[{i}]"

        # 必填字段
        missing = [f for f in REQUIRED_MOTIF_FIELDS if f not in motif]
        if missing:
            add_error(
                f"{prefix} 缺少必填字段：{', '.join(missing)}",
                f"为 {prefix} 补充以下字段：{', '.join(missing)}。"
            )

        # motif_type 校验
        mt = motif.get("motif_type", "")
        if mt and mt not in VALID_MOTIF_TYPES:
            add_warn(
                f"{prefix} motif_type '{mt}' 不在标准列表中",
                f"修改为以下之一：{sorted(VALID_MOTIF_TYPES)}"
            )

        # positive_prompt 长度
        pp = motif.get("positive_prompt", "")
        if len(pp) < 50:
            add_error(
                f"{prefix} positive_prompt 过短：{len(pp)} 字符（最少 50）",
                f"将 positive_prompt 扩展至至少 50 个字符。"
            )

        # 检测 positive_prompt 中是否混入了 MJ 特定语法
        for marker in MJ_PROMPT_MARKERS:
            if marker in pp:
                add_warn(
                    f"{prefix} positive_prompt 中包含 MJ 特定语法 '{marker}'",
                    f"将 MJ 参数移至 tool_specific_params 中。"
                )
                break

        # color_hex 校验
        colors = motif.get("color_hex", [])
        if not colors:
            add_error(f"{prefix} color_hex 为空", f"添加至少一个品牌色 hex 值。")
        for c in colors:
            if not HEX_PATTERN.match(c):
                add_error(f"{prefix} color_hex 格式无效：{c}", f"修改为合法的 hex 格式。")
            else:
                all_motif_colors.add(c)

        # color_source 校验（v2.6 新增）
        cs = motif.get("color_source", "")
        if cs and cs not in VALID_COLOR_SOURCES:
            add_error(
                f"{prefix} color_source 值无效：{cs}",
                f"修改为以下之一：{sorted(VALID_COLOR_SOURCES)}"
            )

        # reference_assets 校验（v2.6 新增）
        refs = motif.get("reference_assets", [])
        if not isinstance(refs, list):
            add_error(f"{prefix} reference_assets 应为数组", "修改为数组格式。")

        # negative_prompt 检查
        neg = motif.get("negative_prompt", "")
        if len(neg) < 10:
            add_error(
                f"{prefix} negative_prompt 过短：{len(neg)} 字符",
                f"扩展至至少 10 字符。"
            )

        # aspect_ratio 格式校验
        ar = motif.get("aspect_ratio", "")
        if ar and not ASPECT_RATIO_PATTERN.match(ar):
            add_warn(
                f"{prefix} aspect_ratio 格式无效：{ar}（应为 W:H 格式如 16:9）",
                f"修改为 W:H 格式。"
            )

        # recommended_tool 校验
        rt = motif.get("recommended_tool", "")
        if rt and rt not in VALID_TOOLS:
            add_warn(
                f"{prefix} recommended_tool '{rt}' 不在标准列表中",
                f"修改为以下之一：{sorted(VALID_TOOLS)}"
            )

    # ── 7. 总数一致性 ──
    if total != len(motifs):
        add_warn(
            f"meta.total_prompts ({total}) 与 visual_motifs 实际数量 ({len(motifs)}) 不一致",
            f"将 meta.total_prompts 修改为 {len(motifs)}。"
        )

    # ── 8. 约束模式下的色彩锚定校验（v2.6 核心规则） ──
    if work_mode == "constrained" and vas:
        s1_colors = set()
        for c in (vas.get("logo_colors", []) + vas.get("dominant_palette", [])):
            if HEX_PATTERN.match(c):
                s1_colors.add(c.upper())

        if s1_colors:
            motif_colors_upper = {c.upper() for c in all_motif_colors}
            overlap = s1_colors & motif_colors_upper
            if not overlap:
                add_error(
                    f"约束模式下，visual_motifs 中的 color_hex 未包含任何 S1 提取的真实色值。"
                    f"S1 色值：{sorted(s1_colors)}，Motifs 色值：{sorted(motif_colors_upper)}",
                    f"至少在 1 条 motif 的 color_hex 中包含 S1 提取的品牌色。"
                )
            else:
                # 检查主色是否被使用
                s1_primary = vas.get("primary_color", "")
                if s1_primary and s1_primary.upper() not in motif_colors_upper:
                    add_warn(
                        f"S1 推测的品牌主色 {s1_primary} 未在任何 motif 的 color_hex 中出现",
                        f"建议在至少 1 条 motif 中使用品牌主色 {s1_primary}。"
                    )

    # ── 9. 色彩一致性校验（与话语 Token） ──
    if verbal_path and primary_color:
        try:
            with open(verbal_path, "r", encoding="utf-8") as f:
                verbal = json.load(f)
            if primary_color.upper() not in {c.upper() for c in all_motif_colors}:
                add_warn(
                    f"主色 {primary_color} 未在任何 motif 的 color_hex 中出现",
                    f"至少在 1 条 motif 的 color_hex 中包含品牌主色 {primary_color}。"
                )
        except Exception as e:
            add_warn(f"话语 Token 加载失败，跳过色彩一致性校验：{e}", "")

    # ── 10. 旧版结构残留检测 ──
    if "prompts" in pack:
        add_warn(
            "检测到旧版 'prompts' 字段残留，v2.6 已迁移至 'visual_motifs'",
            "删除 'prompts' 字段，确保所有 Prompt 在 'visual_motifs' 中。"
        )

    _print_report(errors, warnings, ai_fixes, ai_feedback)
    return 0 if not errors else 1


def _print_report(errors: list, warnings: list, ai_fixes: list = None,
                  ai_feedback: bool = False):
    """打印校验报告。"""
    print("=" * 60)
    print("视觉 Prompt 包校验报告（v2.6）")
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
            "validator": "S7_视觉Prompt包校验器_v2.6",
            "passed": len(errors) == 0,
            "error_count": len(errors),
            "warning_count": len(warnings),
            "fix_actions": ai_fixes,
            "instruction_to_s0": (
                "请将以上 fix_actions 逐条传递给 S7 节点进行修复。"
                "S7 修复后需重新提交校验。"
                "v2.6 特别注意：约束模式下必须使用 S1 提取的真实色值。"
            )
        }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="视觉 Prompt 包校验器 v2.6")
    parser.add_argument("prompt_pack_json", help="Prompt 包 JSON 文件路径")
    parser.add_argument("--verbal-tokens", default=None, help="话语 Token JSON 路径（可选）")
    parser.add_argument("--visual-manifest", default=None,
                        help="S1 视觉资产清单 JSON 路径（v2.6 新增，可选）")
    parser.add_argument("--ai-feedback", action="store_true",
                        help="输出 AI 可解析的 JSON 修正建议")
    args = parser.parse_args()
    sys.exit(validate_prompt_pack(
        args.prompt_pack_json, args.verbal_tokens,
        args.visual_manifest, args.ai_feedback
    ))
