#!/usr/bin/env python3
"""
FrontMind 策略层状态检测器
用途：扫描工作目录，检测各策略节点的源文件是否存在，确定断点续跑的起始节点。

重要约束：S1-S9 策略分析节点完成状态只检查 JSON/Markdown/图片/Prompt 等源文件，绝不以 PDF 是否存在作为节点完成条件。S10 是品牌信息确认表节点，其必需产物是双子表 XLSX（不再生成全景报告 HTML/PDF）。S1-S9 单节点客户版 PDF 仅在 S10 完成后，经用户明确确认后，才进入统一 PDF 阶段检查和生成；用户未回复时必须暂停等待。

用法：
  python3 state_detector.py --brand "品牌名" --work-dir "./"

输出：
  - 打印各节点状态（✅ 已完成 / ❌ 未完成）
  - 返回第一个未完成节点的编号（如 "S3" 或 "S10"）；S10 生成后需经暂停4（企业最终确认与回灌），随后返回 "AWAITING_UNIFIED_PDF_CONFIRMATION"、"READY_FOR_UNIFIED_PDF"、"COMPLETE_PDF_SKIPPED" 或 "COMPLETE"
"""

import os
import sys
import json
import argparse
from datetime import datetime


# ============================================================
# 各节点的核心源文件（用于判断节点是否完成）
# ============================================================
NODE_FILES = {
    "S1": {
        "primary": "S1_{brand}_品牌事实图谱.json",
        "secondary": [
            "S1_{brand}_品牌知识库.md",
            "S1_{brand}_知识库缺口报告.md"
        ]
    },
    "S2": {
        "primary": "S2_{brand}_营销图谱.json",
        "secondary": [
            "S2_{brand}_营销图谱报告.md"
        ]
    },
    "S3": {
        "primary": "S3_{brand}_品类趋势报告.md",
        "secondary": [
            "S3_{brand}_趋势打分卡.json"
        ]
    },
    "S4": {
        "primary": "S4_{brand}_品牌定位声明.md",
        "secondary": [
            "S4_{brand}_定位声明.json",
            "S4_{brand}_定位分析报告.md"
        ]
    },
    "S5": {
        "primary": "S5_{brand}_品牌诊断数据.json",
        "secondary": [
            "S5_{brand}_品牌诊断数据.md",
            "S5_{brand}_Gap报告.md"
        ]
    },
    "S5.5": {
        "primary": "S5.5_{brand}_语义资产评分卡.json",
        "secondary": [
            "S5.5_{brand}_语义资产审计报告.md"
        ]
    },
    "S6": {
        "primary": "S6_{brand}_话语手册.md",
        "secondary": [
            "S6_{brand}_话语token.json"
        ]
    },
    "S7": {
        "primary": "S7_{brand}_视觉Prompt包.json",
        "secondary": [
            "S7_{brand}_视觉符号体系报告.md"
        ]
    },
    "S8": {
        "primary": "S8_{brand}_问答树.json",
        "secondary": [
            "S8_{brand}_问答矩阵.json",
            "S8_{brand}_内容日历.json",
            "S8_{brand}_问答报告.md",
            "S8_{brand}_落地页蓝图.md"
        ]
    },
    "S9": {
        "primary": "S9_{brand}_业务赋能建议包.md",
        "secondary": [
            "S9_{brand}_策略完整性检查.md"
        ]
    },
    "S10": {
        "primary": "S10_{brand}_品牌信息确认表.xlsx",
        "secondary": []
    }
}

UNIFIED_PDF_CONFIRMATION_FILE = ".frontmind_unified_pdf_confirmed"
UNIFIED_PDF_SKIP_FILE = ".frontmind_unified_pdf_skipped"

UNIFIED_PDF_FILES = [
    "S1_{brand}_品牌知识库.pdf",
    "S2_{brand}_营销图谱报告.pdf",
    "S3_{brand}_品类趋势报告.pdf",
    "S4_{brand}_品牌定位声明.pdf",
    "S4_{brand}_定位分析报告.pdf",
    "S5_{brand}_品牌诊断数据.pdf",
    "S5.5_{brand}_语义资产审计报告.pdf",
    "S6_{brand}_话语手册.pdf",
    "S7_{brand}_视觉符号体系报告.pdf",
    "S8_{brand}_问答报告.pdf",
    "S9_{brand}_业务赋能建议包.pdf",
]


# 暂停点依赖
PAUSE_DEPENDENCIES = {
    "PAUSE-1": {"after": "S1", "before": "S2"},
    "PAUSE-2": {"after": "S4", "before": "S5", "requires_upload": "{brand}_AI可见性监测数据.json"},
    "PAUSE-3": {
        "after": "S9",
        "before": "S10",
        "generated_file": "{brand}_应答逻辑确认表.xlsx",
        "requires_upload": "{brand}_应答逻辑确认表_现场讨论.xlsx"
    },
    "PAUSE-4": {
        "after": "S10",
        "before": "PACK",
        "generated_file": "S10_{brand}_品牌信息确认表.xlsx",
        "requires_upload": "S10_{brand}_品牌信息确认表_已确认.xlsx"
    }
}


