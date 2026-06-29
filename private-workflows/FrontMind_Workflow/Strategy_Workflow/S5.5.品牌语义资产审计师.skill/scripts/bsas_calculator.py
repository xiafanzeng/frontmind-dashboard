#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FrontMind BSAS 评分计算器
用途：基于采集的原始数据计算品牌语义资产评分（Brand Semantic Asset Score）。

用法：
  python3 bsas_calculator.py --input <raw_data.json> --output <scorecard.json> [--ai-feedback]

输入：原始数据 JSON（包含各维度的原始采集值）
输出：BSAS 评分卡 JSON（符合 bsas_scorecard_schema.json）
"""

from __future__ import annotations

import os
import sys
import json
import argparse
from typing import Any, Dict, List, Optional, Tuple


# ============================================================
# 评分权重配置
# ============================================================
DIMENSION_WEIGHTS = {
    "semantic_visibility": {
        "max_score": 30,
        "sub_indicators": {
            "ai_search_visibility": {"max_score": 15},
            "web_search_sov": {"max_score": 10},
            "multi_platform_coverage": {"max_score": 5}
        }
    },
    "semantic_coherence": {
        "max_score": 20,
        "sub_indicators": {
            "core_proposition_hit_rate": {"max_score": 12},
            "tone_deviation_rate": {"max_score": 8}
        }
    },
    "semantic_richness": {
        "max_score": 20,
        "sub_indicators": {
            "question_stage_coverage": {"max_score": 10},
            "semantic_entity_richness": {"max_score": 6},
            "content_format_diversity": {"max_score": 4}
        }
    },
    "semantic_authority": {
        "max_score": 15,
        "sub_indicators": {
            "authoritative_source_ratio": {"max_score": 8},
            "structured_data_completeness": {"max_score": 4},
            "third_party_endorsement": {"max_score": 3}
        }
    },
    "competitive_advantage": {
        "max_score": 15,
        "sub_indicators": {
            "first_mention_rate": {"max_score": 8},
            "exclusive_semantic_space": {"max_score": 7}
        },
        "diagnostic_sub_indicators": {
            "rank_quality_score": {"max_score": 10, "non_additive": True}
        }
    }
}

# 等级判定
GRADE_THRESHOLDS = [
    (80, "A"),
    (60, "B"),
    (40, "C"),
    (20, "D"),
    (0, "E")
]

RANK_DISTRIBUTION_KEYS = ["rank_1", "rank_2_3", "rank_4_5", "rank_6_10", "rank_11_plus"]
REPUTATION_QUESTION_KEYWORDS = [
    "缺点", "问题", "投诉", "差评", "负面", "口碑", "黑料", "风险", "纠纷", "争议",
    "售后", "质量问题", "坑", "避雷", "可靠吗", "靠谱吗", "不推荐",
    "disadvantage", "weakness", "complaint", "negative", "review", "reputation", "risk", "problem"
]


def calculate_sub_indicator_score(raw_value: float, max_score: float) -> float:
    """
    计算子指标得分。
    raw_value: 原始比率（0-1 区间，可能超过 1）
    max_score: 该子指标的满分值
    """
    clamped = min(max(float(raw_value or 0.0), 0.0), 1.0)
    return round(clamped * max_score, 2)


def determine_grade(total_score: float) -> str:
    """根据总分判定等级"""
    for threshold, grade in GRADE_THRESHOLDS:
        if total_score >= threshold:
            return grade
    return "E"


def _to_rank(value: Any) -> Optional[int]:
    """将不同来源中的位次字段安全转换为正整数；无法识别时返回 None。"""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"na", "n/a", "none", "null", "not mentioned", "未提及", "未出现", "未上榜"}:
            return None
        # 允许 "#3"、"第3位"、"rank 3" 等轻量格式。
        digits = "".join(ch for ch in lowered if ch.isdigit())
        if not digits:
            return None
        value = digits
    try:
        rank = int(float(value))
    except (TypeError, ValueError):
        return None
    return rank if rank > 0 else None


def _is_reputation_entry(entry: Dict[str, Any]) -> bool:
    """判断样本是否为负面/舆情类问题；此类样本不参与位次质量评分。"""
    if entry.get("ranking_metric_eligible") is False:
        return True
    question_type = str(entry.get("question_type") or entry.get("intent_type") or "").strip().lower()
    if question_type in {"reputation_issue", "negative_reputation", "public_opinion", "sentiment_risk"}:
        return True
    question = str(entry.get("question") or entry.get("question_text") or entry.get("query") or "").lower()
    return any(keyword.lower() in question for keyword in REPUTATION_QUESTION_KEYWORDS)


def _extract_ranking_entries(raw_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """从多种兼容字段中提取问题级排名数据。"""
    candidates = [
        raw_data.get("ranking_data"),
        raw_data.get("ai_ranking_data"),
        raw_data.get("ranking_position_data"),
        raw_data.get("position_ranking_data"),
        raw_data.get("ai_visibility_rankings"),
        raw_data.get("per_question_rank_matrix"),
        raw_data.get("raw_indicators", {}).get("competitive_advantage", {}).get("ranking_data"),
        raw_data.get("raw_indicators", {}).get("competitive_advantage", {}).get("per_question_rank_matrix"),
    ]
    data = next((item for item in candidates if item not in (None, [], {})), [])

    if isinstance(data, dict):
        for key in ("items", "questions", "matrix", "per_question_rank_matrix", "ranking_data"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
        else:
            converted = []
            for question, value in data.items():
                if isinstance(value, dict):
                    converted.append({"question": question, **value})
                else:
                    converted.append({"question": question, "brand_rank": value})
            data = converted

    if not isinstance(data, list):
        return []
    return [entry for entry in data if isinstance(entry, dict)]


def _extract_existing_s5_ranking_diagnostics(raw_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """优先读取 S5 已生成的 ranking_position_diagnostics，避免 S5.5 绕过 S5 重复补采。"""
    candidates = [
        raw_data.get("ranking_position_diagnostics"),
        raw_data.get("s5_diagnosis", {}).get("ranking_position_diagnostics") if isinstance(raw_data.get("s5_diagnosis"), dict) else None,
        raw_data.get("brand_diagnosis", {}).get("ranking_position_diagnostics") if isinstance(raw_data.get("brand_diagnosis"), dict) else None,
        raw_data.get("S5_brand_diagnosis", {}).get("ranking_position_diagnostics") if isinstance(raw_data.get("S5_brand_diagnosis"), dict) else None,
        raw_data.get("raw_indicators", {}).get("ranking_position_diagnostics") if isinstance(raw_data.get("raw_indicators"), dict) else None,
    ]
    existing = next((item for item in candidates if isinstance(item, dict) and item), None)
    if not existing:
        return None

    distribution = existing.get("rank_distribution") if isinstance(existing.get("rank_distribution"), dict) else {}
    normalized_distribution = {key: int(distribution.get(key, 0) or 0) for key in RANK_DISTRIBUTION_KEYS}
    matrix = existing.get("per_question_rank_matrix") if isinstance(existing.get("per_question_rank_matrix"), list) else []
    metric_matrix = [row for row in matrix if isinstance(row, dict) and not _is_reputation_entry(row)]
    platform_breakdown = existing.get("platform_breakdown") if isinstance(existing.get("platform_breakdown"), dict) else {}
    total_observations = int(existing.get("ranking_metric_observations") or existing.get("total_observations") or len(metric_matrix) or 0)
    ranked_observations = existing.get("ranked_observations")
    if ranked_observations is None:
        ranked_observations = sum(1 for row in metric_matrix if _to_rank(row.get("brand_rank")) is not None)
    unmentioned_observations = existing.get("unmentioned_observations")
    if unmentioned_observations is None:
        unmentioned_observations = max(total_observations - int(ranked_observations or 0), 0)
    inherited_source = str(existing.get("data_source") or "S5 前置生成")

    return {
        "data_source": f"S5 ranking_position_diagnostics（由 S5 品牌诊断数据前置生成；原始来源：{inherited_source}；舆情类样本仅作风险参考，不进入位次质量评分）",
        "total_observations": total_observations,
        "ranked_observations": ranked_observations,
        "unmentioned_observations": unmentioned_observations,
        "total_raw_observations": existing.get("total_raw_observations", len(matrix)),
        "ranking_metric_observations": total_observations,
        "excluded_reputation_observations": existing.get("excluded_reputation_observations", max(len(matrix) - len(metric_matrix), 0)),
        "avg_rank": existing.get("avg_rank"),
        "first_place_rate": existing.get("first_place_rate", 0.0),
        "top3_rate": existing.get("top3_rate", 0.0),
        "top5_rate": existing.get("top5_rate", 0.0),
        "best_rank": existing.get("best_rank"),
        "worst_rank": existing.get("worst_rank"),
        "rank_distribution": normalized_distribution,
        "competitor_rank_gap": existing.get("competitor_rank_gap"),
        "platform_breakdown": platform_breakdown,
        "per_question_rank_matrix": matrix,
    }


def _extract_top_competitor_rank(entry: Dict[str, Any]) -> Optional[int]:
    direct = _to_rank(
        entry.get("top_competitor_rank")
        or entry.get("best_competitor_rank")
        or entry.get("competitor_best_rank")
        or entry.get("highest_competitor_rank")
    )
    if direct is not None:
        return direct

    ranks: List[int] = []
    comp_ranks = entry.get("competitor_ranks") or entry.get("competitors") or entry.get("competitor_positions")
    if isinstance(comp_ranks, dict):
        for value in comp_ranks.values():
            if isinstance(value, dict):
                rank = _to_rank(value.get("rank") or value.get("position") or value.get("mention_rank"))
            else:
                rank = _to_rank(value)
            if rank is not None:
                ranks.append(rank)
    elif isinstance(comp_ranks, list):
        for item in comp_ranks:
            if isinstance(item, dict):
                rank = _to_rank(item.get("rank") or item.get("position") or item.get("mention_rank"))
            else:
                rank = _to_rank(item)
            if rank is not None:
                ranks.append(rank)
    return min(ranks) if ranks else None


def _diagnose_rank_gap(brand_rank: Optional[int], competitor_rank: Optional[int], rank_gap: Optional[float]) -> str:
    if brand_rank is None:
        return "品牌未进入可识别排名或未被提及，应优先补齐可被 AI 引用的权威内容与场景证据。"
    if competitor_rank is None:
        return "品牌位次可识别，但缺少竞品位次对照，建议补充同题竞品排名数据。"
    if rank_gap is None:
        return "位次差暂不可计算。"
    if rank_gap > 0:
        return f"品牌落后最强竞品 {rank_gap:g} 位，需补强该问题下的信源覆盖与答案证据链。"
    if rank_gap < 0:
        return f"品牌领先最强竞品 {abs(rank_gap):g} 位，可沉淀为优势话题并在 S8 内容架构中放大。"
    return "品牌与最强竞品并列，建议通过差异化证据与权威信源争取首位占位。"


def calculate_ranking_position_diagnostics(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    计算 AI 搜索/回答中的排名位次诊断。

    正常链路必须优先消费 S5_{brand}_品牌诊断数据.json 顶层
    raw_data["ranking_position_diagnostics"]；只有历史输入缺失该对象时，才从
    raw_data["ranking_data"]、per_question_rank_matrix 等兼容字段回退计算。
    """
    existing_s5_diag = _extract_existing_s5_ranking_diagnostics(raw_data)
    if existing_s5_diag is not None:
        return existing_s5_diag

    entries = _extract_ranking_entries(raw_data)
    distribution = {key: 0 for key in RANK_DISTRIBUTION_KEYS}
    matrix: List[Dict[str, Any]] = []
    brand_ranks: List[int] = []
    top_competitor_ranks: List[int] = []
    valid_gaps: List[float] = []

    raw_total_questions = len(entries)
    excluded_reputation_observations = 0

    for idx, entry in enumerate(entries, 1):
        question = str(entry.get("question") or entry.get("question_text") or entry.get("query") or f"问题 {idx}")
        if _is_reputation_entry(entry):
            excluded_reputation_observations += 1
            raw_detected_position = _to_rank(entry.get("brand_rank") or entry.get("position") or entry.get("rank"))
            matrix.append({
                "question": question,
                "question_type": "reputation_issue",
                "ranking_metric_eligible": False,
                "ranking_exclusion_reason": "负面/舆情/口碑/缺点类问题不参与可见度、排名与位次质量评分。",
                "brand_rank": None,
                "raw_detected_position": raw_detected_position,
                "top_competitor_rank": None,
                "rank_gap": None,
                "rank_bucket": "excluded_reputation_issue",
                "diagnosis": "已从排名评分中排除；应转入 S5 舆情问题诊断与 D6 负面舆情。"
            })
            continue
        brand_rank = _to_rank(
            entry.get("brand_rank")
            or entry.get("brand_position")
            or entry.get("position")
            or entry.get("mention_rank")
            or entry.get("rank")
        )
        top_competitor_rank = _extract_top_competitor_rank(entry)

        if brand_rank is None or brand_rank >= 11:
            distribution["rank_11_plus"] += 1
        elif brand_rank == 1:
            distribution["rank_1"] += 1
        elif 2 <= brand_rank <= 3:
            distribution["rank_2_3"] += 1
        elif 4 <= brand_rank <= 5:
            distribution["rank_4_5"] += 1
        elif 6 <= brand_rank <= 10:
            distribution["rank_6_10"] += 1

        if brand_rank is not None:
            brand_ranks.append(brand_rank)
        if top_competitor_rank is not None:
            top_competitor_ranks.append(top_competitor_rank)

        rank_gap: Optional[float] = None
        if brand_rank is not None and top_competitor_rank is not None:
            rank_gap = float(brand_rank - top_competitor_rank)
            valid_gaps.append(rank_gap)

        matrix.append({
            "question": question,
            "question_type": "ranking_visibility",
            "ranking_metric_eligible": True,
            "ranking_exclusion_reason": "",
            "brand_rank": brand_rank,
            "top_competitor_rank": top_competitor_rank,
            "rank_gap": rank_gap,
            "diagnosis": _diagnose_rank_gap(brand_rank, top_competitor_rank, rank_gap)
        })

    total_questions = raw_total_questions - excluded_reputation_observations
    avg_rank = round(sum(brand_ranks) / len(brand_ranks), 2) if brand_ranks else None
    first_place_rate = round(sum(1 for rank in brand_ranks if rank == 1) / total_questions, 4) if total_questions else 0.0
    top3_rate = round(sum(1 for rank in brand_ranks if rank <= 3) / total_questions, 4) if total_questions else 0.0
    top5_rate = round(sum(1 for rank in brand_ranks if rank <= 5) / total_questions, 4) if total_questions else 0.0
    best_rank = min(brand_ranks) if brand_ranks else None
    worst_rank = max(brand_ranks) if brand_ranks else None

    competitor_rank_gap = None
    if brand_ranks and top_competitor_ranks:
        competitor_rank_gap = round((sum(brand_ranks) / len(brand_ranks)) - (sum(top_competitor_ranks) / len(top_competitor_ranks)), 2)
    elif valid_gaps:
        competitor_rank_gap = round(sum(valid_gaps) / len(valid_gaps), 2)

    return {
        "data_source": "S5.5 兼容回退：由 ranking_data/per_question_rank_matrix 临时计算；正式链路应由 S5 生成 ranking_position_diagnostics",
            "total_observations": total_questions,
            "total_raw_observations": raw_total_questions,
            "ranking_metric_observations": total_questions,
            "excluded_reputation_observations": excluded_reputation_observations,
            "ranked_observations": len(brand_ranks),
        "unmentioned_observations": max(total_questions - len(brand_ranks), 0),
        "avg_rank": avg_rank,
        "first_place_rate": first_place_rate,
        "top3_rate": top3_rate,
        "top5_rate": top5_rate,
        "best_rank": best_rank,
        "worst_rank": worst_rank,
        "rank_distribution": distribution,
        "competitor_rank_gap": competitor_rank_gap,
        "platform_breakdown": {},
        "per_question_rank_matrix": matrix
    }


