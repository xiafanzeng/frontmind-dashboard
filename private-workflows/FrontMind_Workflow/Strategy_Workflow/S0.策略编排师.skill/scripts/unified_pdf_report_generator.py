#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FrontMind S10 后统一 PDF 报告生成器。

该脚本只允许在 S10 品牌信息确认表完成后的 S0 统一阶段调用。它先检查 S1-S9 的
JSON/Markdown 源文件，再在用户明确确认后调用 shared/geo_pdf_generator.py
批量生成客户版 PDF；未确认时必须退出，不得自动生成。

设计目标：
1. PDF 不在 S1-S9 节点内生成，避免过程产物和源数据脱节；
2. 统一阶段必须以最终 JSON/Markdown 源文件为准；
3. 默认行为是等待用户确认，不把沉默视为同意；
4. 对 S2 输出执行监控题库禁用字段检查，确保 S2 不再打印或下发监控问题。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class PdfJob:
    node: str
    source_md: str
    output_pdf: str
    title: str


def expected_jsons(brand: str) -> list[str]:
    return [
        f"S1_{brand}_品牌事实图谱.json",
        f"S2_{brand}_营销图谱.json",
        f"S3_{brand}_趋势打分卡.json",
        f"S4_{brand}_定位声明.json",
        f"S5_{brand}_品牌诊断数据.json",
        f"S5.5_{brand}_语义资产评分卡.json",
        f"S6_{brand}_话语token.json",
        f"S7_{brand}_视觉Prompt包.json",
        f"S8_{brand}_问答树.json",
        f"S8_{brand}_问答矩阵.json",
        f"S8_{brand}_内容日历.json",
        f"S9_{brand}_赋能建议菜单.json",
    ]


def pdf_jobs(brand: str) -> list[PdfJob]:
    return [
        PdfJob("S1", f"S1_{brand}_品牌知识库.md", f"S1_{brand}_品牌知识库.pdf", f"{brand} 品牌知识库"),
        PdfJob("S2", f"S2_{brand}_营销图谱报告.md", f"S2_{brand}_营销图谱报告.pdf", f"{brand} 营销图谱报告"),
        PdfJob("S3", f"S3_{brand}_品类趋势报告.md", f"S3_{brand}_品类趋势报告.pdf", f"{brand} 品类趋势报告"),
        PdfJob("S4", f"S4_{brand}_品牌定位声明.md", f"S4_{brand}_品牌定位声明.pdf", f"{brand} 品牌定位声明"),
        PdfJob("S4", f"S4_{brand}_定位分析报告.md", f"S4_{brand}_定位分析报告.pdf", f"{brand} 定位分析报告"),
        PdfJob("S5", f"S5_{brand}_品牌诊断数据.md", f"S5_{brand}_品牌诊断数据.pdf", f"{brand} 品牌诊断数据"),
        PdfJob("S5.5", f"S5.5_{brand}_语义资产审计报告.md", f"S5.5_{brand}_语义资产审计报告.pdf", f"{brand} 语义资产审计报告"),
        PdfJob("S6", f"S6_{brand}_话语手册.md", f"S6_{brand}_话语手册.pdf", f"{brand} 话语手册"),
        PdfJob("S7", f"S7_{brand}_视觉符号体系报告.md", f"S7_{brand}_视觉符号体系报告.pdf", f"{brand} 视觉符号体系报告"),
        PdfJob("S8", f"S8_{brand}_问答报告.md", f"S8_{brand}_问答报告.pdf", f"{brand} 问答报告"),
        PdfJob("S9", f"S9_{brand}_业务赋能建议包.md", f"S9_{brand}_业务赋能建议包.pdf", f"{brand} 业务赋能建议包"),
    ]


def fail(message: str) -> None:
    print(f"[FAIL] {message}", file=sys.stderr)
    raise SystemExit(1)


def ensure_nonempty(path: Path, label: str) -> None:
    if not path.exists():
        fail(f"缺少{label}: {path.name}")
    if path.stat().st_size <= 0:
        fail(f"{label}为空文件: {path.name}")


def load_json(path: Path) -> Any:
    ensure_nonempty(path, "JSON 源文件")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        fail(f"JSON 不可解析: {path.name}; {exc}")


def validate_json(path: Path) -> None:
    load_json(path)


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").strip())


