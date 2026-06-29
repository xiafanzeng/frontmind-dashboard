#!/usr/bin/env python3
"""
FrontMind 策略包构建器
用途：收集 S1-S9 执行层工程产物，计算哈希，生成 strategy_pack_v{N}.json；若存在 S10 品牌信息确认表，则写入 client_deliverables。

用法：
  python3 pack_builder.py --brand "品牌名" --work-dir "./" --version 1 --recommended-actions "GEO_A1_entity_facts,GEO_A3_qa_assets,GEO_A5_site_schema"

参数：
  --brand     品牌中文简称
  --work-dir  工作目录路径
  --version   策略包版本号
  --recommended-actions  S9 推荐的 GEO 业务行动 ID（逗号分隔）
              合法值：GEO_A1_entity_facts / GEO_A2_ai_visibility / GEO_A3_qa_assets / GEO_A4_positioning_language / GEO_A5_site_schema / GEO_A6_distribution_citations
  --s7-branch S7 执行的分支（A 或 B，默认 B）
"""

import os
import sys
import json
import hashlib
import argparse
from datetime import datetime


# ============================================================
# 合法的 GEO 业务行动 ID（与 S9 enablement-modules.md 一致）
# ============================================================
VALID_ACTION_IDS = {
    "GEO_A1_entity_facts",
    "GEO_A2_ai_visibility",
    "GEO_A3_qa_assets",
    "GEO_A4_positioning_language",
    "GEO_A5_site_schema",
    "GEO_A6_distribution_citations",
}

ACTION_TITLES = {
    "GEO_A1_entity_facts": "实体与事实资产修复",
    "GEO_A2_ai_visibility": "AI 可见性修复",
    "GEO_A3_qa_assets": "问答内容资产建设",
    "GEO_A4_positioning_language": "定位与话语一致性",
    "GEO_A5_site_schema": "网站与结构化数据",
    "GEO_A6_distribution_citations": "分发与引用路径",
}


# ============================================================
# 文件映射表（与 shared/output-format-standard.md 完全一致）
# ============================================================
ARTIFACT_MAP = {
    "S1_brand_facts": {
        "json": "S1_{brand}_品牌事实图谱.json",
        "md": "S1_{brand}_品牌知识库.md",
        "pdf": "S1_{brand}_品牌知识库.pdf",
        "gap_report": "S1_{brand}_知识库缺口报告.md"
    },
    "S2_marketing_atlas": {
        "json": "S2_{brand}_营销图谱.json",
        "md": "S2_{brand}_营销图谱报告.md",
        "pdf": "S2_{brand}_营销图谱报告.pdf"
    },
    "S3_category_trend": {
        "md": "S3_{brand}_品类趋势报告.md",
        "pdf": "S3_{brand}_品类趋势报告.pdf",
        "json": "S3_{brand}_趋势打分卡.json"
    },
    "S4_positioning": {
        "md": "S4_{brand}_品牌定位声明.md",
        "pdf": "S4_{brand}_品牌定位声明.pdf",
        "json": "S4_{brand}_定位声明.json",
        "report_md": "S4_{brand}_定位分析报告.md",
        "report_pdf": "S4_{brand}_定位分析报告.pdf"
    },
    "S5_diagnosis": {
        "json": "S5_{brand}_品牌诊断数据.json",
        "md": "S5_{brand}_品牌诊断数据.md",
        "pdf": "S5_{brand}_品牌诊断数据.pdf",
        "gap_md": "S5_{brand}_Gap报告.md"
    },
    "S5.5_semantic_audit": {
        "json": "S5.5_{brand}_语义资产评分卡.json",
        "md": "S5.5_{brand}_语义资产审计报告.md",
        "pdf": "S5.5_{brand}_语义资产审计报告.pdf"
    },
    "S6_verbal_identity": {
        "md": "S6_{brand}_话语手册.md",
        "pdf": "S6_{brand}_话语手册.pdf",
        "token_json": "S6_{brand}_话语token.json"
    },
    "S7_supersign": {
        "prompt_json": "S7_{brand}_视觉Prompt包.json",
        "md": "S7_{brand}_视觉符号体系报告.md",
        "pdf": "S7_{brand}_视觉符号体系报告.pdf"
    },
    "S8_question_qa": {
        "json": "S8_{brand}_问答树.json",
        "matrix_json": "S8_{brand}_问答矩阵.json",
        "calendar_json": "S8_{brand}_内容日历.json",
        "md": "S8_{brand}_问答报告.md",
        "pdf": "S8_{brand}_问答报告.pdf",
        "blueprint_md": "S8_{brand}_落地页蓝图.md"
    },
    "S9_enablement": {
        "md": "S9_{brand}_业务赋能建议包.md",
        "pdf": "S9_{brand}_业务赋能建议包.pdf",
        "completeness_md": "S9_{brand}_策略完整性检查.md"
    }
}



