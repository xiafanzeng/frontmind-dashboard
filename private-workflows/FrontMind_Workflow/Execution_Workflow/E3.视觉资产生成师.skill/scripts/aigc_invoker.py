#!/usr/bin/env python3
"""
FrontMind E3 AIGC 调用封装器 (AIGC Invoker)

功能：
  - 从 S7 视觉 Prompt 包中提取模板并构建最终 Prompt
  - 根据 aigc_text_policy 注入文字控制后缀
  - 调用 AI 绘画工具生成图片
  - 验证生成结果（分辨率、文件大小、文字控制）
  - 输出生成元数据

用法：
  python3 aigc_invoker.py \\
    --s7-prompts "visual_prompts.json" \\
    --image-req "image_requirements.json" \\
    --fig-id "fig1" \\
    --brand "品牌名" \\
    --output-dir "./images/" \\
    --metadata-output "fig1_metadata.json"

依赖：
  pip3 install Pillow
"""

import argparse
import json
import os
import sys
from datetime import datetime
from typing import Dict, Optional, Tuple

# ============================================================
# AIGC 文字策略后缀映射
# ============================================================

TEXT_POLICY_SUFFIXES = {
    "allow_brand_name": (
        ', only text allowed is the brand name "{brand_name}", '
        'no other text, no sentences, no slogans, no paragraphs'
    ),
    "brand_poster_full_text": (
        ', include exact brand name "{brand_name}" and short key selling points, '
        'professional Chinese typography, clean media-ready layout, no watermark, no AI tool signature'
    ),
    "no_text": (
        ', no text, no words, no letters, no labels, '
        'no watermarks, no captions, no titles, no writing'
    ),
    "no_aigc": None,  # 不使用 AIGC 生成
}

# ============================================================
# 质量参数默认值
# ============================================================

DEFAULT_QUALITY_PARAMS = {
    "aigc_brand_poster": {
        "min_width": 1024,
        "min_height": 1024,
        "aspect_ratio": "1:1",
        "min_file_size_kb": 50,
    },

}


