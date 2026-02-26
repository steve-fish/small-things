#!/usr/bin/env fish

function die
    echo "Error: $argv" >&2
    exit 1
end

# 用法:
# fish split_by_size.fish [--dry-run] <源目录> <输出目录> [每片GiB, 默认10]
set -l dry_run 0
set -l positional

for arg in $argv
    switch $arg
        case "--dry-run"
            set dry_run 1
        case "-*"
            echo "Usage: fish split_by_size.fish [--dry-run] <src_dir> <out_dir> [chunk_gib=10]" >&2
            die "未知参数: $arg"
        case "*"
            set positional $positional "$arg"
    end
end

if test (count $positional) -lt 2 -o (count $positional) -gt 3
    echo "Usage: fish split_by_size.fish [--dry-run] <src_dir> <out_dir> [chunk_gib=10]" >&2
    exit 1
end

set -l src "$positional[1]"
set -l out "$positional[2]"
set -l chunk_gib 10

if test (count $positional) -eq 3
    set chunk_gib "$positional[3]"
end

if not test -d "$src"
    die "源目录不存在: $src"
end

if not string match -rq '^[0-9]+$' -- "$chunk_gib"
    die "chunk_gib 必须是正整数"
end

set src (realpath -- "$src")

if test $dry_run -eq 0
    mkdir -p -- "$out"
end

set -l out_parent (dirname -- "$out")
if not test -d "$out_parent"
    die "输出目录的父目录不存在: $out_parent"
end

if test $dry_run -eq 1
    set out (realpath -m -- "$out")
else
    set out (realpath -- "$out")
end

# 避免输出目录位于源目录内部，导致遍历和移动互相干扰
if string match -q -- "$src/*" "$out"
    die "输出目录不能位于源目录内部: $out"
end

set -l chunk_bytes (math --scale=0 "$chunk_gib * 1024 * 1024 * 1024")

set -l part_idx 1
set -l part_bytes 0
set -l part_dir "$out/part_"(printf "%03d" $part_idx)
if test $dry_run -eq 0
    mkdir -p -- "$part_dir"
end

set -l src_re (string escape --style=regex -- "$src")

echo "Source: $src"
echo "Output: $out"
echo "Chunk:  $chunk_gib GiB ($chunk_bytes bytes)"
if test $dry_run -eq 1
    echo "Mode:   dry-run (no changes)"
else
    echo "Mode:   move"
end
echo "Start splitting..."

# 用 NUL 分隔，兼容空格等特殊字符
find "$src" -type f -print0 | sort -z | while read -lz abs
    set -l rel (string replace -r "^$src_re/" "" -- "$abs")
    set -l size (stat -c '%s' -- "$abs")

    # 当前分片放不下时开新分片（当前分片非空时）
    set -l next_bytes (math --scale=0 "$part_bytes + $size")
    if test $part_bytes -gt 0; and test $next_bytes -gt $chunk_bytes
        set part_idx (math --scale=0 "$part_idx + 1")
        set part_bytes 0
        set part_dir "$out/part_"(printf "%03d" $part_idx)
        if test $dry_run -eq 0
            mkdir -p -- "$part_dir"
        end
        set next_bytes $size
    end

    if test $size -gt $chunk_bytes
        echo "WARN: 单文件超过阈值，仍放入单个分片: $rel" >&2
    end

    set -l dst "$part_dir/$rel"

    if test $dry_run -eq 1
        echo "$abs -> $dst"
    else
        mkdir -p -- (dirname -- "$dst")
        mv -- "$abs" "$dst"
    end

    set part_bytes $next_bytes
end

echo "Done."
echo "Parts are under: $out/part_001, part_002, ..."
