#!/usr/bin/env python3
"""
定位 Gap 计算器
用途：将 AI 平台实际呈现的品牌信息与 S4 定位声明对标，计算 7 维 Gap 偏差。

用法：
  python3 gap_calculator.py <monitoring_json> <positioning_json> <output_json>

输入：
  - monitoring_json: AI 可见性监测数据（用户上传）
  - positioning_json: S4 品牌定位声明 JSON

输出：
  - output_json: Gap 分析结果 JSON

7 维 Gap 框架：
  1. 人群 Gap：AI 回答隐含受众 vs 理想受众
  2. 品类 Gap：AI 归类 vs 理想品类
  3. 差异点 Gap：AI 描述特点 vs 理想差异点
  4. 功能价值 Gap：AI 提及功能 vs 理想功能价值
  5. 情感价值 Gap：AI 传达情感 vs 理想情感价值
  6. 证据 Gap：AI 引用证据 vs 理想证据
  7. 话语 Gap：AI 用词 vs 理想话语
"""

import os
import sys
import json
import argparse
import re
from collections import Counter


def load_json(path: str) -> dict:
    """
    安全加载 JSON 文件。

    Args:
        path: JSON 文件路径

    Returns:
        解析后的字典
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"[错误] 无法加载 {path}：{e}")
        sys.exit(1)


def extract_ai_texts(monitoring: dict) -> list:
    """
    从监测数据中提取所有 AI 回答文本。

    Args:
        monitoring: 监测数据字典

    Returns:
        AI 回答文本列表
    """
    texts = []
    responses = monitoring.get("responses", [])
    for resp in responses:
        answers = resp.get("answers", {})
        for platform, answer in answers.items():
            text = answer.get("text", "")
            if text:
                texts.append(text)
    return texts


def keyword_match_score(texts: list, keywords: list) -> float:
    """
    计算关键词在文本集合中的匹配度。

    Args:
        texts: 文本列表
        keywords: 关键词列表

    Returns:
        匹配度分数 0-100
    """
    if not keywords or not texts:
        return 0.0

    combined_text = " ".join(texts).lower()
    matched = sum(1 for kw in keywords if kw.lower() in combined_text)
    return (matched / len(keywords)) * 100


def calculate_audience_gap(texts: list, positioning: dict) -> dict:
    """
    计算人群 Gap：AI 回答隐含受众 vs 理想受众。

    Args:
        texts: AI 回答文本列表
        positioning: 定位声明字典

    Returns:
        Gap 分析结果
    """
    stmt = positioning.get("positioning_statement", {})
    ideal_audience = str(stmt.get("target_audience", ""))

    # 提取理想受众关键词
    audience_keywords = [w for w in ideal_audience.split() if len(w) > 1]

    score = keyword_match_score(texts, audience_keywords)

    return {
        "dimension": "人群 Gap",
        "ideal_state": ideal_audience,
        "actual_state": f"AI 回答中 {score:.0f}% 的受众关键词被提及",
        "gap_score": round(100 - score),
        "fix_priority": "high" if score < 50 else ("medium" if score < 70 else "low"),
        "fix_suggestion": "在品牌内容中强化目标人群画像描述" if score < 70 else "维持现状"
    }


def calculate_category_gap(texts: list, positioning: dict) -> dict:
    """
    计算品类 Gap：AI 归类 vs 理想品类。

    Args:
        texts: AI 回答文本列表
        positioning: 定位声明字典

    Returns:
        Gap 分析结果
    """
    stmt = positioning.get("positioning_statement", {})
    ideal_category = str(stmt.get("category", ""))

    category_keywords = [w for w in ideal_category.split() if len(w) > 1]
    score = keyword_match_score(texts, category_keywords)

    return {
        "dimension": "品类 Gap",
        "ideal_state": ideal_category,
        "actual_state": f"AI 回答中 {score:.0f}% 的品类关键词被提及",
        "gap_score": round(100 - score),
        "fix_priority": "high" if score < 50 else ("medium" if score < 70 else "low"),
        "fix_suggestion": "通过权威内容强化品类归属认知" if score < 70 else "维持现状"
    }


def calculate_differentiator_gap(texts: list, positioning: dict) -> dict:
    """
    计算差异点 Gap：AI 描述特点 vs 理想差异点。

    Args:
        texts: AI 回答文本列表
        positioning: 定位声明字典

    Returns:
        Gap 分析结果
    """
    stmt = positioning.get("positioning_statement", {})
    ideal_diff = str(stmt.get("differentiator", ""))

    diff_keywords = [w for w in ideal_diff.split() if len(w) > 1]
    score = keyword_match_score(texts, diff_keywords)

    return {
        "dimension": "差异点 Gap",
        "ideal_state": ideal_diff,
        "actual_state": f"AI 回答中 {score:.0f}% 的差异化关键词被提及",
        "gap_score": round(100 - score),
        "fix_priority": "high" if score < 50 else ("medium" if score < 70 else "low"),
        "fix_suggestion": "创建差异化内容资产（案例/白皮书/评测）" if score < 70 else "维持现状"
    }


def calculate_value_gap(texts: list, positioning: dict, value_type: str) -> dict:
    """
    计算价值 Gap（功能价值或情感价值）。

    Args:
        texts: AI 回答文本列表
        positioning: 定位声明字典
        value_type: "functional_value" 或 "emotional_value"

    Returns:
        Gap 分析结果
    """
    triangle = positioning.get("value_triangle", {})
    ideal_value = str(triangle.get(value_type, ""))

    dim_name = "功能价值 Gap" if value_type == "functional_value" else "情感价值 Gap"
    value_keywords = [w for w in ideal_value.split() if len(w) > 1]
    score = keyword_match_score(texts, value_keywords)

    return {
        "dimension": dim_name,
        "ideal_state": ideal_value,
        "actual_state": f"AI 回答中 {score:.0f}% 的价值关键词被提及",
        "gap_score": round(100 - score),
        "fix_priority": "high" if score < 50 else ("medium" if score < 70 else "low"),
        "fix_suggestion": f"强化{dim_name.replace(' Gap', '')}相关内容传播" if score < 70 else "维持现状"
    }


def calculate_evidence_gap(texts: list, positioning: dict) -> dict:
    """
    计算证据 Gap：AI 引用证据 vs 理想证据。

    Args:
        texts: AI 回答文本列表
        positioning: 定位声明字典

    Returns:
        Gap 分析结果
    """
    stmt = positioning.get("positioning_statement", {})
    evidence = stmt.get("evidence", [])

    if not evidence:
        return {
            "dimension": "证据 Gap",
            "ideal_state": "定位声明中无证据列表",
            "actual_state": "无法对标",
            "gap_score": 50,
            "fix_priority": "medium",
            "fix_suggestion": "补充定位声明中的证据列表"
        }

    evidence_keywords = []
    for ev in evidence:
        evidence_keywords.extend([w for w in str(ev).split() if len(w) > 1])

    score = keyword_match_score(texts, evidence_keywords)

    return {
        "dimension": "证据 Gap",
        "ideal_state": f"{len(evidence)} 条支撑证据",
        "actual_state": f"AI 回答中 {score:.0f}% 的证据关键词被提及",
        "gap_score": round(100 - score),
        "fix_priority": "high" if score < 50 else ("medium" if score < 70 else "low"),
        "fix_suggestion": "发布权威证据内容（第三方评测/认证/案例）" if score < 70 else "维持现状"
    }


def calculate_verbal_gap(texts: list, verbal_tokens: dict) -> dict:
    """
    计算话语 Gap：AI 用词 vs 理想话语（如有 S6 话语 token）。

    Args:
        texts: AI 回答文本列表
        verbal_tokens: S6 话语 token 字典（可为空）

    Returns:
        Gap 分析结果
    """
    if not verbal_tokens:
        return {
            "dimension": "话语 Gap",
            "ideal_state": "S6 话语 token 尚未生成",
            "actual_state": "待 S6 完成后补充对标",
            "gap_score": 50,
            "fix_priority": "medium",
            "fix_suggestion": "S6 完成后重新运行 Gap 分析"
        }

    high_freq = verbal_tokens.get("high_freq_words", [])
    banned = verbal_tokens.get("banned_words", [])

    # 高频词命中率
    hf_score = keyword_match_score(texts, high_freq)

    # 禁用词出现率（越低越好）
    combined = " ".join(texts).lower()
    banned_hits = sum(1 for w in banned if w.lower() in combined)
    banned_rate = (banned_hits / len(banned)) * 100 if banned else 0

    score = hf_score * 0.6 + (100 - banned_rate) * 0.4

    return {
        "dimension": "话语 Gap",
        "ideal_state": f"高频词 {len(high_freq)} 个 / 禁用词 {len(banned)} 个",
        "actual_state": f"高频词命中 {hf_score:.0f}% / 禁用词出现 {banned_rate:.0f}%",
        "gap_score": round(100 - score),
        "fix_priority": "high" if score < 50 else ("medium" if score < 70 else "low"),
        "fix_suggestion": "通过 GEO 内容强化品牌话语渗透" if score < 70 else "维持现状"
    }


def calculate_all_gaps(monitoring: dict, positioning: dict, verbal_tokens: dict = None) -> list:
    """
    计算全部 7 维 Gap。

    Args:
        monitoring: 监测数据
        positioning: 定位声明
        verbal_tokens: S6 话语 token（可选）

    Returns:
        7 维 Gap 分析结果列表
    """
    texts = extract_ai_texts(monitoring)

    gaps = [
        calculate_audience_gap(texts, positioning),
        calculate_category_gap(texts, positioning),
        calculate_differentiator_gap(texts, positioning),
        calculate_value_gap(texts, positioning, "functional_value"),
        calculate_value_gap(texts, positioning, "emotional_value"),
        calculate_evidence_gap(texts, positioning),
        calculate_verbal_gap(texts, verbal_tokens or {}),
    ]

    return gaps


def main():
    """CLI 入口。"""
    parser = argparse.ArgumentParser(description="定位 Gap 计算器")
    parser.add_argument("monitoring_json", help="AI 监测数据 JSON")
    parser.add_argument("positioning_json", help="S4 定位声明 JSON")
    parser.add_argument("output_json", help="输出 Gap 分析 JSON")
    parser.add_argument("--verbal-tokens", default=None, help="S6 话语 token JSON（可选）")
    args = parser.parse_args()

    monitoring = load_json(args.monitoring_json)
    positioning = load_json(args.positioning_json)
    verbal_tokens = load_json(args.verbal_tokens) if args.verbal_tokens else None

    gaps = calculate_all_gaps(monitoring, positioning, verbal_tokens)

    result = {
        "brand": positioning.get("positioning_statement", {}).get("brand", ""),
        "gap_count": len(gaps),
        "high_priority_count": sum(1 for g in gaps if g["fix_priority"] == "high"),
        "avg_gap_score": round(sum(g["gap_score"] for g in gaps) / len(gaps), 1),
        "gaps": gaps,
    }

    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"✅ Gap 分析完成：{args.output_json}")
    print(f"   高优先级 Gap：{result['high_priority_count']}/{result['gap_count']}")
    print(f"   平均偏差分：{result['avg_gap_score']}")


if __name__ == "__main__":
    main()