def calculate_rank_quality_raw(ranking_diagnostics: Dict[str, Any]) -> float:
    """将位次诊断归一化为 0-1 的位次质量值，用作非加权诊断子指标。"""
    if int(ranking_diagnostics.get("ranking_metric_observations") or ranking_diagnostics.get("total_observations") or 0) <= 0:
        return 0.0

    avg_rank = ranking_diagnostics.get("avg_rank")
    top3_rate = float(ranking_diagnostics.get("top3_rate") or 0)
    top5_rate = float(ranking_diagnostics.get("top5_rate") or 0)
    competitor_gap = ranking_diagnostics.get("competitor_rank_gap")

    if avg_rank is None:
        avg_component = 0.0
    else:
        avg_component = max(0.0, min(1.0, (11.0 - float(avg_rank)) / 10.0))

    if competitor_gap is None:
        gap_component = 0.5
    else:
        # 负值代表领先，直接给满分；正值代表落后，5 位及以上降为 0。
        gap_component = 1.0 if competitor_gap <= 0 else max(0.0, min(1.0, (5.0 - float(competitor_gap)) / 5.0))

    raw = 0.40 * top3_rate + 0.30 * top5_rate + 0.20 * avg_component + 0.10 * gap_component
    return round(max(0.0, min(1.0, raw)), 4)


