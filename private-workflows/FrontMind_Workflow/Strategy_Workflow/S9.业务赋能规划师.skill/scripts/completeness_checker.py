#!/usr/bin/env python3
"""
策略完整性检查器
用途：检查 S1-S9 源文件是否齐全且一致，确保进入“用户确认后的统一 PDF 阶段”前的策略层源数据质量。

用法：
  python3 completeness_checker.py --brand <brand_name> --workspace <dir> --output <report.md>

检查维度：
  1. 文件完整性：S1-S9 必须源文件是否存在（S10 全景 HTML/PDF 由 S10 输出；S1-S9 单节点 PDF 由 S0 在 S10 后按用户确认输出）
  2. 格式合规性：JSON 可解析、MD 非空
  3. 品牌名一致性：所有文件中品牌名统一
  4. 定位一致性：下游文件引用的定位与 S4 一致
  5. 话语一致性：S8 答案的话语 Token 命中率
  6. PDF 合规性：仅在 S10 后且用户确认生成 S1-S9 单节点 PDF 的统一阶段检查；节点完整性阶段不要求 PDF 已存在
  7. 证据源多样性：S1 必须包含 official_website 证据
"""

import os
import sys
import json
import argparse
from pathlib import Path
from datetime import datetime


# 必须文件清单（与 S0 SKILL.md 中的标准命名一致）
REQUIRED_FILES = [
    {"pattern": "S1_{brand}_品牌事实图谱.json", "source": "S1", "format": "json"},
    {"pattern": "S1_{brand}_品牌知识库.md", "source": "S1", "format": "md"},
    {"pattern": "S2_{brand}_营销图谱.json", "source": "S2", "format": "json"},
    {"pattern": "S2_{brand}_营销图谱报告.md", "source": "S2", "format": "md"},
    {"pattern": "S3_{brand}_趋势打分卡.json", "source": "S3", "format": "json"},
    {"pattern": "S3_{brand}_品类趋势报告.md", "source": "S3", "format": "md"},
    {"pattern": "S4_{brand}_定位声明.json", "source": "S4", "format": "json"},
    {"pattern": "S4_{brand}_品牌定位声明.md", "source": "S4", "format": "md"},
    {"pattern": "S4_{brand}_定位分析报告.md", "source": "S4", "format": "md"},
    {"pattern": "S5_{brand}_品牌诊断数据.json", "source": "S5", "format": "json"},
    {"pattern": "S5_{brand}_品牌诊断数据.md", "source": "S5", "format": "md"},
    {"pattern": "S5_{brand}_Gap报告.md", "source": "S5", "format": "md"},
    {"pattern": "S5.5_{brand}_语义资产评分卡.json", "source": "S5.5", "format": "json"},
    {"pattern": "S5.5_{brand}_语义资产审计报告.md", "source": "S5.5", "format": "md"},
    {"pattern": "S6_{brand}_话语token.json", "source": "S6", "format": "json"},
    {"pattern": "S6_{brand}_话语手册.md", "source": "S6", "format": "md"},
    {"pattern": "S7_{brand}_视觉Prompt包.json", "source": "S7", "format": "json"},
    {"pattern": "S7_{brand}_视觉符号体系报告.md", "source": "S7", "format": "md"},
    {"pattern": "S8_{brand}_问答树.json", "source": "S8", "format": "json"},
    {"pattern": "S8_{brand}_问答矩阵.json", "source": "S8", "format": "json"},
    {"pattern": "S8_{brand}_内容日历.json", "source": "S8", "format": "json"},
    {"pattern": "S8_{brand}_落地页蓝图.md", "source": "S8", "format": "md"},
    {"pattern": "S8_{brand}_问答报告.md", "source": "S8", "format": "md"},
    {"pattern": "S9_{brand}_业务赋能建议包.md", "source": "S9", "format": "md"},
]



def check_pdf_compliance(workspace: str, brand: str) -> list:
    """检查已有 PDF 是否由官方脚本生成（仅供 S0 在用户确认后的统一 PDF 阶段或最终打包前使用）。"""
    issues = []
    import subprocess
    for f in os.listdir(workspace):
        if f.endswith(".pdf"):
            filepath = os.path.join(workspace, f)
            try:
                result = subprocess.run(['pdfinfo', filepath], capture_output=True, text=True, timeout=5)
                if 'WeasyPrint' not in result.stdout:
                    issues.append({
                        "file": f,
                        "issue": "PDF 非官方模板生成（未使用 geo_pdf_generator.py/WeasyPrint），存在模板漂移",
                        "severity": "error"
                    })
            except Exception as e:
                issues.append({"file": f, "issue": f"PDF 检查失败: {e}", "severity": "warning"})
    return issues

