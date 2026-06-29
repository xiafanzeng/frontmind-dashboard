#!/usr/bin/env python3
"""
品类趋势信号聚合器
用途：聚合来自多个信号源的趋势数据，生成趋势打分卡 JSON。

用法：
  python3 signal_aggregator.py --brand "品牌名" --category "品类" --output output.json

参数：
  --brand      品牌简称
  --category   主品类名称
  --output     输出 JSON 文件路径
  --signals    信号数据文件路径（可选，JSON 格式）
"""

import os
import sys
import json
import argparse
from datetime import datetime, timedelta


# ============================================================
# 趋势类型定义
# ============================================================

TREND_CATEGORIES = {
    "macro": "宏观环境趋势",
    "technology": "技术趋势",
    "consumer": "消费趋势",
    "policy": "政策趋势",
    "cultural_weak_signal": "文化弱信号"
}

LIFECYCLE_STAGES = {
    "emerging": "萌芽期",
    "growth": "增长期",
    "mature": "成熟期",
    "declining": "衰退期"
}

SCORE_WEIGHTS = {
    "maturity": 0.20,
    "growth_rate": 0.25,
    "brand_fit": 0.25,
    "time_window": 0.20,
    "competitive_gap": 0.10
}


# ============================================================
# 核心函数
# ============================================================

def calculate_total_score(scores: dict) -> float:
    """
    计算趋势加权总分

    Args:
        scores: 包含 5 个维度评分的字典，每个值 0-10

    Returns:
        加权总分（0-10，保留 1 位小数）
    """
    total = 0.0
    for dim, weight in SCORE_WEIGHTS.items():
        value = scores.get(dim, 0)
        if not isinstance(value, (int, float)):
            value = 0
        value = max(0, min(10, value))
        total += value * weight
    return round(total, 1)


def validate_signal(signal: dict) -> list:
    """
    校验单条信号的完整性

    Args:
        signal: 信号字典

    Returns:
        错误信息列表（空列表表示通过）
    """
    errors = []
    required_fields = ["source", "url", "timestamp", "description"]
    for field in required_fields:
        if field not in signal or not signal[field]:
            errors.append(f"信号缺少必填字段：{field}")

    # 校验时间戳格式
    timestamp = signal.get("timestamp", "")
    if timestamp:
        try:
            dt = datetime.fromisoformat(timestamp)
            # 检查是否超过 12 个月
            if dt < datetime.now() - timedelta(days=365):
                errors.append(f"信号时间戳超过 12 个月：{timestamp}")
        except ValueError:
            errors.append(f"信号时间戳格式错误：{timestamp}")

    return errors


def validate_trend(trend: dict) -> list:
    """
    校验单条趋势的完整性

    Args:
        trend: 趋势字典

    Returns:
        错误信息列表
    """
    errors = []

    # 必填字段
    required = ["id", "name", "category", "lifecycle_stage", "scores",
                "signals", "opportunity", "time_windows"]
    for field in required:
        if field not in trend:
            errors.append(f"趋势 {trend.get('id', '?')} 缺少字段：{field}")

    # 类型校验
    category = trend.get("category", "")
    if category not in TREND_CATEGORIES:
        errors.append(f"趋势类型无效：{category}")

    stage = trend.get("lifecycle_stage", "")
    if stage not in LIFECYCLE_STAGES:
        errors.append(f"生命周期阶段无效：{stage}")

    # 评分校验
    scores = trend.get("scores", {})
    for dim in SCORE_WEIGHTS:
        val = scores.get(dim)
        if val is None:
            errors.append(f"趋势 {trend.get('id', '?')} 缺少评分维度：{dim}")
        elif not isinstance(val, (int, float)) or val < 0 or val > 10:
            errors.append(f"趋势 {trend.get('id', '?')} 评分 {dim} 超出范围：{val}")

    # 信号数量校验
    signals = trend.get("signals", [])
    if len(signals) < 2:
        errors.append(f"趋势 {trend.get('id', '?')} 信号源不足：{len(signals)}/2")
    for i, sig in enumerate(signals):
        sig_errors = validate_signal(sig)
        for e in sig_errors:
            errors.append(f"趋势 {trend.get('id', '?')} 信号[{i}] {e}")

    # 时间窗口校验
    tw = trend.get("time_windows", {})
    for period in ["3_month", "6_month", "12_month"]:
        if period not in tw or not tw[period]:
            errors.append(f"趋势 {trend.get('id', '?')} 缺少时间窗口：{period}")

    return errors