def check_file(brand: str, work_dir: str, filename_template: str) -> bool:
    """检查文件是否存在且非空。"""
    filename = filename_template.replace("{brand}", brand)
    filepath = os.path.join(work_dir, filename)
    return os.path.exists(filepath) and os.path.getsize(filepath) > 0


def check_file_list(brand: str, work_dir: str, filename_templates: list[str]) -> list[str]:
    missing = []
    for item in filename_templates:
        if not check_file(brand, work_dir, item):
            missing.append(item.replace("{brand}", brand))
    return missing


def detect_state(brand: str, work_dir: str) -> dict:
    """
    扫描工作目录，返回各节点源文件状态、第一个未完成节点和统一 PDF 阶段状态。
    """
    result = {
        "brand": brand,
        "work_dir": os.path.abspath(work_dir),
        "scan_time": datetime.now().isoformat(),
        "node_status": {},
        "first_incomplete": "AWAITING_UNIFIED_PDF_CONFIRMATION",
        "resume_from": "ASK_USER_UNIFIED_PDF_CONFIRMATION",
        "pause_status": {},
        "unified_pdf_status": {}
    }

    first_incomplete = None

    for node_id, files in NODE_FILES.items():
        primary_exists = check_file(brand, work_dir, files["primary"])
        missing_secondary = check_file_list(brand, work_dir, files["secondary"])
        node_complete = primary_exists and len(missing_secondary) == 0

        result["node_status"][node_id] = {
            "complete": node_complete,
            "primary_exists": primary_exists,
            "missing_secondary": missing_secondary,
            "completion_basis": "s10_requires_xlsx_confirmation_sheet" if node_id == "S10" else "source_files_only_no_pdf"
        }

        if not node_complete and first_incomplete is None:
            first_incomplete = node_id

    if first_incomplete:
        result["first_incomplete"] = first_incomplete
        result["resume_from"] = first_incomplete
    else:
        missing_pdfs = check_file_list(brand, work_dir, UNIFIED_PDF_FILES)
        confirmation_path = os.path.join(work_dir, UNIFIED_PDF_CONFIRMATION_FILE)
        skip_path = os.path.join(work_dir, UNIFIED_PDF_SKIP_FILE)
        confirmed = os.path.exists(confirmation_path)
        skipped = os.path.exists(skip_path)
        result["unified_pdf_status"] = {
            "complete": len(missing_pdfs) == 0,
            "missing": missing_pdfs,
            "confirmation_required": len(missing_pdfs) > 0 and not confirmed and not skipped,
            "confirmed": confirmed,
            "skipped": skipped,
            "confirmation_file": UNIFIED_PDF_CONFIRMATION_FILE,
            "skip_file": UNIFIED_PDF_SKIP_FILE,
            "default_behavior": "ask_user_and_wait_no_auto_generation"
        }
        if len(missing_pdfs) == 0:
            result["first_incomplete"] = "COMPLETE"
            result["resume_from"] = "COMPLETE"
        elif skipped:
            result["first_incomplete"] = "COMPLETE_PDF_SKIPPED"
            result["resume_from"] = "COMPLETE"
        elif confirmed:
            result["first_incomplete"] = "READY_FOR_UNIFIED_PDF"
            result["resume_from"] = "UNIFIED_PDF"
        else:
            result["first_incomplete"] = "AWAITING_UNIFIED_PDF_CONFIRMATION"
            result["resume_from"] = "ASK_USER_UNIFIED_PDF_CONFIRMATION"

    # 检查暂停点状态。暂停点只依赖上游源文件，不依赖 PDF。
    for pause_id, deps in PAUSE_DEPENDENCIES.items():
        after_node = deps["after"]
        after_status = result["node_status"].get(after_node, {})

        if not after_status.get("complete", False):
            result["pause_status"][pause_id] = "not_reached"
        elif "generated_file" in deps and "requires_upload" in deps:
            generated_exists = check_file(brand, work_dir, deps["generated_file"])
            upload_exists = check_file(brand, work_dir, deps["requires_upload"])
            confirmation_exists = check_file(brand, work_dir, deps.get("confirmation_file", "")) if deps.get("confirmation_file") else False
            if upload_exists or confirmation_exists:
                result["pause_status"][pause_id] = "completed"
            elif generated_exists:
                result["pause_status"][pause_id] = "pending_client_confirmation"
            else:
                result["pause_status"][pause_id] = "pending_generation"
            if result["pause_status"][pause_id] != "completed":
                # 暂停点不得被后续历史文件绕过；只要上游已到达且确认未完成，就必须回到该暂停点。
                result["first_incomplete"] = f"{pause_id}_WAITING"
                result["resume_from"] = f"{pause_id}_WAITING"
        elif "requires_upload" in deps:
            upload_exists = check_file(brand, work_dir, deps["requires_upload"])
            result["pause_status"][pause_id] = "completed" if upload_exists else "pending_upload"
            if not upload_exists:
                # 暂停点不得被后续历史文件绕过；只要上游已到达且确认/上传未完成，就必须回到该暂停点。
                result["first_incomplete"] = f"{pause_id}_WAITING"
                result["resume_from"] = f"{pause_id}_WAITING"
        else:
            result["pause_status"][pause_id] = "completed"

    # 检查 strategy_pack 是否存在且有效
    pack_pattern = f"S0_{brand}_strategy_pack_v"
    pack_files = [f for f in os.listdir(work_dir) if f.startswith(pack_pattern.replace("{brand}", brand)) and f.endswith(".json")]

    valid_pack = None
    for pack_file in sorted(pack_files, reverse=True):
        pack_path = os.path.join(work_dir, pack_file)
        try:
            with open(pack_path, 'r', encoding='utf-8') as f:
                pack_data = json.load(f)
            if "meta" in pack_data and "artifacts" in pack_data:
                valid_pack = pack_file
                break
        except Exception:
            continue

    result["strategy_pack_exists"] = valid_pack is not None
    if valid_pack:
        result["latest_pack"] = valid_pack

    return result


