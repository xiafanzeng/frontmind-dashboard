#!/usr/bin/env python3
"""
FrontMind E3 跨文章图片去重检查器 (Image Dedup Checker)

功能：
  - 计算图片的 SHA256 哈希值
  - 计算图片的感知哈希（pHash）用于视觉相似度比对
  - 与图片注册表中的已有图片进行相似度比对
  - 输出去重检查报告

用法：
  python3 image_dedup_checker.py \\
    --image "path/to/new_image.png" \\
    --registry "path/to/E0_{brand}_image_registry.json" \\
    --threshold 0.85 \\
    --output "dedup_report.json"

依赖：
  pip3 install Pillow
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime
from typing import Dict, List, Tuple

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    print("警告: Pillow 未安装，将仅使用 SHA256 哈希进行去重", file=sys.stderr)


def compute_sha256(file_path: str) -> str:
    """
    计算文件的 SHA256 哈希值。
    
    Args:
        file_path: 图片文件路径
    
    Returns:
        SHA256 哈希字符串（十六进制）
    """
    sha256_hash = hashlib.sha256()
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            sha256_hash.update(chunk)
    return sha256_hash.hexdigest()


def compute_phash(file_path: str, hash_size: int = 16) -> str:
    """
    计算图片的感知哈希（pHash）。
    
    使用 DCT（离散余弦变换）方法计算感知哈希，
    对图片的缩放、压缩等变换具有鲁棒性。
    
    Args:
        file_path: 图片文件路径
        hash_size: 哈希大小（默认 16，产生 256 位哈希）
    
    Returns:
        感知哈希字符串（十六进制）
    """
    if not HAS_PIL:
        return ""
    
    try:
        img = Image.open(file_path)
        # 转为灰度图并缩放
        img = img.convert('L').resize((hash_size + 1, hash_size), Image.LANCZOS)
        
        pixels = list(img.getdata())
        width = hash_size + 1
        
        # 计算差异哈希（dHash）
        diff = []
        for row in range(hash_size):
            for col in range(hash_size):
                left = pixels[row * width + col]
                right = pixels[row * width + col + 1]
                diff.append(1 if left > right else 0)
        
        # 转为十六进制字符串
        hash_value = 0
        for bit in diff:
            hash_value = (hash_value << 1) | bit
        
        return format(hash_value, f'0{hash_size * hash_size // 4}x')
    
    except Exception as e:
        print(f"警告: 无法计算感知哈希: {e}", file=sys.stderr)
        return ""


def compute_hamming_distance(hash1: str, hash2: str) -> float:
    """
    计算两个哈希值之间的汉明距离（归一化为相似度）。
    
    Args:
        hash1: 第一个哈希值
        hash2: 第二个哈希值
    
    Returns:
        相似度（0.0-1.0，1.0 表示完全相同）
    """
    if not hash1 or not hash2:
        return 0.0
    
    if len(hash1) != len(hash2):
        return 0.0
    
    # 转为二进制比较
    try:
        int1 = int(hash1, 16)
        int2 = int(hash2, 16)
        xor = int1 ^ int2
        diff_bits = bin(xor).count('1')
        total_bits = len(hash1) * 4
        similarity = 1.0 - (diff_bits / total_bits)
        return similarity
    except ValueError:
        return 0.0


def check_file_size(file_path: str, min_kb: int = 10) -> Tuple[bool, float]:
    """
    检查图片文件大小是否达标。
    
    Args:
        file_path: 图片文件路径
        min_kb: 最小文件大小（KB）
    
    Returns:
        (是否通过, 实际大小 KB)
    """
    size_bytes = os.path.getsize(file_path)
    size_kb = size_bytes / 1024
    return size_kb >= min_kb, round(size_kb, 2)


def check_against_registry(image_path: str, registry_path: str,
                           threshold: float = 0.85) -> Dict:
    """
    将新图片与注册表中的已有图片进行去重比对。
    
    Args:
        image_path: 新图片路径
        registry_path: 图片注册表 JSON 路径
        threshold: 相似度阈值（≥ 此值则判定为重复）
    
    Returns:
        去重检查结果字典
    """
    result = {
        "image_path": image_path,
        "sha256": compute_sha256(image_path),
        "phash": compute_phash(image_path),
        "passed": True,
        "max_similarity": 0.0,
        "most_similar_entry": None,
        "exact_match": False,
        "checked_count": 0,
    }
    
    # 检查注册表是否存在
    if not os.path.exists(registry_path):
        result["note"] = "注册表不存在，首张图片自动通过"
        return result
    
    try:
        with open(registry_path, 'r', encoding='utf-8') as f:
            registry = json.load(f)
    except (json.JSONDecodeError, IOError):
        result["note"] = "注册表读取失败，自动通过"
        return result
    
    entries = registry.get("images", [])
    result["checked_count"] = len(entries)
    
    for entry in entries:
        # SHA256 完全匹配检查
        if entry.get("sha256") == result["sha256"]:
            result["passed"] = False
            result["exact_match"] = True
            result["max_similarity"] = 1.0
            result["most_similar_entry"] = {
                "article_id": entry.get("article_id"),
                "fig_id": entry.get("fig_id"),
            }
            break
        
        # 感知哈希相似度检查
        existing_phash = entry.get("phash", "")
        if existing_phash and result["phash"]:
            similarity = compute_hamming_distance(result["phash"], existing_phash)
            if similarity > result["max_similarity"]:
                result["max_similarity"] = similarity
                result["most_similar_entry"] = {
                    "article_id": entry.get("article_id"),
                    "fig_id": entry.get("fig_id"),
                    "similarity": round(similarity, 4),
                }
    
    # 判定是否通过
    if result["max_similarity"] >= threshold:
        result["passed"] = False
    
    return result


def register_image(registry_path: str, image_info: Dict) -> None:
    """
    将通过去重检查的图片注册到注册表。
    
    Args:
        registry_path: 注册表路径
        image_info: 图片信息字典
    """
    if os.path.exists(registry_path):
        with open(registry_path, 'r', encoding='utf-8') as f:
            registry = json.load(f)
    else:
        registry = {"images": [], "created_at": datetime.now().isoformat()}
    
    image_info["registered_at"] = datetime.now().isoformat()
    registry["images"].append(image_info)
    registry["updated_at"] = datetime.now().isoformat()
    
    with open(registry_path, 'w', encoding='utf-8') as f:
        json.dump(registry, f, ensure_ascii=False, indent=2)


def main():
    parser = argparse.ArgumentParser(description="FrontMind E3 跨文章图片去重检查器")
    parser.add_argument("--image", required=True, help="待检查的图片路径")
    parser.add_argument("--registry", required=True, help="图片注册表 JSON 路径")
    parser.add_argument("--threshold", type=float, default=0.85, help="相似度阈值")
    parser.add_argument("--output", default=None, help="输出报告路径（JSON）")
    parser.add_argument("--register", action="store_true", help="通过检查后自动注册")
    parser.add_argument("--article-id", default="", help="文章编号")
    parser.add_argument("--fig-id", default="", help="图片编号")
    
    args = parser.parse_args()
    
    if not os.path.exists(args.image):
        print(f"错误: 图片文件不存在: {args.image}", file=sys.stderr)
        sys.exit(1)
    
    # 文件大小检查
    size_pass, size_kb = check_file_size(args.image)
    if not size_pass:
        print(f"❌ 文件大小不达标: {size_kb} KB < 10 KB", file=sys.stderr)
        sys.exit(1)
    
    # 去重检查
    result = check_against_registry(args.image, args.registry, args.threshold)
    result["file_size_kb"] = size_kb
    
    # 输出结果
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    
    if result["passed"]:
        print(f"✅ 去重检查通过 (最大相似度: {result['max_similarity']:.4f})")
        
        # 自动注册
        if args.register:
            register_image(args.registry, {
                "article_id": args.article_id,
                "fig_id": args.fig_id,
                "sha256": result["sha256"],
                "phash": result["phash"],
                "path": args.image,
                "file_size_kb": size_kb,
            })
            print(f"  已注册到注册表: {args.registry}")
    else:
        reason = "完全相同" if result["exact_match"] else f"相似度过高 ({result['max_similarity']:.4f})"
        print(f"❌ 去重检查未通过: {reason}", file=sys.stderr)
        if result["most_similar_entry"]:
            entry = result["most_similar_entry"]
            print(f"  最相似图片: {entry.get('article_id', '?')}/{entry.get('fig_id', '?')}")
        sys.exit(1)


if __name__ == "__main__":
    main()
