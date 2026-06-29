#!/usr/bin/env python3
"""
话语 Token 命中率检查器
用途：检查文本内容中话语 Token 的命中率，确保内容与品牌话语体系一致。

用法：
  # 策略层抽检（S8 标准答案，阈值 30%）
  python3 token_hit_rate_checker.py --text-file S8_{brand}_问答报告.md \
    --verbal-tokens S6_{brand}_话语token.json --threshold 30

  # 执行层审查（E2 成稿，阈值 70%）
  python3 token_hit_rate_checker.py --text-file article.md \
    --verbal-tokens S6_{brand}_话语token.json --threshold 70

阈值说明：
  - 策略层（S8 标准答案抽检）：≥ 30%（策略层标准，因为标准答案是方向性指引）
  - 执行层（E2/E4 成稿审查）：≥ 70%（执行层标准，成稿必须高度品牌化）
  - 默认阈值：30%（策略层标准）

校验逻辑：
  - 高频词命中率 = 命中的高频词数 / 高频词总数 × 100%
  - 禁用词违规 = 零容忍（任何禁用词出现即标记为违规）
  - 综合命中率 = 高频词命中率 × 0.7 + (100 - 禁用词违规率) × 0.3
"""

import os
import sys
import json
import argparse


def check_hit_rate(text: str, verbal_path: str, threshold: float = 30.0) -> dict:
    """
    检查文本的话语 Token 命中率。

    Args:
        text: 待检查的文本
        verbal_path: 话语 Token JSON 文件路径
        threshold: 通过阈值（百分比），策略层默认 30%，执行层建议 70%

    Returns:
        检查结果字典
    """
    with open(verbal_path, "r", encoding="utf-8") as f:
        verbal = json.load(f)

    high_freq = verbal.get("high_freq_words", [])
    banned = verbal.get("banned_words", [])

    text_lower = text.lower()

    # 高频词命中
    hf_hits = [w for w in high_freq if w.lower() in text_lower]
    hf_rate = len(hf_hits) / len(high_freq) * 100 if high_freq else 0

    # 禁用词违规（零容忍）
    banned_hits = [w for w in banned if w.lower() in text_lower]
    banned_rate = len(banned_hits) / len(banned) * 100 if banned else 0

    # 综合命中率
    composite = hf_rate * 0.7 + (100 - banned_rate) * 0.3

    # 禁用词零容忍：即使综合命中率达标，有禁用词也不通过
    passed = composite >= threshold and len(banned_hits) == 0

    return {
        "high_freq_hit_rate": round(hf_rate, 1),
        "high_freq_hits": hf_hits,
        "high_freq_total": len(high_freq),
        "banned_violation_rate": round(banned_rate, 1),
        "banned_violations": banned_hits,
        "banned_total": len(banned),
        "composite_rate": round(composite, 1),
        "threshold": threshold,
        "passed": passed
    }


def main():
    parser = argparse.ArgumentParser(description="话语 Token 命中率检查器")
    parser.add_argument("--text-file", required=True, help="文本文件路径")
    parser.add_argument("--verbal-tokens", required=True, help="话语 Token JSON 文件路径")
    parser.add_argument("--threshold", type=float, default=30.0,
                        help="通过阈值（默认 30%%，策略层标准；执行层建议设为 70%%）")
    args = parser.parse_args()

    # 读取文本文件
    if not os.path.isfile(args.text_file):
        print(f"[错误] 文件不存在：{args.text_file}")
        sys.exit(1)

    with open(args.text_file, "r", encoding="utf-8") as f:
        text = f.read()

    if not text.strip():
        print(f"[错误] 文件为空：{args.text_file}")
        sys.exit(1)

    result = check_hit_rate(text, args.verbal_tokens, args.threshold)

    print("=" * 60)
    print("话语 Token 命中率报告")
    print("=" * 60)
    print(f"检查文件：{args.text_file}")
    print(f"话语 Token：{args.verbal_tokens}")
    print(f"阈值模式：{'策略层' if args.threshold <= 30 else '执行层'}（{args.threshold}%）")
    print()
    print(f"高频词命中：{len(result['high_freq_hits'])}/{result['high_freq_total']}（{result['high_freq_hit_rate']}%）")
    if result['high_freq_hits']:
        print(f"  命中词汇：{', '.join(result['high_freq_hits'][:20])}")
        if len(result['high_freq_hits']) > 20:
            print(f"  ...及其他 {len(result['high_freq_hits']) - 20} 个")
    print(f"禁用词违规：{len(result['banned_violations'])}/{result['banned_total']}（{result['banned_violation_rate']}%）")
    print(f"综合命中率：{result['composite_rate']}%（阈值 {result['threshold']}%）")

    if result["banned_violations"]:
        print(f"\n⚠️ 禁用词违规（零容忍）：{result['banned_violations']}")

    if result["passed"]:
        print("\n✅ 通过")
    else:
        print("\n❌ 未通过")
        if result["banned_violations"]:
            print("   原因：存在禁用词违规（零容忍）")
        elif result["composite_rate"] < result["threshold"]:
            print(f"   原因：综合命中率 {result['composite_rate']}% < 阈值 {result['threshold']}%")

    sys.exit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
