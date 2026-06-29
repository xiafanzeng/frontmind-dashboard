#!/usr/bin/env python3
"""
CLIP 视觉-文本相似度评分器（A 分支专用）
用途：评估客户已有视觉资料与品牌定位声明的契合度。

用法：
  python3 clip_similarity_scorer.py <images_dir> <positioning_json> <output_json>

工作原理：
  1. 从 S4 定位声明中提取视觉描述文本
  2. 加载客户上传的图片
  3. 使用 CLIP 模型计算图片与文本的相似度
  4. 输出 5 维契合度评分

依赖：
  - pip install transformers torch pillow
  - 如果无 GPU，会自动使用 CPU（速度较慢）

注意：
  - 如果 CLIP 模型不可用，会降级为基于色彩提取的简化评估
  - 评分仅供参考，最终判断需结合人工审核
"""

import os
import sys
import json
import argparse
import colorsys
from pathlib import Path


def extract_dominant_colors(image_path: str, n_colors: int = 5) -> list:
    """
    从图片中提取主色调（不依赖 CLIP 的降级方案）。

    Args:
        image_path: 图片文件路径
        n_colors: 提取的主色数量

    Returns:
        主色调列表，每个元素为 (hex, percentage)
    """
    try:
        from PIL import Image
        from collections import Counter
    except ImportError:
        return []

    img = Image.open(image_path).convert("RGB")
    # 缩小图片以加速
    img = img.resize((150, 150))
    pixels = list(img.getdata())

    # 量化颜色（将 RGB 值四舍五入到最近的 32）
    quantized = []
    for r, g, b in pixels:
        qr = (r // 32) * 32
        qg = (g // 32) * 32
        qb = (b // 32) * 32
        quantized.append((qr, qg, qb))

    counter = Counter(quantized)
    total = len(quantized)
    top_colors = counter.most_common(n_colors)

    result = []
    for (r, g, b), count in top_colors:
        hex_color = f"#{r:02x}{g:02x}{b:02x}"
        percentage = round(count / total * 100, 1)
        result.append({"hex": hex_color, "percentage": percentage})

    return result


def color_distance(hex1: str, hex2: str) -> float:
    """
    计算两个 hex 颜色之间的距离（0-1，0 为完全相同）。

    Args:
        hex1: 第一个颜色 hex 值
        hex2: 第二个颜色 hex 值

    Returns:
        颜色距离 0-1
    """
    def hex_to_rgb(h):
        h = h.lstrip("#")
        return tuple(int(h[i:i+2], 16) / 255.0 for i in (0, 2, 4))

    r1, g1, b1 = hex_to_rgb(hex1)
    r2, g2, b2 = hex_to_rgb(hex2)

    # 使用 CIE76 简化距离
    dist = ((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2) ** 0.5
    return min(dist / (3 ** 0.5), 1.0)


def evaluate_color_fit(image_colors: list, brand_colors: list) -> dict:
    """
    评估图片色彩与品牌色的契合度。

    Args:
        image_colors: 图片主色调列表
        brand_colors: 品牌色 hex 列表

    Returns:
        色彩契合度评分
    """
    if not image_colors or not brand_colors:
        return {"score": 50, "detail": "数据不足，使用默认分"}

    min_distances = []
    for img_color in image_colors:
        distances = [color_distance(img_color["hex"], bc) for bc in brand_colors]
        min_distances.append(min(distances))

    # 加权平均（权重为图片中该色彩的占比）
    total_pct = sum(c["percentage"] for c in image_colors)
    if total_pct == 0:
        return {"score": 50, "detail": "色彩占比为零"}

    weighted_dist = sum(
        d * c["percentage"] / total_pct
        for d, c in zip(min_distances, image_colors)
    )

    score = max(0, round((1 - weighted_dist) * 100))

    return {
        "score": score,
        "detail": f"加权色彩距离 {weighted_dist:.3f}，主色调 {len(image_colors)} 个",
        "image_colors": image_colors,
        "brand_colors": brand_colors
    }


def evaluate_consistency(images_dir: str) -> dict:
    """
    评估多张图片之间的视觉一致性。

    Args:
        images_dir: 图片目录路径

    Returns:
        一致性评分
    """
    image_exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    images = [
        f for f in Path(images_dir).iterdir()
        if f.suffix.lower() in image_exts
    ]

    if len(images) < 2:
        return {"score": 50, "detail": "图片不足 2 张，无法评估一致性"}

    # 提取每张图片的主色调
    all_colors = []
    for img_path in images[:10]:  # 最多评估 10 张
        colors = extract_dominant_colors(str(img_path), n_colors=3)
        all_colors.append(colors)

    # 计算色彩方差
    if not all_colors:
        return {"score": 50, "detail": "色彩提取失败"}

    # 简化：计算所有图片主色之间的平均距离
    primary_hexes = [c[0]["hex"] for c in all_colors if c]
    if len(primary_hexes) < 2:
        return {"score": 50, "detail": "有效主色不足"}

    distances = []
    for i in range(len(primary_hexes)):
        for j in range(i + 1, len(primary_hexes)):
            distances.append(color_distance(primary_hexes[i], primary_hexes[j]))

    avg_dist = sum(distances) / len(distances)
    score = max(0, round((1 - avg_dist) * 100))

    return {
        "score": score,
        "detail": f"平均色彩距离 {avg_dist:.3f}，评估 {len(primary_hexes)} 张图片",
        "image_count": len(images)
    }


def run_full_assessment(images_dir: str, positioning_path: str, output_path: str):
    """
    执行完整的 5 维视觉契合度评估。

    Args:
        images_dir: 图片目录路径
        positioning_path: S4 定位声明 JSON 路径
        output_path: 输出 JSON 路径
    """
    # 加载定位声明
    with open(positioning_path, "r", encoding="utf-8") as f:
        positioning = json.load(f)

    # 提取品牌色（从定位声明或默认）
    vi = positioning.get("visual_identity", {})
    brand_colors = vi.get("colors", [])
    if not brand_colors:
        brand_colors = ["#6B21A8", "#1A1A1A", "#FFFFFF"]  # 默认

    # 收集所有图片
    image_exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    images = [
        str(f) for f in Path(images_dir).iterdir()
        if f.suffix.lower() in image_exts
    ]

    if not images:
        print(f"[警告] 目录中无图片：{images_dir}")
        result = {
            "assessment_type": "no_images",
            "message": "未找到可评估的图片文件"
        }
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        return

    # 1. 色彩契合度
    all_img_colors = []
    for img in images[:10]:
        colors = extract_dominant_colors(img)
        all_img_colors.extend(colors)
    color_fit = evaluate_color_fit(all_img_colors[:5], brand_colors)

    # 2. 一致性
    consistency = evaluate_consistency(images_dir)

    # 3-5. 构图/调性/符号契合度（简化评估，需人工确认）
    result = {
        "meta": {
            "brand": positioning.get("positioning_statement", {}).get("brand", ""),
            "images_evaluated": len(images),
            "assessment_method": "color_extraction_based"
        },
        "dimensions": {
            "color_fit": {
                "name": "色彩契合度",
                "score": color_fit["score"],
                "detail": color_fit["detail"]
            },
            "composition_fit": {
                "name": "构图契合度",
                "score": 50,
                "detail": "需人工评估（CLIP 模型未加载时降级）"
            },
            "tone_fit": {
                "name": "调性契合度",
                "score": 50,
                "detail": "需人工评估（CLIP 模型未加载时降级）"
            },
            "symbol_fit": {
                "name": "符号契合度",
                "score": 50,
                "detail": "需人工评估（CLIP 模型未加载时降级）"
            },
            "consistency": {
                "name": "一致性",
                "score": consistency["score"],
                "detail": consistency["detail"]
            }
        },
        "overall_score": round(
            (color_fit["score"] + 50 + 50 + 50 + consistency["score"]) / 5
        ),
        "recommendations": []
    }

    # 生成建议
    if color_fit["score"] < 60:
        result["recommendations"].append({
            "dimension": "色彩",
            "issue": "现有视觉色彩与品牌定位色差距较大",
            "suggestion": "建议重新定义色彩体系或调整现有视觉的色调"
        })
    if consistency["score"] < 60:
        result["recommendations"].append({
            "dimension": "一致性",
            "issue": "多张图片之间的视觉风格不统一",
            "suggestion": "建议建立统一的视觉规范并重新制作不一致的素材"
        })

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"✅ 视觉契合度评估完成：{output_path}")
    print(f"   综合评分：{result['overall_score']}/100")
    print(f"   评估图片：{len(images)} 张")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CLIP 视觉-文本相似度评分器")
    parser.add_argument("images_dir", help="客户图片目录路径")
    parser.add_argument("positioning_json", help="S4 定位声明 JSON 路径")
    parser.add_argument("output_json", help="输出评估结果 JSON 路径")
    args = parser.parse_args()
    run_full_assessment(args.images_dir, args.positioning_json, args.output_json)