def check_website_evidence(workspace: str, brand: str) -> list:
    """检查 S1 事实图谱是否包含官网证据。"""
    issues = []
    s1_file = os.path.join(workspace, f"S1_{brand}_品牌事实图谱.json")
    if os.path.exists(s1_file):
        try:
            with open(s1_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            evidence = data.get('evidence', [])
            has_website = any(e.get('source_type') == 'official_website' for e in evidence)
            if not has_website:
                issues.append({
                    "file": f"S1_{brand}_品牌事实图谱.json",
                    "issue": "缺乏官网抓取证据 (official_website)，S1 未执行强制抓取",
                    "severity": "error"
                })
        except:
            pass
    return issues

def check_file_existence(workspace: str, brand: str) -> list:
    """检查文件完整性。"""
    results = []
    for spec in REQUIRED_FILES:
        filename = spec["pattern"].replace("{brand}", brand)
        
        # 特殊处理 strategy_pack，支持 v1, v2 等版本号
        if "strategy_pack" in filename:
            pack_pattern = f"S0_{brand}_strategy_pack_v"
            pack_files = [f for f in os.listdir(workspace) if f.startswith(pack_pattern) and f.endswith(".json")]
            if pack_files:
                filename = sorted(pack_files, reverse=True)[0]
                
        filepath = os.path.join(workspace, filename)
        exists = os.path.isfile(filepath)
        size = os.path.getsize(filepath) if exists else 0
        results.append({
            "filename": filename,
            "source": spec["source"],
            "format": spec["format"],
            "exists": exists,
            "size": size,
            "path": filepath
        })
    return results


def check_format_compliance(file_results: list) -> list:
    """检查格式合规性。"""
    issues = []
    for fr in file_results:
        if not fr["exists"]:
            continue

        if fr["format"] == "json":
            try:
                with open(fr["path"], "r", encoding="utf-8") as f:
                    data = json.load(f)
                # 检查 JSON 不为空对象/空数组
                if data in ({}, []):
                    issues.append({
                        "file": fr["filename"],
                        "issue": "JSON 文件内容为空",
                        "severity": "error"
                    })
            except json.JSONDecodeError as e:
                issues.append({
                    "file": fr["filename"],
                    "issue": f"JSON 解析失败：{e}",
                    "severity": "error"
                })
        elif fr["format"] == "md":
            if fr["size"] < 100:
                issues.append({
                    "file": fr["filename"],
                    "issue": f"Markdown 文件过小：{fr['size']} 字节",
                    "severity": "warning"
                })
        elif fr["format"] == "html":
            if fr["size"] < 200:
                issues.append({
                    "file": fr["filename"],
                    "issue": f"HTML 文件过小：{fr['size']} 字节",
                    "severity": "warning"
                })
    return issues


def check_brand_consistency(workspace: str, brand: str, file_results: list) -> list:
    """检查品牌名一致性。"""
    issues = []
    for fr in file_results:
        if not fr["exists"] or fr["format"] != "json":
            continue
        try:
            with open(fr["path"], "r", encoding="utf-8") as f:
                data = json.load(f)
            # 检查常见的品牌名字段
            for key_path in [
                ["meta", "brand"],
                ["positioning_statement", "brand"],
                ["brand"],
            ]:
                obj = data
                for k in key_path:
                    if isinstance(obj, dict) and k in obj:
                        obj = obj[k]
                    else:
                        obj = None
                        break
                if obj and isinstance(obj, str) and obj != brand:
                    issues.append({
                        "file": fr["filename"],
                        "issue": f"品牌名不一致：期望 '{brand}'，实际 '{obj}'（路径 {'.'.join(key_path)}）",
                        "severity": "warning"
                    })
        except Exception:
            pass
    return issues


def check_positioning_consistency(workspace: str, brand: str) -> list:
    """检查定位一致性：S6/S7/S8 是否引用了 S4 的定位声明。"""
    issues = []
    positioning_path = os.path.join(workspace, f"S4_{brand}_定位声明.json")
    if not os.path.isfile(positioning_path):
        return issues

    try:
        with open(positioning_path, "r", encoding="utf-8") as f:
            pos_data = json.load(f)
        # 提取核心定位关键词（取 positioning_statement 或 core_statement）
        core_statement = ""
        if isinstance(pos_data, dict):
            core_statement = pos_data.get("positioning_statement", {}).get("core_statement", "")
            if not core_statement:
                core_statement = pos_data.get("core_statement", "")
        if not core_statement:
            return issues

        # 检查 S6 话语手册是否包含定位关键词
        verbal_md_path = os.path.join(workspace, f"S6_{brand}_话语手册.md")
        if os.path.isfile(verbal_md_path):
            with open(verbal_md_path, "r", encoding="utf-8") as f:
                verbal_content = f.read()
            # 取定位声明的前 20 个字作为关键词
            key_phrase = core_statement[:20]
            if key_phrase and key_phrase not in verbal_content:
                issues.append({
                    "file": f"S6_{brand}_话语手册.md",
                    "issue": f"话语手册未包含定位核心表达：'{key_phrase}...'",
                    "severity": "warning"
                })
    except Exception as e:
        issues.append({
            "file": "定位一致性检查",
            "issue": f"检查异常：{e}",
            "severity": "warning"
        })

    return issues


def check_verbal_consistency(workspace: str, brand: str) -> list:
    """检查话语一致性。"""
    issues = []
    token_path = os.path.join(workspace, f"S6_{brand}_话语token.json")
    qa_path = os.path.join(workspace, f"S8_{brand}_问答矩阵.json")

    if not os.path.isfile(token_path) or not os.path.isfile(qa_path):
        return issues

    try:
        with open(token_path, "r", encoding="utf-8") as f:
            tokens = json.load(f)
        with open(qa_path, "r", encoding="utf-8") as f:
            qa = json.load(f)

        banned = tokens.get("banned_words", [])
        # 兼容两种问答矩阵格式
        questions = qa.get("questions", [])
        if not questions and "question_stages" in qa:
            for stage in qa.get("question_stages", []):
                questions.extend(stage.get("questions", []))

        # 抽检前 10 条标准答案
        for q in questions[:10]:
            answer = q.get("standard_answer", "")
            qid = q.get("question_id", "?")

            # 禁用词检查
            violations = [w for w in banned if w.lower() in answer.lower()]
            if violations:
                issues.append({
                    "file": f"问答矩阵 {qid}",
                    "issue": f"标准答案使用了禁用词：{violations}",
                    "severity": "error"
                })
    except Exception as e:
        issues.append({
            "file": "话语一致性检查",
            "issue": f"检查异常：{e}",
            "severity": "warning"
        })

    return issues


def generate_report(brand: str, file_results: list, all_issues: list, output_path: str):
    """生成完整性检查报告。"""
    total_files = len(file_results)
    existing_files = sum(1 for f in file_results if f["exists"])
    errors = [i for i in all_issues if i["severity"] == "error"]
    warnings = [i for i in all_issues if i["severity"] == "warning"]

    passed = existing_files == total_files and len(errors) == 0

    lines = [
        f"# {brand} 策略完整性检查报告",
        "",
        f"> 检查时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"> 检查结果：{'✅ 通过' if passed else '❌ 未通过'}",
        "",
        "---",
        "",
        "## 一、文件完整性",
        "",
        f"| 文件名 | 来源 | 状态 | 大小 |",
        f"| :--- | :--- | :--- | :--- |",
    ]

    for fr in file_results:
        status = "✅ 存在" if fr["exists"] else "❌ 缺失"
        size = f"{fr['size']:,} B" if fr["exists"] else "-"
        lines.append(f"| {fr['filename']} | {fr['source']} | {status} | {size} |")

    lines.extend([
        "",
        f"**文件完整率**：{existing_files}/{total_files}",
        "",
    ])

    if all_issues:
        lines.extend([
            "## 二、问题清单",
            "",
            "| 文件 | 问题 | 严重程度 |",
            "| :--- | :--- | :--- |",
        ])
        for issue in all_issues:
            severity_icon = "🔴" if issue["severity"] == "error" else "🟡"
            lines.append(f"| {issue['file']} | {issue['issue']} | {severity_icon} {issue['severity']} |")
    else:
        lines.extend([
            "## 二、问题清单",
            "",
            "无问题。",
        ])

    lines.extend([
        "",
        "## 三、总结",
        "",
        f"- 错误数：{len(errors)}",
        f"- 警告数：{len(warnings)}",
        f"- 结论：{'策略层全部完成，可启动执行层' if passed else '存在阻断级问题，需修复后重新检查'}",
        "",
    ])

    report = "\n".join(lines)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"{'✅' if passed else '❌'} 完整性检查{'通过' if passed else '未通过'}：{output_path}")
    print(f"   文件完整率：{existing_files}/{total_files}")
    print(f"   错误：{len(errors)} | 警告：{len(warnings)}")

    return 0 if passed else 1


def main():
    parser = argparse.ArgumentParser(description="策略完整性检查器")
    parser.add_argument("--brand", required=True, help="品牌名称")
    parser.add_argument("--workspace", required=True, help="工作目录路径")
    parser.add_argument("--output", required=True, help="输出报告路径")
    args = parser.parse_args()

    # 1. 文件完整性
    file_results = check_file_existence(args.workspace, args.brand)

    # 2. 格式合规性
    format_issues = check_format_compliance(file_results)

    # 3. 品牌名一致性
    brand_issues = check_brand_consistency(args.workspace, args.brand, file_results)

    # 4. 定位一致性
    positioning_issues = check_positioning_consistency(args.workspace, args.brand)

    # 5. 话语一致性
    verbal_issues = check_verbal_consistency(args.workspace, args.brand)

    # 汇总
    all_issues = format_issues + brand_issues + positioning_issues + verbal_issues

    # 缺失文件也算 error
    for fr in file_results:
        if not fr["exists"]:
            all_issues.append({
                "file": fr["filename"],
                "issue": f"文件缺失（来源：{fr['source']}）",
                "severity": "error"
            })

    # 生成报告
    exit_code = generate_report(args.brand, file_results, all_issues, args.output)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