def compute_sha256(filepath: str) -> str:
    """计算文件的 SHA256 哈希值"""
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def build_pack(brand: str, work_dir: str, version: int,
               recommended_actions: list, s7_branch: str = "B") -> dict:
    """构建策略输出包 JSON"""

    ai_monitor_file = f"{brand}_AI可见性监测数据.json"
    ai_monitor_uploaded = os.path.exists(os.path.join(work_dir, ai_monitor_file))
    pause_2_status = "completed" if ai_monitor_uploaded else "pending_upload"

    rl_generated = f"{brand}_应答逻辑确认表.xlsx"
    rl_filled = f"{brand}_应答逻辑确认表_现场讨论.xlsx"
    generated_exists = os.path.exists(os.path.join(work_dir, rl_generated))
    filled_exists = os.path.exists(os.path.join(work_dir, rl_filled))
    if filled_exists:
        pause_3_status = "completed"
    elif generated_exists:
        pause_3_status = "pending_client_fill"
    else:
        pause_3_status = "pending_generation"

    # 暂停4：S10 品牌信息确认表的生成/企业回传已确认/修改回灌状态
    bic_generated = f"S10_{brand}_品牌信息确认表.xlsx"
    bic_confirmed = f"S10_{brand}_品牌信息确认表_已确认.xlsx"
    bic_diff = f"{brand}_品牌信息修改清单.json"
    bic_generated_exists = os.path.exists(os.path.join(work_dir, bic_generated))
    bic_confirmed_exists = os.path.exists(os.path.join(work_dir, bic_confirmed))
    bic_diff_exists = os.path.exists(os.path.join(work_dir, bic_diff))
    if bic_confirmed_exists:
        # 企业已回传确认版；若有修改清单则表示已走过回灌解析，视为完成
        pause_4_status = "completed"
    elif bic_generated_exists:
        pause_4_status = "pending_client_confirmation"
    else:
        pause_4_status = "pending_generation"

    blocking_errors = []
    if pause_2_status != "completed":
        blocking_errors.append(
            f"暂停2未完成：缺少 AI 可见性监测数据文件 {ai_monitor_file}，不能生成最终 strategy_pack。"
        )
    if pause_3_status != "completed":
        blocking_errors.append(
            "暂停3未完成：企业尚未交回已填写的《应答逻辑确认表》，不能生成最终 strategy_pack。"
        )
    if pause_4_status != "completed":
        blocking_errors.append(
            "暂停4未完成：企业尚未回传已最终确认的《品牌信息确认表》（需 S10_{brand}_品牌信息确认表_已确认.xlsx），修改未回灌 S1-S9，不能生成最终 strategy_pack。"
        )
    if blocking_errors:
        raise RuntimeError("\n".join(blocking_errors))

    pack = {
        "meta": {
            "brand": brand,
            "version": version,
            "created_at": datetime.now().isoformat(),
            "created_by": "S0_strategy_orchestrator",
            "strategy_nodes_completed": []
        },
        "artifacts": {},
        "recommended_business_actions": recommended_actions,
        "s7_branch": s7_branch,
        "pause_log": {
            "pause_1": {"status": "confirmed", "user_feedback": ""},
            "pause_2": {
                "status": pause_2_status,
                "region": "",
                "uploaded_file": ai_monitor_file if ai_monitor_uploaded else None
            },
            "pause_3": {
                "status": pause_3_status,
                "generated_file": rl_generated if generated_exists else None,
                "filled_file": rl_filled if filled_exists else None
            },
            "pause_4": {
                "status": pause_4_status,
                "generated_file": bic_generated if bic_generated_exists else None,
                "uploaded_file": bic_confirmed if bic_confirmed_exists else None,
                "diff_record": bic_diff if bic_diff_exists else None
            }
        },
        "client_deliverables": {
            "response_logic_confirmation_form": rl_generated if generated_exists else None,
            "response_logic_confirmation_filled": rl_filled if filled_exists else None,
            "brand_info_confirmation_sheet": None,
            "brand_info_confirmation_confirmed": bic_confirmed if bic_confirmed_exists else None,
            "brand_info_modification_list": bic_diff if bic_diff_exists else None
        }
    }

    # S10 是客户交付物，不进入执行层 artifacts；若文件存在则登记到 client_deliverables。
    s10_files = {
        "brand_info_confirmation_sheet": f"S10_{brand}_品牌信息确认表.xlsx",
    }
    for key, filename in s10_files.items():
        filepath = os.path.join(work_dir, filename)
        if os.path.exists(filepath) and os.path.getsize(filepath) > 0:
            pack["client_deliverables"][key] = filename

    missing_files = []
    completed_nodes = []

    for artifact_key, file_map in ARTIFACT_MAP.items():
        node_id = artifact_key.split("_")[0]  # "S1", "S2", ...
        artifact_entry = {}
        node_complete = True

        for field_key, filename_template in file_map.items():
            filename = filename_template.replace("{brand}", brand)
            filepath = os.path.join(work_dir, filename)

            if os.path.exists(filepath):
                artifact_entry[field_key] = filename
            else:
                artifact_entry[field_key] = filename
                missing_files.append(f"[{node_id}] {filename}")
                node_complete = False

        # 计算主文件的 SHA256（取第一个存在的文件）
        for field_key, filename_template in file_map.items():
            filename = filename_template.replace("{brand}", brand)
            filepath = os.path.join(work_dir, filename)
            if os.path.exists(filepath):
                artifact_entry["sha256"] = compute_sha256(filepath)
                break
        else:
            artifact_entry["sha256"] = "MISSING"

        pack["artifacts"][artifact_key] = artifact_entry

        if node_complete:
            completed_nodes.append(node_id)

    pack["meta"]["strategy_nodes_completed"] = completed_nodes

    # 报告缺失文件
    if missing_files:
        print(f"[WARNING] 以下文件缺失：")
        for f in missing_files:
            print(f"  - {f}")
        print(f"\n已完成节点：{completed_nodes}")
        print(f"共 {len(completed_nodes)}/10 个执行层策略资产节点完成（S1-S9 + S5.5；S10 为 client_deliverable）")
        print(f"\n🚨 注意：策略包存在缺失文件，将无法通过执行层 E0 的深度校验！请打回相应的策略节点重跑。")
    else:
        print(f"[OK] 全部 10 个执行层策略资产节点产出齐全（S1-S9 + S5.5；S10 另列入 client_deliverables）")

    return pack