def validate_scorecard(data: dict) -> dict:
    """
    校验完整趋势打分卡

    Args:
        data: 趋势打分卡 JSON 数据

    Returns:
        校验结果字典
    """
    result = {
        "passed": True,
        "errors": [],
        "warnings": [],
        "stats": {}
    }

    # 趋势数量
    trends = data.get("trends", [])
    result["stats"]["trend_count"] = len(trends)
    if len(trends) < 8:
        result["errors"].append(f"趋势条目不足：{len(trends)}/8")
        result["passed"] = False

    # 文化弱信号
    weak_signals = [t for t in trends if t.get("category") == "cultural_weak_signal"]
    result["stats"]["weak_signal_count"] = len(weak_signals)
    if len(weak_signals) < 1:
        result["errors"].append("缺少文化弱信号趋势（至少 1 条）")
        result["passed"] = False

    # 逐条校验
    for trend in trends:
        trend_errors = validate_trend(trend)
        if trend_errors:
            result["errors"].extend(trend_errors)
            result["passed"] = False

    # 类型覆盖度
    categories = set(t.get("category") for t in trends)
    result["stats"]["category_coverage"] = len(categories)
    if len(categories) < 3:
        result["warnings"].append(f"趋势类型覆盖不足：{len(categories)}/5")

    return result


def build_empty_scorecard(brand: str, category: str) -> dict:
    """
    生成空白趋势打分卡模板

    Args:
        brand: 品牌简称
        category: 主品类

    Returns:
        空白打分卡字典
    """
    return {
        "meta": {
            "brand": brand,
            "category": category,
            "sub_category": "",
            "created_at": datetime.now().strftime("%Y-%m-%d"),
            "trend_count": 0,
            "weak_signal_count": 0
        },
        "trends": [],
        "opportunity_map": {
            "high_priority": [],
            "medium_priority": [],
            "low_priority": []
        }
    }


# ============================================================
# CLI 入口
# ============================================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="品类趋势信号聚合器")
    parser.add_argument("--brand", required=True, help="品牌简称")
    parser.add_argument("--category", required=True, help="主品类名称")
    parser.add_argument("--output", required=True, help="输出 JSON 文件路径")
    parser.add_argument("--signals", default=None, help="信号数据文件路径（可选）")
    parser.add_argument("--s1-facts", default=None, dest="s1_facts",
                        help="S1 品牌事实图谱 JSON 路径（v2.8），自动提取 signal_snapshot 作为原始信号底座")
    parser.add_argument("--validate", default=None, help="校验已有的趋势打分卡 JSON")

    args = parser.parse_args()

    if args.validate:
        # 校验模式
        with open(args.validate, "r", encoding="utf-8") as f:
            data = json.load(f)
        result = validate_scorecard(data)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(0 if result["passed"] else 1)

    # 生成模式
    scorecard = build_empty_scorecard(args.brand, args.category)

    # v2.8: 优先从 S1 信号快照导入原始信号作为底座
    s1_raw_signals = []
    if args.s1_facts and os.path.exists(args.s1_facts):
        with open(args.s1_facts, "r", encoding="utf-8") as f:
            facts_data = json.load(f)
        snapshot = (facts_data.get("facts", {})
                    .get("public_intelligence", {})
                    .get("signal_snapshot", {}))
        # 将各维度原始信号展平为统一列表
        for key in ["demand_signals", "supply_signals", "culture_signals"]:
            signals = snapshot.get(key, [])
            for sig in signals:
                if validate_signal(sig) == []:
                    s1_raw_signals.append(sig)
        # PEST 信号转换
        pest = snapshot.get("pest_signals", {})
        for dim in ["political", "economic", "social", "technological"]:
            for item in pest.get(dim, []):
                converted = {
                    "source": f"PEST-{dim}",
                    "url": item.get("source_url", ""),
                    "timestamp": item.get("timestamp", datetime.now().strftime("%Y-%m-%d")),
                    "description": item.get("summary", item.get("title", ""))
                }
                if validate_signal(converted) == []:
                    s1_raw_signals.append(converted)
        if s1_raw_signals:
            print(f"[✓] 从 S1 信号快照导入 {len(s1_raw_signals)} 条原始信号")
            scorecard["meta"]["s1_signal_count"] = len(s1_raw_signals)

    if args.signals and os.path.exists(args.signals):
        with open(args.signals, "r", encoding="utf-8") as f:
            signal_data = json.load(f)
        # 合并信号数据到打分卡
        if "trends" in signal_data:
            scorecard["trends"] = signal_data["trends"]
            scorecard["meta"]["trend_count"] = len(signal_data["trends"])

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(scorecard, f, ensure_ascii=False, indent=2)

    print(f"[OK] 趋势打分卡已生成：{args.output}")
