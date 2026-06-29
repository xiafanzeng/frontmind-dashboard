"""S5 AI 排名位次与舆情问题诊断计算器。

将 AI 监测 JSON 中的 responses[].answers.*.position 转译为
S5_{brand}_品牌诊断数据.json 的 ranking_position_diagnostics 顶层对象。

关键原则：
1. 只有“泛品类推荐、供应商推荐、品牌对比、方案选择”等可排名问题，才参与 D1 可见度、平均位次、Top3/Top5 与竞品位次差计算。
2. “某品牌有什么缺点/问题/投诉/负面/风险/靠谱吗”等品牌被点名的舆情类问题，不参与可见度或排名指标；这类问题中品牌出现通常是题干指定导致的自然出现，可见度接近 100%，不能解释为品牌 GEO 可见度优势。
3. 舆情类问题必须保留在 per_question_rank_matrix 中并标注为 excluded，同时进入 reputation_issue_diagnostics，供 D6 负面舆情、S9 问题总结和执行层修复建议使用。

输入可为：
1. AI 监测 JSON 顶层对象，含 responses/answers；
2. 已展开的 question/platform 记录列表；
3. 历史兼容的 ranking_data/per_question_rank_matrix。
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

RANK_DISTRIBUTION_KEYS = ["rank_1", "rank_2_3", "rank_4_5", "rank_6_10", "rank_11_plus"]

REPUTATION_ISSUE_KEYWORDS = [
    "缺点", "问题", "不足", "弊端", "短板", "负面", "差评", "投诉", "争议", "纠纷", "舆情", "黑料",
    "风险", "隐患", "质量问题", "售后问题", "骗局", "是否靠谱", "靠谱吗", "靠不靠谱", "怎么样", "评价", "口碑",
    "complaint", "negative", "problem", "issue", "drawback", "weakness", "risk", "reputation", "review", "reliable",
]

VISIBILITY_OR_RANKING_INTENT_KEYWORDS = [
    "推荐", "哪家", "有哪些", "排名", "榜单", "供应商", "品牌对比", "比较", "选择", "top", "best", "vendor", "supplier",
]

NEGATIVE_SEVERITY_HIGH = ["违法", "事故", "欺诈", "骗局", "造假", "严重", "大规模", "安全", "质量事故", "召回", "处罚"]
NEGATIVE_SEVERITY_MEDIUM = ["投诉", "差评", "纠纷", "争议", "质量问题", "售后", "不稳定", "价格高", "交付", "风险"]


def _to_rank(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    try:
        rank = int(float(value))
    except (TypeError, ValueError):
        return None
    return rank if rank > 0 else None


def _bucket(rank: Optional[int]) -> str:
    if rank is None or rank >= 11:
        return "rank_11_plus"
    if rank == 1:
        return "rank_1"
    if 2 <= rank <= 3:
        return "rank_2_3"
    if 4 <= rank <= 5:
        return "rank_4_5"
    if 6 <= rank <= 10:
        return "rank_6_10"
    return "rank_11_plus"


def _contains_any(text: str, keywords: List[str]) -> bool:
    lowered = text.lower()
    return any(keyword.lower() in lowered for keyword in keywords)


def _classify_question(record: Dict[str, Any], answer: Dict[str, Any]) -> Tuple[str, bool, str]:
    """返回 (question_type, ranking_metric_eligible, exclusion_reason)。"""
    raw_type = str(
        record.get("declared_question_type")
        or answer.get("question_type")
        or answer.get("intent_type")
        or answer.get("query_type")
        or ""
    ).strip().lower()
    question = str(record.get("question") or "")

    if raw_type in {"reputation_issue", "negative_reputation", "public_opinion", "sentiment_risk", "舆情问题", "负面问题"}:
        return "reputation_issue", False, "该题被显式标记为负面/舆情类问题，品牌出现由题干指定，不能纳入可见度或排名指标。"

    has_reputation_signal = _contains_any(question, REPUTATION_ISSUE_KEYWORDS)
    has_ranking_signal = _contains_any(question, VISIBILITY_OR_RANKING_INTENT_KEYWORDS)

    # “有哪些缺点/问题”如果同时没有供应商推荐、榜单、对比等排名意图，按舆情题处理。
    if has_reputation_signal and not has_ranking_signal:
        return "reputation_issue", False, "题干询问品牌缺点、问题、口碑、投诉或风险，属于舆情/认知风险诊断，不参与 D1 可见度、平均位次或 Top3/Top5 计算。"

    if has_ranking_signal:
        return "ranking_visibility", True, ""
    return "general_visibility", True, ""


def _extract_competitor_ranks(answer: Dict[str, Any]) -> Dict[str, int]:
    raw = answer.get("competitor_ranks") or answer.get("competitors") or answer.get("competitor_positions") or {}
    result: Dict[str, int] = {}
    if isinstance(raw, dict):
        for name, value in raw.items():
            rank = _to_rank(value.get("rank") or value.get("position") or value.get("mention_rank")) if isinstance(value, dict) else _to_rank(value)
            if rank is not None:
                result[str(name)] = rank
    elif isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                name = item.get("name") or item.get("brand") or item.get("competitor")
                rank = _to_rank(item.get("rank") or item.get("position") or item.get("mention_rank"))
                if name and rank is not None:
                    result[str(name)] = rank
    return result


def _top_competitor(competitor_ranks: Dict[str, int]) -> Tuple[Optional[str], Optional[int]]:
    if not competitor_ranks:
        return None, None
    name, rank = min(competitor_ranks.items(), key=lambda item: item[1])
    return name, rank


def _diagnose(rank: Optional[int], top_competitor_rank: Optional[int], rank_gap: Optional[float]) -> str:
    if rank is None:
        return "品牌在该题该平台未被提及或位次不可识别，应优先补齐对应场景的权威内容与信源证据。"
    if top_competitor_rank is None:
        if rank <= 3:
            return "品牌已进入 Top3，但缺少竞品位次对照；建议补充竞品提及位次以确认相对优势。"
        return "品牌已被提及但位次不够靠前，且缺少竞品位次对照；建议补充竞品解析并提升答案证据链。"
    if rank_gap is None:
        return "位次差暂不可计算。"
    if rank_gap > 0:
        return f"品牌落后最强竞品 {rank_gap:g} 位，应优先补强该问题下的信源覆盖、比较内容与场景证据。"
    if rank_gap < 0:
        return f"品牌领先最强竞品 {abs(rank_gap):g} 位，可沉淀为优势话题并在 S8 问答内容中放大。"
    return "品牌与最强竞品并列，应通过差异化证据与权威信源争取首位占位。"


def _severity_from_text(text: str, sentiment: str) -> str:
    if _contains_any(text, NEGATIVE_SEVERITY_HIGH):
        return "high"
    if sentiment == "negative" or _contains_any(text, NEGATIVE_SEVERITY_MEDIUM):
        return "medium"
    return "low"


def _summarize_issue(text: str) -> str:
    compact = re.sub(r"\s+", " ", str(text or "")).strip()
    if not compact:
        return "该平台回答未提供足够文本，需在报告中标注为舆情样本但不可做细节归因。"
    return compact[:180] + ("..." if len(compact) > 180 else "")


def _issue_action(severity: str) -> str:
    if severity == "high":
        return "优先建立事实澄清页、权威第三方证明与公开回应口径，并在 S8 中生成风险问答。"
    if severity == "medium":
        return "补充官网 FAQ、案例证据、售后/质量说明与第三方评价材料，降低 AI 对单一负面信源的依赖。"
    return "保留为口碑监测项，补充正反观点平衡内容与可验证事实，避免轻微负面被放大。"


def _iter_monitoring_records(monitoring: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    responses = monitoring.get("responses") or []
    for idx, response in enumerate(responses, 1):
        question_id = response.get("question_id") or response.get("id") or f"Q{idx:02d}"
        question = response.get("question") or response.get("query") or response.get("question_text") or f"监控问题 {idx}"
        declared_question_type = response.get("question_type") or response.get("intent_type") or response.get("query_type")
        answers = response.get("answers") or {}
        if isinstance(answers, dict):
            for platform, answer in answers.items():
                if isinstance(answer, dict):
                    yield {
                        "question_id": question_id,
                        "question": question,
                        "declared_question_type": declared_question_type,
                        "platform": str(platform),
                        "answer": answer,
                    }


def _iter_flat_records(data: Any) -> Iterable[Dict[str, Any]]:
    if isinstance(data, dict):
        if isinstance(data.get("responses"), list):
            yield from _iter_monitoring_records(data)
            return
        for key in ("ranking_data", "ai_ranking_data", "ranking_position_data", "per_question_rank_matrix"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if isinstance(data, list):
        for idx, item in enumerate(data, 1):
            if isinstance(item, dict):
                answer = dict(item)
                yield {
                    "question_id": item.get("question_id") or item.get("id") or f"Q{idx:02d}",
                    "question": item.get("question") or item.get("query") or item.get("question_text") or f"监控问题 {idx}",
                    "declared_question_type": item.get("question_type") or item.get("intent_type") or item.get("query_type"),
                    "platform": item.get("platform") or "unknown",
                    "answer": answer,
                }


def calculate_ranking_position_diagnostics(data: Any) -> Dict[str, Any]:
    matrix: List[Dict[str, Any]] = []
    issue_matrix: List[Dict[str, Any]] = []
    distribution = {key: 0 for key in RANK_DISTRIBUTION_KEYS}
    brand_ranks: List[int] = []
    top_competitor_ranks: List[int] = []
    platform_stats: Dict[str, Dict[str, Any]] = {}
    issue_platform_stats: Dict[str, Dict[str, Any]] = {}
    raw_total = 0
    eligible_total = 0
    excluded_total = 0

    for record in _iter_flat_records(data):
        raw_total += 1
        answer = record["answer"]
        platform = str(record.get("platform") or "unknown")
        question_type, ranking_metric_eligible, exclusion_reason = _classify_question(record, answer)
        mentioned = bool(answer.get("mentioned", answer.get("brand_mentioned", False)))
        rank = _to_rank(answer.get("position") or answer.get("brand_rank") or answer.get("brand_position") or answer.get("mention_rank") or answer.get("rank"))
        if rank is not None:
            mentioned = True
        if not mentioned:
            rank = None

        competitor_ranks = _extract_competitor_ranks(answer)
        top_competitor_name, top_competitor_rank = _top_competitor(competitor_ranks)
        rank_gap: Optional[float] = None
        if rank is not None and top_competitor_rank is not None:
            rank_gap = float(rank - top_competitor_rank)

        metric_rank = rank if ranking_metric_eligible else None
        bucket = _bucket(metric_rank) if ranking_metric_eligible else "excluded_reputation_issue"
        diagnosis = _diagnose(metric_rank, top_competitor_rank, rank_gap) if ranking_metric_eligible else exclusion_reason

        if ranking_metric_eligible:
            eligible_total += 1
            distribution[bucket] += 1
            if rank is not None:
                brand_ranks.append(rank)
            if top_competitor_rank is not None:
                top_competitor_ranks.append(top_competitor_rank)

            stats = platform_stats.setdefault(platform, {"response_count": 0, "mentioned_count": 0, "ranks": []})
            stats["response_count"] += 1
            if rank is not None:
                stats["mentioned_count"] += 1
                stats["ranks"].append(rank)
        else:
            excluded_total += 1
            sentiment = str(answer.get("sentiment") or answer.get("sentiment_label") or "unknown").lower()
            text = str(answer.get("text") or answer.get("answer") or answer.get("content") or "")
            severity = _severity_from_text(text, sentiment)
            issue_stats = issue_platform_stats.setdefault(platform, {"response_count": 0, "positive": 0, "neutral": 0, "negative": 0, "unknown": 0, "severity": {"high": 0, "medium": 0, "low": 0}})
            issue_stats["response_count"] += 1
            issue_stats[sentiment if sentiment in {"positive", "neutral", "negative"} else "unknown"] += 1
            issue_stats["severity"][severity] += 1
            issue_matrix.append({
                "question_id": record.get("question_id"),
                "question": record.get("question"),
                "platform": platform,
                "brand_mentioned": mentioned,
                "sentiment": sentiment,
                "severity": severity,
                "issue_summary": _summarize_issue(text),
                "recommended_response": _issue_action(severity),
            })

        matrix.append({
            "question_id": record.get("question_id"),
            "question": record.get("question"),
            "platform": platform,
            "question_type": question_type,
            "ranking_metric_eligible": ranking_metric_eligible,
            "ranking_exclusion_reason": exclusion_reason,
            "brand_mentioned": mentioned,
            "brand_rank": metric_rank,
            "raw_detected_position": rank,
            "competitor_ranks": competitor_ranks,
            "top_competitor": top_competitor_name,
            "top_competitor_rank": top_competitor_rank,
            "rank_gap": rank_gap,
            "rank_bucket": bucket,
            "diagnosis": diagnosis,
        })

    ranked = len(brand_ranks)
    avg_rank = round(sum(brand_ranks) / ranked, 2) if ranked else None
    top3_rate = round(sum(1 for r in brand_ranks if r <= 3) / eligible_total, 4) if eligible_total else 0.0
    top5_rate = round(sum(1 for r in brand_ranks if r <= 5) / eligible_total, 4) if eligible_total else 0.0
    first_place_rate = round(sum(1 for r in brand_ranks if r == 1) / eligible_total, 4) if eligible_total else 0.0

    competitor_rank_gap = None
    if brand_ranks and top_competitor_ranks:
        competitor_rank_gap = round((sum(brand_ranks) / len(brand_ranks)) - (sum(top_competitor_ranks) / len(top_competitor_ranks)), 2)

    platform_breakdown: Dict[str, Any] = {}
    for platform, stats in platform_stats.items():
        ranks = stats["ranks"]
        count = stats["response_count"] or 1
        platform_breakdown[platform] = {
            "response_count": stats["response_count"],
            "mentioned_count": stats["mentioned_count"],
            "citation_rate": round(stats["mentioned_count"] / count, 4),
            "avg_rank": round(sum(ranks) / len(ranks), 2) if ranks else None,
            "top3_rate": round(sum(1 for r in ranks if r <= 3) / count, 4),
            "top5_rate": round(sum(1 for r in ranks if r <= 5) / count, 4),
        }

    issue_platform_breakdown: Dict[str, Any] = {}
    for platform, stats in issue_platform_stats.items():
        issue_platform_breakdown[platform] = {
            "response_count": stats["response_count"],
            "positive_count": stats["positive"],
            "neutral_count": stats["neutral"],
            "negative_count": stats["negative"],
            "unknown_count": stats["unknown"],
            "severity_distribution": stats["severity"],
        }

    return {
        "data_source": "AI 监测 JSON responses[].answers.*.position 与竞品位次解析；负面/舆情类问题已排除出排名指标，仅进入 reputation_issue_diagnostics",
        "total_observations": eligible_total,
        "total_raw_observations": raw_total,
        "ranking_metric_observations": eligible_total,
        "excluded_reputation_observations": excluded_total,
        "ranked_observations": ranked,
        "unmentioned_observations": eligible_total - ranked,
        "avg_rank": avg_rank,
        "first_place_rate": first_place_rate,
        "top3_rate": top3_rate,
        "top5_rate": top5_rate,
        "best_rank": min(brand_ranks) if brand_ranks else None,
        "worst_rank": max(brand_ranks) if brand_ranks else None,
        "rank_distribution": distribution,
        "competitor_rank_gap": competitor_rank_gap,
        "platform_breakdown": platform_breakdown,
        "per_question_rank_matrix": matrix,
        "reputation_issue_diagnostics": {
            "data_source": "从被识别为负面/舆情/口碑/缺点/问题类的题目中生成；不参与 D1 可见度或排名评分",
            "total_observations": excluded_total,
            "question_count": len({row.get("question_id") for row in issue_matrix}),
            "platform_breakdown": issue_platform_breakdown,
            "per_question_issue_matrix": issue_matrix,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="计算 S5 排名位次诊断对象，并将负面/舆情题从排名指标中分流")
    parser.add_argument("input", type=Path, help="AI 监测 JSON 或兼容排名数据 JSON")
    parser.add_argument("output", type=Path, nargs="?", help="输出 JSON 路径；省略则打印到 stdout")
    args = parser.parse_args()

    data = json.loads(args.input.read_text(encoding="utf-8"))
    result = calculate_ranking_position_diagnostics(data)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)


if __name__ == "__main__":
    main()
