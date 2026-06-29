#!/usr/bin/env python3
"""
营销图谱 JSON 校验器（V3.5 — 营销图谱分析版）
用途：校验 S2_{brand}_营销图谱.json 是否符合“用户—场景—意图三元组 + 场景树 + 问法模式”标准。

关键边界：S2 只做营销图谱分析，不生成、不推荐、不打印 AI 监控问题。
S5 的监控问题只能来自客户在暂停 2 中自行确认的问题和客户上传的 AI 监测数据。

用法：
  python3 atlas_validator.py <json_file> [--strict] [--ai-feedback]

V3.5 校验规则：
  1. 三元组数量 ≥ 30
  2. 核心话题数 3-5 个（不含风险/负面话题）
  3. 子场景总数 ≥ 12 个
  4. 问法模式/搜索模式总数 ≥ 30 个
  5. 品类拦截型问法（不含品牌名）≥ 60%
  6. 不得包含 probes / is_probe / monitoring_questions / recommended_questions 等监控题库字段
  7. 风险顾虑维度如存在，应有清晰维度标注
  8. 每个问法模式映射到 ≥ 1 个三元组
  9. 用户画像覆盖 ≥ 3 个不同行业/角色
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any


REQUIRED_RISK_DIMS = {"quality", "price", "service", "certification", "competitor"}
FORBIDDEN_KEYS = {
    "probes",
    "is_probe",
    "representative_questions",
    "recommended_questions",
    "monitoring_questions",
    "positive_probes",
    "negative_probes",
}
FORBIDDEN_TEXT_MARKERS = ["推荐监控问题", "代表题清单", "正向代表题", "负面代表题"]


class AtlasValidationResult:
    """校验结果收集器。"""

    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.stats: dict[str, Any] = {}
        self.ai_fixes: list[dict[str, str]] = []

    def error(self, msg: str, fix: str = "") -> None:
        self.errors.append(f"[错误] {msg}")
        if fix:
            self.ai_fixes.append({"severity": "error", "message": msg, "fix_action": fix})

    def warn(self, msg: str, fix: str = "") -> None:
        self.warnings.append(f"[警告] {msg}")
        if fix:
            self.ai_fixes.append({"severity": "warning", "message": msg, "fix_action": fix})

    def stat(self, key: str, value: Any) -> None:
        self.stats[key] = value

    @property
    def passed(self) -> bool:
        return len(self.errors) == 0

    def summary(self) -> str:
        lines = ["=" * 60, "营销图谱校验报告（V3.5 — 分析版）", "=" * 60, ""]
        if self.stats:
            lines.append("统计信息：")
            for k, v in self.stats.items():
                lines.append(f"  {k}: {v}")
            lines.append("")
        if self.errors:
            lines.append(f"错误（{len(self.errors)} 项）：")
            for e in self.errors:
                lines.append(f"  {e}")
            lines.append("")
        if self.warnings:
            lines.append(f"警告（{len(self.warnings)} 项）：")
            for w in self.warnings:
                lines.append(f"  {w}")
            lines.append("")
        lines.append("校验通过" if self.passed else "校验失败，请修复上述错误")
        return "\n".join(lines)

    def ai_feedback_json(self) -> str:
        return json.dumps(
            {
                "validator": "S2_营销图谱校验器_V3_5",
                "passed": self.passed,
                "error_count": len(self.errors),
                "warning_count": len(self.warnings),
                "stats": self.stats,
                "fix_actions": self.ai_fixes,
                "instruction_to_s0": "请将 fix_actions 传递给 S2 修复；S2 不得生成或下发监控问题。",
            },
            ensure_ascii=False,
            indent=2,
        )


def walk(value: Any) -> list[Any]:
    found = [value]
    if isinstance(value, dict):
        for child in value.values():
            found.extend(walk(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(walk(child))
    return found


def collect_question_patterns(topics: list[Any]) -> list[dict[str, Any]]:
    """从场景树中收集问法模式。

    优先读取 v3.5 字段 question_patterns；兼容旧字段 variants，但旧字段也不得包含 is_probe。
    """
    patterns: list[dict[str, Any]] = []
    for topic in topics:
        if not isinstance(topic, dict):
            continue
        for sc in topic.get("sub_scenes", []):
            if not isinstance(sc, dict):
                continue
            candidates = []
            if isinstance(sc.get("question_patterns"), list):
                candidates.extend(sc.get("question_patterns", []))
            if isinstance(sc.get("variants"), list):
                candidates.extend(sc.get("variants", []))
            for item in candidates:
                if isinstance(item, dict):
                    copied = dict(item)
                    copied["_topic_id"] = topic.get("id", "")
                    copied["_sub_scene_id"] = sc.get("id", "")
                    patterns.append(copied)
    return patterns


def text_of_pattern(pattern: dict[str, Any]) -> str:
    return str(pattern.get("question_pattern") or pattern.get("question") or pattern.get("query_pattern") or "")


def validate_atlas(json_path: str, strict: bool = False, ai_feedback: bool = False) -> int:
    result = AtlasValidationResult()

    if not os.path.exists(json_path):
        print(f"[错误] 文件不存在：{json_path}")
        return 1

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as exc:
        print(f"[错误] JSON 解析失败：{exc}")
        return 1

    # 0. 禁用字段检查：S2 不得携带监控题库。
    forbidden_hits: list[str] = []
    for obj in walk(data):
        if isinstance(obj, dict):
            for key in obj:
                if key in FORBIDDEN_KEYS:
                    if key == "is_probe" and obj.get(key) in (False, None, ""):
                        continue
                    forbidden_hits.append(key)
        elif isinstance(obj, str):
            for marker in FORBIDDEN_TEXT_MARKERS:
                if marker in obj:
                    forbidden_hits.append(marker)
    if forbidden_hits:
        result.error(
            f"发现监控题库/代表题字段或文本：{sorted(set(forbidden_hits))}",
            "删除 probes/is_probe/monitoring_questions/recommended_questions 等字段；S5 监控问题必须由客户在暂停 2 自行确认。",
        )

    # 1. 三元组数量与语义完整性。
    triplets = data.get("triplets", [])
    result.stat("三元组数量", len(triplets))
    if len(triplets) < 30:
        result.error(f"三元组数量不足：{len(triplets)}/30", "请补充用户—场景—意图三元组至至少 30 条。")

    triplet_ids: set[str] = set()
    incomplete_triplets: list[int] = []
    for i, t in enumerate(triplets):
        if not isinstance(t, dict):
            incomplete_triplets.append(i)
            continue
        tid = str(t.get("id", ""))
        if tid:
            triplet_ids.add(tid)
        if not t.get("user") or not t.get("scenario") or not t.get("intent"):
            incomplete_triplets.append(i)
    if incomplete_triplets:
        result.error(
            f"以下三元组语义不完整（user/scenario/intent 为空）：索引 {incomplete_triplets[:10]}",
            "请补齐缺失的 user/scenario/intent 字段。",
        )

    # 2. 场景树结构。
    topics = data.get("topics", [])
    risk_topic_ids = {"TOPIC-RISK", "TOPIC-NEG", "TOPIC_RISK", "TOPIC_NEG"}
    positive_topics = [t for t in topics if isinstance(t, dict) and str(t.get("id", "")) not in risk_topic_ids]
    risk_topics = [t for t in topics if isinstance(t, dict) and str(t.get("id", "")) in risk_topic_ids]

    result.stat("核心话题数（不含风险/负面）", len(positive_topics))
    result.stat("风险/负面话题", "有" if risk_topics else "无")
    if len(positive_topics) < 3:
        result.error(f"核心话题数不足：{len(positive_topics)}/3", "请补充核心话题至 3-5 个。")
    elif len(positive_topics) > 5:
        result.warn(f"核心话题数过多：{len(positive_topics)}/5", "建议合并至 3-5 个核心话题。")

    # 3. 子场景和问法模式数量。
    all_sub_scenes: list[Any] = []
    for topic in topics:
        if isinstance(topic, dict) and isinstance(topic.get("sub_scenes"), list):
            all_sub_scenes.extend(topic.get("sub_scenes", []))
    result.stat("子场景总数", len(all_sub_scenes))
    if len(all_sub_scenes) < 12:
        result.error(f"子场景总数不足：{len(all_sub_scenes)}/12", "请补充子场景至至少 12 个。")

    patterns = collect_question_patterns(topics)
    result.stat("问法模式/搜索模式总数", len(patterns))
    if len(patterns) < 30:
        result.error(f"问法模式总数不足：{len(patterns)}/30", "请补充问法模式至至少 30 个。")

    # 4. 品牌名分层。
    brand_count = sum(1 for p in patterns if bool(p.get("contains_brand")))
    no_brand_count = len(patterns) - brand_count
    no_brand_ratio = no_brand_count / len(patterns) if patterns else 0
    result.stat("含品牌名问法数", brand_count)
    result.stat("不含品牌名问法数", no_brand_count)
    result.stat("品类拦截型问法占比", f"{no_brand_ratio:.0%}")
    if no_brand_ratio < 0.6:
        result.error(
            f"品类拦截型问法占比不足：{no_brand_ratio:.0%} < 60%",
            "请增加不含品牌名的品类/场景型问法模式。",
        )

    # 5. 风险维度覆盖，如存在风险话题则检查维度。
    risk_dimensions: set[str] = set()
    for topic in risk_topics:
        for sc in topic.get("sub_scenes", []):
            if not isinstance(sc, dict):
                continue
            dim = str(sc.get("dimension") or sc.get("risk_dimension") or "")
            if dim:
                risk_dimensions.add(dim)
            for p in (sc.get("question_patterns") or sc.get("variants") or []):
                if isinstance(p, dict):
                    dim = str(p.get("dimension") or p.get("risk_dimension") or "")
                    if dim:
                        risk_dimensions.add(dim)
    if risk_topics:
        missing_dims = REQUIRED_RISK_DIMS - risk_dimensions
        if missing_dims:
            result.warn(
                f"风险顾虑维度覆盖可补充，缺少：{sorted(missing_dims)}",
                "如该品牌需要风险回应策略，请补齐质量、价格、服务、资质、竞品等维度。",
            )

    # 6. 问法模式与三元组映射。
    unmapped: list[str] = []
    for p in patterns:
        mapped = p.get("mapped_triplets", [])
        if not isinstance(mapped, list) or len(mapped) == 0:
            unmapped.append(str(p.get("id", "?")))
        else:
            missing_ids = [mid for mid in mapped if mid not in triplet_ids]
            if missing_ids:
                result.warn(
                    f"问法模式 {p.get('id', '?')} 映射了不存在的三元组：{missing_ids[:5]}",
                    "请确认 mapped_triplets 中的 ID 与 triplets[].id 一致。",
                )
    if unmapped:
        result.error(f"{len(unmapped)} 个问法模式未映射到任何三元组：{unmapped[:10]}", "请为每个问法模式添加 mapped_triplets。")

    # 7. 用户画像覆盖。
    profiles = data.get("user_profiles", [])
    industries: set[str] = set()
    roles: set[str] = set()
    for p in profiles:
        if isinstance(p, dict):
            ind = str(p.get("industry", ""))
            role = str(p.get("role", ""))
            if ind:
                industries.add(ind)
            if role:
                roles.add(role)
    result.stat("用户画像数", len(profiles))
    result.stat("覆盖行业数", len(industries))
    result.stat("覆盖角色数", len(roles))
    if len(industries) < 3 and len(roles) < 3:
        result.error(
            f"用户画像覆盖不足：行业 {len(industries)} 个，角色 {len(roles)} 个",
            "请至少覆盖 3 个行业或 3 类决策角色。",
        )

    # 8. 问法文本质量。
    for p in patterns:
        pid = str(p.get("id", "?"))
        text = text_of_pattern(p)
        if len(text) < 6:
            result.warn(f"问法模式 {pid} 文本过短（{len(text)} 字）", "请补充为更自然、完整的搜索表达。")

    # 下游契约提示，不阻断。
    contract = data.get("downstream_contract", {}) if isinstance(data, dict) else {}
    if isinstance(contract, dict):
        if contract.get("s2_provides_monitoring_questions") is not False:
            result.warn(
                "downstream_contract.s2_provides_monitoring_questions 未显式为 false",
                "建议写入 false，以避免下游误把 S2 当作监控题源。",
            )

    print(result.summary())

    if ai_feedback:
        print("\n--- AI 修正建议（JSON）---")
        print(result.ai_feedback_json())

    if not result.passed:
        return 1
    if result.warnings and strict:
        return 1
    if result.warnings:
        return 2
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="营销图谱 JSON 校验器（V3.5 — 分析版）")
    parser.add_argument("json_file", help="营销图谱 JSON 文件路径")
    parser.add_argument("--strict", action="store_true", help="严格模式：警告也返回失败")
    parser.add_argument("--ai-feedback", action="store_true", help="输出 AI 可解析的 JSON 修正建议")
    args = parser.parse_args()
    sys.exit(validate_atlas(args.json_file, args.strict, args.ai_feedback))
