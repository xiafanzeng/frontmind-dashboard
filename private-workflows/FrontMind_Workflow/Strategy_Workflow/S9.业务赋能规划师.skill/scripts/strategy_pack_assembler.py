#!/usr/bin/env python3
"""
策略总包打包器
用途：将 S1-S9 全部输出文件打包为 ZIP 交付件。

用法：
  python3 strategy_pack_assembler.py --brand <brand_name> --workspace <dir> --output <output.zip>

打包规则：
  1. 收集 S1-S8 核心策略文件
  2. 添加 S9 问题总结与 GEO 业务建议报告
  3. 生成 README.md
  4. 按标准目录结构打包为 ZIP
"""

import os
import sys
import json
import zipfile
import argparse
from datetime import datetime
from pathlib import Path


# 文件映射：ZIP 内路径 → 源文件名模式
FILE_MAP = [
    ("01_品牌事实图谱.json", "S1_{brand}_品牌事实图谱.json"),
    ("02_营销图谱.json", "S2_{brand}_营销图谱.json"),
    ("03_趋势打分卡.json", "S3_{brand}_趋势打分卡.json"),
    ("03_品类趋势报告.md", "S3_{brand}_品类趋势报告.md"),
    ("04_定位声明.json", "S4_{brand}_定位声明.json"),
    ("04_品牌定位声明.md", "S4_{brand}_品牌定位声明.md"),
    ("04_定位分析报告.md", "S4_{brand}_定位分析报告.md"),
    ("05_品牌诊断数据.json", "S5_{brand}_品牌诊断数据.json"),
    ("05_品牌诊断数据.md", "S5_{brand}_品牌诊断数据.md"),
    ("05_Gap报告.md", "S5_{brand}_Gap报告.md"),
    ("06_话语手册.md", "S6_{brand}_话语手册.md"),
    ("06_话语token.json", "S6_{brand}_话语token.json"),
    ("07_视觉符号体系报告.md", "S7_{brand}_视觉符号体系报告.md"),
    ("07_视觉Prompt包.json", "S7_{brand}_视觉Prompt包.json"),
    ("08_问答树.json", "S8_{brand}_问答树.json"),
    ("08_问答矩阵.json", "S8_{brand}_问答矩阵.json"),
    ("08_内容日历.json", "S8_{brand}_内容日历.json"),
    ("08_问答报告.md", "S8_{brand}_问答报告.md"),
    ("08_落地页蓝图.md", "S8_{brand}_落地页蓝图.md"),
]

# 额外文件（S9 自身输出）
EXTRA_FILES = [
    ("09_业务赋能建议包.md", "S9_{brand}_业务赋能建议包.md"),
    ("09_策略完整性检查.md", "S9_{brand}_策略完整性检查.md"),
]


def generate_readme(brand: str, included_files: list) -> str:
    """
    生成策略总包 README。

    Args:
        brand: 品牌名称
        included_files: 已包含的文件列表

    Returns:
        README 内容
    """
    file_table = "\n".join(
        f"| {f['zip_name']} | {f['source']} | {f['size']:,} B | ✅ |"
        for f in included_files
    )

    return f"""# {brand} 品牌策略总包

> 生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
> 生成工具：FrontMind 策略工作流 S9 业务赋能规划师

---

## 文件清单

| 文件名 | 来源 | 大小 | 状态 |
| :--- | :--- | :--- | :--- |
{file_table}

## 使用说明

1. 将本 ZIP 解压到执行层工作目录
2. 首先阅读 `09_业务赋能建议包.md`，了解 S1-S8 发现的企业问题和 GEO 行动建议
3. 如需进入执行层，再由 S0/E0 根据 strategy_pack 与本建议包启动后续执行
4. 执行过程中参考各策略文件

## 文件说明

| 编号 | 文件 | 说明 |
| :--- | :--- | :--- |
| 00 | 执行层启动指令 | 执行层操作手册，包含各节点的文件映射和操作指南 |
| 01 | 品牌事实图谱 | S1 输出，品牌基础信息的结构化数据 |
| 02 | 营销图谱 | S2 输出，用户搜索意图和问题的完整图谱 |
| 03 | 趋势研判 | S3 输出，品类趋势和机会信号 |
| 04 | 定位声明 | S4 输出，品牌定位的核心文档 |
| 05 | 诊断报告 | S5 输出，品牌 AI 可见性的 7 维诊断 |
| 06 | 话语手册/Token | S6 输出，品牌语言体系和机器可执行的话语规则 |
| 07 | 视觉符号体系/Prompt包 | S7 输出，品牌视觉体系和 AI 绘画指令 |
| 08 | 问答矩阵/内容日历 | S8 输出，用户问答架构和内容排期 |
| 09 | 业务赋能建议包 | S9 输出，S1-S8 企业问题总结、GEO 业务建议和优先行动路线图 |
"""


def assemble_pack(brand: str, workspace: str, output: str) -> int:
    """
    打包策略总包。

    Args:
        brand: 品牌名称
        workspace: 工作目录
        output: 输出 ZIP 路径

    Returns:
        0 = 成功, 1 = 失败
    """
    included = []
    missing = []
    pack_dir = f"{brand}_品牌策略总包"

    all_files = FILE_MAP + EXTRA_FILES

    for zip_name, src_pattern in all_files:
        src_name = src_pattern.replace("{brand}", brand)
        src_path = os.path.join(workspace, src_name)

        if os.path.isfile(src_path):
            size = os.path.getsize(src_path)
            source = zip_name.split("_")[0]
            included.append({
                "zip_name": zip_name,
                "src_path": src_path,
                "source": f"S{source}" if source.isdigit() else source,
                "size": size
            })
        else:
            missing.append(src_name)

    if missing:
        print(f"[警告] 以下文件缺失，将跳过：")
        for m in missing:
            print(f"  - {m}")

    # 生成 README
    readme_content = generate_readme(brand, included)

    # 打包
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
        # README
        zf.writestr(f"{pack_dir}/README.md", readme_content)

        # 策略文件
        for f in included:
            zf.write(f["src_path"], f"{pack_dir}/{f['zip_name']}")

    total_size = os.path.getsize(output)
    print(f"✅ 策略总包已打包：{output}")
    print(f"   包含文件：{len(included)}/{len(all_files)}")
    print(f"   总大小：{total_size:,} B")

    return 0


def main():
    parser = argparse.ArgumentParser(description="策略总包打包器")
    parser.add_argument("--brand", required=True, help="品牌名称")
    parser.add_argument("--workspace", required=True, help="工作目录路径")
    parser.add_argument("--output", required=True, help="输出 ZIP 路径")
    args = parser.parse_args()
    sys.exit(assemble_pack(args.brand, args.workspace, args.output))


if __name__ == "__main__":
    main()