def print_status(state: dict):
    """以人类可读格式打印状态。"""
    print("=" * 60)
    print(f"  FrontMind 策略层状态检测报告")
    print(f"  品牌：{state['brand']}")
    print(f"  目录：{state['work_dir']}")
    print(f"  时间：{state['scan_time']}")
    print("=" * 60)
    print()

    for node_id, status in state["node_status"].items():
        icon = "✅" if status["complete"] else "❌"
        primary_icon = "✓" if status["primary_exists"] else "✗"
        missing_count = len(status["missing_secondary"])
        basis_label = "品牌信息确认表 XLSX" if node_id == "S10" else "源文件不含 PDF"
        print(f"  {icon} {node_id}  主文件:{primary_icon}  缺失源附件:{missing_count}  完成依据: {basis_label}")
        if status["missing_secondary"]:
            for f in status["missing_secondary"]:
                print(f"       └─ 缺失: {f}")

    print()
    print("-" * 60)
    print(f"  首个未完成阶段：{state['first_incomplete']}")
    print(f"  建议从此处恢复：{state['resume_from']}")

    if state.get("unified_pdf_status"):
        status = state["unified_pdf_status"]
        icon = "✅" if status.get("complete") else "❌"
        if status.get("complete"):
            phase_label = "完成"
        elif status.get("skipped"):
            phase_label = "已按用户选择跳过"
        elif status.get("confirmed"):
            phase_label = "已确认，待生成"
        else:
            phase_label = "等待用户确认"
        print(f"  {icon} 统一 PDF 阶段：{phase_label}")
        if status.get("confirmation_required"):
            print('       └─ 需要使用 message(type="ask") 询问用户是否额外生成 S1-S9 各阶段 PDF；未回复前暂停等待')
        if status.get("confirmed") and status.get("missing"):
            print("       └─ 用户已确认，可运行 unified_pdf_report_generator.py --confirmed")
        if status.get("skipped"):
            print("       └─ 已检测到跳过标记，后续只交付源文件与策略包，不生成 PDF")
        for f in status.get("missing", []):
            print(f"       └─ 缺失 PDF: {f}")


    print()
    for pause_id, status in state["pause_status"].items():
        icon = {"completed": "✅", "skipped": "↪", "pending_upload": "⏳", "pending_client_form": "⏳", "pending_client_confirmation": "⏳", "pending_decision": "❔", "pending_generation": "📝", "not_reached": "⬜"}.get(status, "❓")
        print(f"  {icon} {pause_id}: {status}")

    if state.get("strategy_pack_exists"):
        print(f"\n  📦 策略包已存在：{state.get('latest_pack', 'N/A')}")
    else:
        print(f"\n  📦 策略包：未生成")

    print("=" * 60)


# ============================================================
# CLI 入口
# ============================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FrontMind 策略层状态检测器")
    parser.add_argument("--brand", required=True, help="品牌中文简称")
    parser.add_argument("--work-dir", default="./", help="工作目录路径")
    parser.add_argument("--json", action="store_true", help="以 JSON 格式输出")

    args = parser.parse_args()
    state = detect_state(args.brand, args.work_dir)

    if args.json:
        print(json.dumps(state, ensure_ascii=False, indent=2))
    else:
        print_status(state)