# ============================================================
# CLI 入口
# ============================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FrontMind 策略包构建器")
    parser.add_argument("--brand", required=True, help="品牌中文简称")
    parser.add_argument("--work-dir", default="./", help="工作目录路径")
    parser.add_argument("--version", type=int, default=1, help="策略包版本号")
    parser.add_argument("--recommended-actions", default="", help="S9 推荐的 GEO 业务行动 ID（逗号分隔，如 GEO_A1_entity_facts,GEO_A3_qa_assets）")
    parser.add_argument("--selected", default="", help="兼容旧参数；已弃用。若传入旧 M1-M5 ID 将报错，请改用 --recommended-actions。")
    parser.add_argument("--s7-branch", default="B", choices=["A", "B"], help="S7 分支")

    args = parser.parse_args()

    # 解析 S9 推荐的 GEO 业务行动 ID；--selected 仅保留为兼容入口，不再接受旧 M1-M5 ID
    raw_actions = args.recommended_actions or args.selected
    action_ids = [x.strip() for x in raw_actions.split(",") if x.strip()]

    # 校验行动 ID 合法性
    invalid_ids = [s for s in action_ids if s not in VALID_ACTION_IDS]
    if invalid_ids:
        print(f"[ERROR] 非法的 GEO 业务行动 ID：{invalid_ids}")
        print(f"合法值：{sorted(VALID_ACTION_IDS)}")
        sys.exit(1)

    recommended_actions = [
        {
            "action_id": action_id,
            "title": ACTION_TITLES[action_id],
            "problem_linked": [],
            "priority": "P1",
            "reason": "由 S9 业务赋能建议包给出具体证据与推荐原因。",
            "expected_business_effect": "由 S9 业务赋能建议包给出预期 GEO 业务效果。",
            "owner_hint": "由 S9 业务赋能建议包给出建议负责人。"
        }
        for action_id in action_ids
    ]

    pack = build_pack(
        brand=args.brand,
        work_dir=args.work_dir,
        version=args.version,
        recommended_actions=recommended_actions,
        s7_branch=args.s7_branch
    )

    output_filename = f"S0_{args.brand}_strategy_pack_v{args.version}.json"
    output_path = os.path.join(args.work_dir, output_filename)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(pack, f, ensure_ascii=False, indent=2)

    print(f"\n[OK] 策略包已生成：{output_path}")