def calculate_bsas(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    计算 BSAS 评分。

    raw_data 结构：
    {
        "meta": { ... },
        "raw_indicators": { ... },
        "ranking_data": [
            {"question": "...", "brand_rank": 2, "top_competitor_rank": 1}
        ],
        "competitive_benchmark": { ... },
        "priority_actions": [ ... ],
        "twelve_week_targets": { ... }
    }
    """
    raw_indicators = raw_data.get("raw_indicators", {})
    ranking_diagnostics = calculate_ranking_position_diagnostics(raw_data)
    rank_quality_raw = calculate_rank_quality_raw(ranking_diagnostics)
    dimensions: Dict[str, Any] = {}
    total_score = 0.0

    for dim_key, dim_config in DIMENSION_WEIGHTS.items():
        dim_raw = raw_indicators.get(dim_key, {})
        dim_score = 0.0
        sub_indicators: Dict[str, Any] = {}

        for sub_key, sub_config in dim_config["sub_indicators"].items():
            sub_raw = dim_raw.get(sub_key, {})
            raw_value = sub_raw.get("raw_value", 0.0)
            max_score = sub_config["max_score"]

            score = calculate_sub_indicator_score(raw_value, max_score)
            dim_score += score

            sub_indicators[sub_key] = {
                "score": score,
                "max_score": max_score,
                "raw_value": raw_value,
                "calculation_basis": sub_raw.get("calculation_basis", "数据缺失")
            }

            # 保留额外字段（如 platforms_present, stages_covered 等）
            for extra_key in sub_raw:
                if extra_key not in ["raw_value", "calculation_basis"]:
                    sub_indicators[sub_key][extra_key] = sub_raw[extra_key]

        # 非加权诊断子指标：用于解释“可见但排不前”的位次质量问题，不改变原 100 分制。
        for sub_key, sub_config in dim_config.get("diagnostic_sub_indicators", {}).items():
            if sub_key == "rank_quality_score":
                max_score = sub_config["max_score"]
                sub_indicators[sub_key] = {
                    "score": calculate_sub_indicator_score(rank_quality_raw, max_score),
                    "max_score": max_score,
                    "raw_value": rank_quality_raw,
                    "top3_rate": ranking_diagnostics.get("top3_rate", 0.0),
                    "top5_rate": ranking_diagnostics.get("top5_rate", 0.0),
                    "avg_rank": ranking_diagnostics.get("avg_rank"),
                    "competitor_rank_gap": ranking_diagnostics.get("competitor_rank_gap"),
                    "calculation_basis": "非加权诊断项：0.40×Top3率 + 0.30×Top5率 + 0.20×平均位次质量 + 0.10×竞品位次差质量；仅使用 S5 标记为 ranking_metric_eligible=true 的样本，舆情类样本只作风险参考；不改变 BSAS 100 分总分。"
                }

        dimensions[dim_key] = {
            "score": round(dim_score, 2),
            "max_score": dim_config["max_score"],
            "sub_indicators": sub_indicators
        }

        total_score += dim_score

    total_score = round(total_score, 2)
    grade = determine_grade(total_score)

    # 构建雷达图数据
    radar_labels = ["语义可见度", "语义一致性", "语义多样性", "语义权威性", "竞品占优度"]
    current_pcts = [
        round(dimensions["semantic_visibility"]["score"] / 30 * 100, 1),
        round(dimensions["semantic_coherence"]["score"] / 20 * 100, 1),
        round(dimensions["semantic_richness"]["score"] / 20 * 100, 1),
        round(dimensions["semantic_authority"]["score"] / 15 * 100, 1),
        round(dimensions["competitive_advantage"]["score"] / 15 * 100, 1)
    ]

    # 构建输出
    scorecard = {
        "meta": raw_data.get("meta", {}),
        "bsas_total": total_score,
        "grade": grade,
        "dimensions": dimensions,
        "ranking_position_diagnostics": ranking_diagnostics,
        "competitive_benchmark": raw_data.get("competitive_benchmark", {}),
        "priority_actions": raw_data.get("priority_actions", []),
        "twelve_week_targets": raw_data.get("twelve_week_targets", {}),
        "radar_chart_data": {
            "labels": radar_labels,
            "current_scores_pct": current_pcts,
            "target_scores_pct": [],  # 由 twelve_week_targets 填充
            "industry_avg_pct": []    # 由基准数据填充
        }
    }

    # 填充雷达图目标数据
    targets = raw_data.get("twelve_week_targets", {}).get("dimension_targets", {})
    if targets:
        scorecard["radar_chart_data"]["target_scores_pct"] = [
            round(targets.get("semantic_visibility", 0) / 30 * 100, 1),
            round(targets.get("semantic_coherence", 0) / 20 * 100, 1),
            round(targets.get("semantic_richness", 0) / 20 * 100, 1),
            round(targets.get("semantic_authority", 0) / 15 * 100, 1),
            round(targets.get("competitive_advantage", 0) / 15 * 100, 1)
        ]

    return scorecard


def validate_scorecard(scorecard: Dict[str, Any]) -> Tuple[bool, list]:
    """校验评分卡完整性"""
    issues: List[str] = []

    # 1. 总分范围
    total = scorecard.get("bsas_total", -1)
    if total < 0 or total > 100:
        issues.append(f"总分超出范围: {total}")

    # 2. 五维完整性
    dims = scorecard.get("dimensions", {})
    required_dims = ["semantic_visibility", "semantic_coherence", "semantic_richness",
                     "semantic_authority", "competitive_advantage"]
    for dim in required_dims:
        if dim not in dims:
            issues.append(f"缺失维度: {dim}")
        else:
            dim_score = dims[dim].get("score", -1)
            dim_max = dims[dim].get("max_score", 0)
            if dim_score < 0 or dim_score > dim_max:
                issues.append(f"维度 {dim} 得分超出范围: {dim_score}/{dim_max}")

    # 3. 总分校验（五维之和应等于总分）
    dim_sum = sum(dims.get(d, {}).get("score", 0) for d in required_dims)
    if abs(dim_sum - total) > 0.1:
        issues.append(f"五维之和 ({dim_sum}) 与总分 ({total}) 不一致")

    # 4. 等级判定正确性
    grade = scorecard.get("grade", "")
    expected_grade = determine_grade(total)
    if grade != expected_grade:
        issues.append(f"等级判定错误: 实际 {grade}, 应为 {expected_grade}")

    # 5. 竞品对比完整性
    benchmark = scorecard.get("competitive_benchmark", {})
    competitors = benchmark.get("competitors", [])
    if len(competitors) < 3:
        issues.append(f"竞品对比不足 3 个: 当前 {len(competitors)} 个")

    # 6. 优先行动建议
    actions = scorecard.get("priority_actions", [])
    if len(actions) < 3:
        issues.append(f"优先行动建议不足 3 条: 当前 {len(actions)} 条")

    # 7. 排名位次诊断完整性
    rank_diag = scorecard.get("ranking_position_diagnostics")
    if not isinstance(rank_diag, dict):
        issues.append("缺失 ranking_position_diagnostics 排名位次诊断对象")
    else:
        required_rank_fields = [
            "data_source", "total_observations", "avg_rank", "first_place_rate", "top3_rate", "top5_rate",
            "best_rank", "worst_rank", "rank_distribution", "competitor_rank_gap", "platform_breakdown",
            "per_question_rank_matrix"
        ]
        for field in required_rank_fields:
            if field not in rank_diag:
                issues.append(f"排名位次诊断缺失字段: {field}")
        dist = rank_diag.get("rank_distribution", {})
        for key in RANK_DISTRIBUTION_KEYS:
            if key not in dist:
                issues.append(f"排名分布缺失字段: {key}")
        matrix = rank_diag.get("per_question_rank_matrix", [])
        if not isinstance(matrix, list) or len(matrix) == 0:
            issues.append("问题级排名矩阵为空：请先在 S5 品牌诊断数据顶层 ranking_position_diagnostics.per_question_rank_matrix 中提供客户确认监控问题对应的品牌/竞品位次")
        for rate_key in ("first_place_rate", "top3_rate", "top5_rate"):
            rate = rank_diag.get(rate_key, 0)
            if rate < 0 or rate > 1:
                issues.append(f"{rate_key} 超出 0-1 范围: {rate}")
        data_source = str(rank_diag.get("data_source") or "")
        if data_source and "回退" in data_source:
            issues.append("排名位次诊断使用了 S5.5 兼容回退口径：正式交付需先由 S5 生成 ranking_position_diagnostics")

    # 8. 竞品占优度下的非加权位次质量诊断项
    comp_subs = dims.get("competitive_advantage", {}).get("sub_indicators", {})
    if "rank_quality_score" not in comp_subs:
        issues.append("competitive_advantage 缺失 rank_quality_score 位次质量诊断子指标")

    return len(issues) == 0, issues


def main() -> None:
    parser = argparse.ArgumentParser(description="BSAS 评分计算器")
    parser.add_argument("--input", required=True, help="原始数据 JSON 文件路径")
    parser.add_argument("--output", required=True, help="评分卡输出 JSON 文件路径")
    parser.add_argument("--ai-feedback", action="store_true", help="输出 AI 友好的校验反馈")
    args = parser.parse_args()

    # 读取原始数据
    if not os.path.exists(args.input):
        print(f"❌ 输入文件不存在: {args.input}")
        sys.exit(1)

    with open(args.input, 'r', encoding='utf-8') as f:
        raw_data = json.load(f)

    # 计算评分
    scorecard = calculate_bsas(raw_data)

    # 校验
    passed, issues = validate_scorecard(scorecard)

    if args.ai_feedback:
        print(json.dumps({
            "passed": passed,
            "issues": issues,
            "bsas_total": scorecard["bsas_total"],
            "grade": scorecard["grade"],
            "ranking_position_diagnostics": scorecard.get("ranking_position_diagnostics", {})
        }, ensure_ascii=False, indent=2))
    else:
        print(f"📊 BSAS 评分计算完成")
        print(f"   总分: {scorecard['bsas_total']}/100")
        print(f"   等级: {scorecard['grade']}")
        rank_diag = scorecard.get("ranking_position_diagnostics", {})
        print(f"   平均位次: {rank_diag.get('avg_rank')}")
        print(f"   Top3率: {rank_diag.get('top3_rate')}")
        print(f"   竞品位次差: {rank_diag.get('competitor_rank_gap')}")
        if not passed:
            print(f"\n⚠️ 校验问题:")
            for issue in issues:
                print(f"   - {issue}")

    # 写入输出
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(scorecard, f, ensure_ascii=False, indent=2)

    print(f"\n✅ 评分卡已保存: {args.output}")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