def walk_objects(value: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(value, dict):
        found.append(value)
        for child in value.values():
            found.extend(walk_objects(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(walk_objects(child))
    return found


def validate_s2_no_monitoring_questions(work_dir: Path, brand: str) -> None:
    """S2 只做营销图谱分析：统一 PDF 阶段不要求题库，只阻断旧题库字段或章节。"""
    json_path = work_dir / f"S2_{brand}_营销图谱.json"
    md_path = work_dir / f"S2_{brand}_营销图谱报告.md"
    data = load_json(json_path)
    text = md_path.read_text(encoding="utf-8")

    forbidden_keys = {
        "probes",
        "positive_probes",
        "negative_probes",
        "representative_questions",
        "recommended_questions",
        "monitoring_questions",
        "probe_count",
        "is_probe",
    }
    hits: list[str] = []
    for obj in walk_objects(data):
        if isinstance(obj, dict):
            for key, value in obj.items():
                if key in forbidden_keys:
                    hits.append(key)
                if key == "is_probe" and value is True:
                    hits.append("is_probe=true")

    forbidden_headings = ["代表题清单", "正向代表题", "负面代表题", "Probes"]
    for term in forbidden_headings:
        if term in text:
            hits.append(term)

    if hits:
        fail(f"S2 已改为仅做营销图谱分析，但源文件仍包含旧监控题库字段或章节：{sorted(set(hits))}")


def run_pdf_generator(generator: Path, source_md: Path, output_pdf: Path, title: str) -> None:
    cmd = [sys.executable, str(generator), str(source_md), str(output_pdf), "--title", title]
    result = subprocess.run(cmd, cwd=str(source_md.parent), text=True, capture_output=True)
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        fail(f"PDF 生成失败: {output_pdf.name}")
    ensure_nonempty(output_pdf, "PDF 输出文件")


def main() -> None:
    parser = argparse.ArgumentParser(description="S10 后统一检查源文件并生成 S1-S9 PDF 报告")
    parser.add_argument("--brand", required=True, help="品牌名称")
    parser.add_argument("--work-dir", default=".", help="策略层工作目录")
    parser.add_argument("--generator", default="shared/geo_pdf_generator.py", help="Markdown 转 PDF 脚本路径")
    parser.add_argument("--dry-run", action="store_true", help="只检查源文件，不实际生成 PDF")
    parser.add_argument("--confirmed", action="store_true", help="表示用户已明确确认需要生成各阶段客户版 PDF；未提供时不会生成 PDF")
    args = parser.parse_args()

    work_dir = Path(args.work_dir).resolve()
    generator = (work_dir / args.generator).resolve() if not Path(args.generator).is_absolute() else Path(args.generator)
    ensure_nonempty(generator, "PDF 生成脚本")

    print(f"[INFO] 统一 PDF 阶段启动: brand={args.brand}, work_dir={work_dir}")

    confirmation_marker = work_dir / ".frontmind_unified_pdf_confirmed"
    confirmed_by_env = os.environ.get("FRONTMIND_UNIFIED_PDF_CONFIRMED", "").lower() in {"1", "true", "yes", "confirmed"}
    confirmed_by_marker = confirmation_marker.exists()
    is_confirmed = args.confirmed or confirmed_by_env or confirmed_by_marker

    if not args.dry_run and not is_confirmed:
        print("[WAIT] 统一 PDF 生成需要用户明确确认，当前未检测到确认。")
        print('[WAIT] 请先使用 message(type="ask") 询问用户是否需要额外生成 S1-S9 各阶段客户版 PDF；用户未回复前暂停等待。')
        print("[WAIT] 若用户确认需要生成，请追加 --confirmed 后重新运行本脚本；若用户选择跳过，请写入 .frontmind_unified_pdf_skipped 并继续后续流程。")
        sys.exit(2)

    if is_confirmed and not confirmation_marker.exists():
        confirmation_marker.write_text("confirmed_by_user\n", encoding="utf-8")

    for name in expected_jsons(args.brand):
        path = work_dir / name
        # S9 菜单在某些旧版策略包中可能由 S9 建议包内嵌；若不存在，降级为警告，不阻断统一 PDF。
        if name.endswith("赋能建议菜单.json") and not path.exists():
            print(f"[WARN] 可选 JSON 缺失: {name}")
            continue
        validate_json(path)

    jobs = pdf_jobs(args.brand)
    for job in jobs:
        ensure_nonempty(work_dir / job.source_md, f"{job.node} Markdown 源文件")

    validate_s2_no_monitoring_questions(work_dir, args.brand)

    if args.dry_run:
        print("[OK] dry-run 源文件与关键一致性检查通过，未生成 PDF")
        return

    generated: list[str] = []
    for job in jobs:
        source_md = work_dir / job.source_md
        output_pdf = work_dir / job.output_pdf
        run_pdf_generator(generator, source_md, output_pdf, job.title)
        generated.append(output_pdf.name)
        print(f"[OK] {job.node} PDF 已生成: {output_pdf.name}")

    print("[OK] 统一 PDF 阶段完成")
    print(json.dumps({"generated_pdfs": generated}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