def load_s7_prompts(s7_path: str) -> Dict:
    """
    加载 S7 视觉 Prompt 包。

    Args:
        s7_path: S7 visual_prompts.json 路径

    Returns:
        S7 Prompt 包字典
    """
    if not os.path.exists(s7_path):
        print(f"警告: S7 Prompt 包不存在: {s7_path}", file=sys.stderr)
        return {}

    with open(s7_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def load_visual_manifest(manifest_path: str) -> Dict:
    """
    v2.6 新增：加载 S1 视觉资产清单。

    Args:
        manifest_path: S1_{brand}_视觉资产清单.json 路径

    Returns:
        视觉资产清单字典
    """
    if not manifest_path or not os.path.exists(manifest_path):
        print(f"警告: S1 视觉资产清单不存在: {manifest_path}", file=sys.stderr)
        return {}

    with open(manifest_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def load_image_requirements(req_path: str) -> Dict:
    """
    加载 E2 的图片需求清单。

    Args:
        req_path: image_requirements.json 路径

    Returns:
        图片需求字典
    """
    with open(req_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def build_final_prompt(s7_prompts: Dict, img_spec: Dict,
                       brand_name: str,
                       visual_manifest: Optional[Dict] = None) -> Tuple[str, Dict]:
    """
    构建最终的 AIGC Prompt。

    流程：
    1. 从 S7 包中提取 base_prompt
    2. 替换模板变量
    3. 叠加 E2 的 prompt_guidance
    4. 叠加 aigc_text_policy 后缀

    Args:
        s7_prompts: S7 Prompt 包
        img_spec: 单张图片的需求规格
        brand_name: 品牌名称

    Returns:
        (最终 Prompt, 构建元数据)
    """
    s7_ref = img_spec.get('s7_prompt_ref', '')
    text_policy = img_spec.get('aigc_text_policy', 'no_text')

    # 检查是否为 no_aigc 策略
    if text_policy == 'no_aigc':
        return '', {"error": "aigc_text_policy 为 no_aigc，不应调用 AIGC 生成"}

    # 提取 S7 基础 Prompt（v2.6: 支持 visual_motifs 数组结构）
    base_prompt = ''
    style_params = {}
    img2img_reference = None
    reference_assets = []
    color_source = 'inferred'
    recommended_tool = ''

    # v2.6: 从 visual_motifs 数组中查找匹配的 motif
    motif_found = False
    if s7_ref and 'visual_motifs' in s7_prompts:
        for motif in s7_prompts['visual_motifs']:
            if motif.get('motif_id') == s7_ref:
                base_prompt = motif.get('positive_prompt', '')
                style_params = {
                    'style_keywords': motif.get('style_keywords', []),
                    'color_hex': motif.get('color_hex', []),
                    'composition': motif.get('composition', ''),
                }
                img2img_reference = motif.get('img2img_reference')
                reference_assets = motif.get('reference_assets', [])
                color_source = motif.get('color_source', 'inferred')
                recommended_tool = motif.get('recommended_tool', '')
                motif_found = True
                break

    # 兼容旧版平坦结构
    if not motif_found and s7_ref and s7_ref in s7_prompts:
        template = s7_prompts[s7_ref]
        base_prompt = template.get('prompt', '')
        style_params = template.get('style', {})
    elif not motif_found:
        print(f"警告: S7 Prompt 引用 '{s7_ref}' 未找到，使用 prompt_guidance 作为基础",
              file=sys.stderr)
        base_prompt = img_spec.get('prompt_guidance', '')

    # v2.6.1 修正：从 visual_manifest 中补充 Logo 参考
    # 修复字段错位问题 - 正确路径为 assets.logos (而非顺顶级 logo_files)
    # 增加空值防御和 降级模式识别
    if not img2img_reference and visual_manifest:
        # 优先从 v2.6 新结构 assets.logos 读取
        logos = visual_manifest.get('assets', {}).get('logos', [])
        if logos and isinstance(logos, list) and len(logos) > 0:
            img2img_reference = logos[0].get('local_path')
        else:
            # 向后兼容旧字段 logo_files
            logo_files = visual_manifest.get('logo_files', [])
            if logo_files and isinstance(logo_files, list) and len(logo_files) > 0:
                img2img_reference = logo_files[0].get('local_path')

    # v2.6.1 新增：检测 work_mode，inference_only 模式下强制禁用 img2img
    work_mode = 'constrained'
    if visual_manifest:
        meta = visual_manifest.get('meta', {})
        work_mode = meta.get('work_mode', 'constrained')
        # 也可以基于 summary 判断
        summary = visual_manifest.get('summary', {})
        has_logo = summary.get('has_logo', False)
        total = summary.get('total_assets_downloaded', 0)
        if not has_logo and total == 0:
            work_mode = 'inference_only'

    if work_mode == 'inference_only':
        # 无资产兑底模式：彻底放弃 img2img，回落到纯 text2img
        img2img_reference = None
        # 尝试从 S7 Prompt 包的 inferred_palette 读取推导色
        inferred_palette = s7_prompts.get('visual_asset_summary', {}).get('inferred_palette', {})
        if inferred_palette and not style_params.get('color_hex'):
            inferred_colors = []
            if inferred_palette.get('primary'):
                inferred_colors.append(inferred_palette['primary'])
            if inferred_palette.get('secondary'):
                inferred_colors.extend(inferred_palette['secondary'] if isinstance(inferred_palette['secondary'], list) else [inferred_palette['secondary']])
            if inferred_colors:
                style_params['color_hex'] = inferred_colors
                color_source = 'inferred_from_positioning'

    # 替换模板变量
    base_prompt = base_prompt.replace('{brand_name}', brand_name)
    base_prompt = base_prompt.replace('{industry}', img_spec.get('context', ''))

    # 叠加 E2 的 prompt_guidance
    guidance = img_spec.get('prompt_guidance', '')
    if guidance and guidance not in base_prompt:
        base_prompt = f"{base_prompt}, {guidance}"

    # 叠加文字控制后缀
    suffix_template = TEXT_POLICY_SUFFIXES.get(text_policy, '')
    if suffix_template:
        suffix = suffix_template.format(brand_name=brand_name)
        base_prompt = f"{base_prompt}{suffix}"

    # v2.6: 判断生成策略
    generation_strategy = 'text2img'
    tool_params = {}
    if img2img_reference and os.path.exists(img2img_reference):
        generation_strategy = 'img2img'
        if recommended_tool == 'Midjourney':
            tool_params = {'cref': img2img_reference, 'cw': 60}
        elif recommended_tool in ('Flux.1', 'SDXL'):
            tool_params = {
                'ip_adapter_image': img2img_reference,
                'ip_adapter_weight': 0.4,
            }

    metadata = {
        "s7_prompt_ref": s7_ref,
        "s7_found": motif_found if 'visual_motifs' in s7_prompts else bool(s7_ref and s7_ref in s7_prompts),
        "text_policy": text_policy,
        "style_params": style_params,
        "prompt_length": len(base_prompt),
        "generation_strategy": generation_strategy,
        "img2img_reference": img2img_reference,
        "reference_assets": reference_assets,
        "color_source": color_source,
        "recommended_tool": recommended_tool or "gpt-image-2",
        "required_generation_tool": img_spec.get("required_generation_tool", "gpt-image-2"),
        "final_asset_origin_required": img_spec.get("final_asset_origin_required", ["gpt-image-2", "approved_image_generation_model"]),
        "html_draft_allowed": img_spec.get("html_draft_allowed", False),
        "tool_params": tool_params,
    }

    return base_prompt, metadata


def validate_generated_image(image_path: str, img_type: str) -> Dict:
    """
    验证生成的 AIGC 图片质量。

    检查项：
    - 文件存在性
    - 文件大小 ≥ 10KB
    - 分辨率达标
    - 格式正确

    Args:
        image_path: 生成的图片路径
        img_type: 图片类型

    Returns:
        验证结果字典
    """
    result = {
        "path": image_path,
        "passed": True,
        "checks": {},
    }

    # 文件存在性
    if not os.path.exists(image_path):
        result["passed"] = False
        result["checks"]["exists"] = False
        return result
    result["checks"]["exists"] = True

    # 文件大小
    size_kb = os.path.getsize(image_path) / 1024
    quality = DEFAULT_QUALITY_PARAMS.get(img_type, {"min_file_size_kb": 10})
    min_size = quality.get("min_file_size_kb", 10)
    result["checks"]["file_size"] = {
        "actual_kb": round(size_kb, 2),
        "min_kb": min_size,
        "passed": size_kb >= min_size,
    }
    if not result["checks"]["file_size"]["passed"]:
        result["passed"] = False

    # 分辨率检查（需要 Pillow）
    try:
        from PIL import Image
        img = Image.open(image_path)
        width, height = img.size
        min_w = quality.get("min_width", 800)
        min_h = quality.get("min_height", 600)
        result["checks"]["resolution"] = {
            "actual": f"{width}x{height}",
            "min": f"{min_w}x{min_h}",
            "passed": width >= min_w and height >= min_h,
        }
        if not result["checks"]["resolution"]["passed"]:
            result["passed"] = False
    except ImportError:
        result["checks"]["resolution"] = {"note": "Pillow 未安装，跳过分辨率检查"}
    except Exception as e:
        result["checks"]["resolution"] = {"error": str(e)}

    return result


def generate_metadata(fig_id: str, img_spec: Dict, prompt: str,
                      prompt_meta: Dict, validation: Dict,
                      output_path: str) -> Dict:
    """
    生成图片元数据。

    Args:
        fig_id: 图片编号
        img_spec: 原始需求规格
        prompt: 最终使用的 Prompt
        prompt_meta: Prompt 构建元数据
        validation: 验证结果
        output_path: 输出图片路径

    Returns:
        完整元数据字典
    """
    required_tool = img_spec.get("required_generation_tool", "gpt-image-2")
    return {
        "fig_id": fig_id,
        "type": img_spec.get("type", ""),
        "generation_method": img_spec.get("generation_method", "ai_generate_brand_poster"),
        "required_generation_tool": required_tool,
        "final_asset_origin": required_tool,
        "finalization_method": "image_generation_final" if img_spec.get("type") == "aigc_brand_poster" else "generated_final",
        "render_stage": "final",
        "html_draft_used": False,
        "prompt_used": prompt,
        "s7_prompt_ref": prompt_meta.get("s7_prompt_ref", ""),
        "aigc_text_policy": img_spec.get("aigc_text_policy", ""),
        "style_params": prompt_meta.get("style_params", {}),
        "output_path": output_path,
        "validation": validation,
        "generated_at": datetime.now().isoformat(),
    }


def main():
    parser = argparse.ArgumentParser(description="FrontMind E3 AIGC 调用封装器")
    parser.add_argument("--s7-prompts", required=True, help="S7 visual_prompts.json 路径")
    parser.add_argument("--image-req", required=True, help="image_requirements.json 路径")
    parser.add_argument("--fig-id", required=True, help="要生成的图片编号（如 fig1）")
    parser.add_argument("--brand", required=True, help="品牌名称")
    parser.add_argument("--output-dir", default="./images/", help="输出目录")
    parser.add_argument("--metadata-output", default=None, help="元数据输出路径")
    parser.add_argument("--generated-image", default=None,
                        help="已由 gpt-image-2/批准图像模型生成的终稿图片路径；A类首图/品牌海报必须提供")
    parser.add_argument("--visual-manifest", default=None,
                        help="v2.6: S1 视觉资产清单 JSON 路径")

    args = parser.parse_args()

    # 加载数据
    s7_prompts = load_s7_prompts(args.s7_prompts)
    requirements = load_image_requirements(args.image_req)
    visual_manifest = load_visual_manifest(args.visual_manifest) if args.visual_manifest else None

    # 找到目标图片规格
    target_spec = None
    for img in requirements.get('images', []):
        if img.get('fig_id') == args.fig_id:
            target_spec = img
            break

    if not target_spec:
        print(f"错误: 未找到 fig_id='{args.fig_id}' 的图片需求", file=sys.stderr)
        sys.exit(1)

    # 构建 Prompt
    prompt, prompt_meta = build_final_prompt(s7_prompts, target_spec, args.brand, visual_manifest)

    if not prompt:
        print(f"错误: 无法构建 Prompt - {prompt_meta.get('error', '未知错误')}", file=sys.stderr)
        sys.exit(1)

    print(f"最终 Prompt ({len(prompt)} 字符):")
    print(f"  {prompt[:200]}...")

    required_tool = target_spec.get("required_generation_tool", "gpt-image-2")
    finalization_required = bool(target_spec.get("finalization_required", False) or target_spec.get("type") == "aigc_brand_poster")

    # V11：A类首图/品牌海报不得只输出 prompt 或 HTML 草图。必须先用 gpt-image-2/批准图像模型生成终稿，再回填真实图片路径。
    if finalization_required and not args.generated_image:
        pending_metadata = {
            "fig_id": args.fig_id,
            "type": target_spec.get("type", ""),
            "generation_method": target_spec.get("generation_method", "ai_generate_brand_poster"),
            "required_generation_tool": required_tool,
            "final_asset_origin": "pending_" + required_tool,
            "finalization_method": "pending_image_generation_final",
            "render_stage": "pending_generation",
            "html_draft_used": False,
            "prompt_used": prompt,
            "s7_prompt_ref": prompt_meta.get("s7_prompt_ref", ""),
            "validation": {"passed": False, "reason": "final image not generated yet"},
            "generated_at": datetime.now().isoformat(),
        }
        if args.metadata_output:
            os.makedirs(os.path.dirname(args.metadata_output) or '.', exist_ok=True)
            with open(args.metadata_output, 'w', encoding='utf-8') as f:
                json.dump(pending_metadata, f, ensure_ascii=False, indent=2)
        print("\n错误: 该图片位要求终稿化生成，不能仅输出 Prompt 或 HTML/CSS/PPT 草图。", file=sys.stderr)
        print(f"请先使用 {required_tool} 或批准的同级图像模型生成终稿，再使用 --generated-image 传入真实图片路径。", file=sys.stderr)
        sys.exit(2)

    if args.generated_image:
        validation = validate_generated_image(args.generated_image, target_spec.get("type", "aigc_brand_poster"))
        if not validation.get("passed"):
            if args.metadata_output:
                metadata = generate_metadata(args.fig_id, target_spec, prompt, prompt_meta, validation, args.generated_image)
                metadata["render_stage"] = "failed_validation"
                os.makedirs(os.path.dirname(args.metadata_output) or '.', exist_ok=True)
                with open(args.metadata_output, 'w', encoding='utf-8') as f:
                    json.dump(metadata, f, ensure_ascii=False, indent=2)
            print(f"错误: 终稿图片质量校验未通过: {validation}", file=sys.stderr)
            sys.exit(3)
        output_image_path = args.generated_image
    else:
        print(f"\n请使用 generate 工具执行此 Prompt 生成图片。")
        print(f"生成后将图片保存到: {args.output_dir}")
        output_image_path = args.output_dir
        validation = {"note": "awaiting generation", "passed": False}

    # 输出元数据。只有提供并验证真实 generated-image 时，A类首图/品牌海报才会标记 render_stage=final。
    if args.metadata_output:
        metadata = generate_metadata(
            args.fig_id, target_spec, prompt, prompt_meta,
            validation, output_image_path
        )
        os.makedirs(os.path.dirname(args.metadata_output) or '.', exist_ok=True)
        with open(args.metadata_output, 'w', encoding='utf-8') as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)
        print(f"\n元数据已保存: {args.metadata_output}")


if __name__ == "__main__":
    main()
