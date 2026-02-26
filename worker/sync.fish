#!/usr/bin/env fish

# S3 增量备份脚本
# 用法: s3_backup.fish [文件夹] [--bucket 桶名]
# 示例: s3_backup.fish /path/to/folder --bucket mybucket

# ============== 默认配置 ==============
set -l DEFAULT_BUCKET "anime23"
set -l DEFAULT_ENDPOINT "https://s3.us-east-005.backblazeb2.com"
set -l DEFAULT_REGION "us-east-005"

# 脚本内置默认值 (可被环境变量覆盖)
set -l S3_ACCESS_KEY "005ac767db79a860000000001"      # 设置你的 Access Key
set -l S3_SECRET_KEY "K0052ntvo5OCSiUBWVw9xWSJW0xVMvQ"      # 设置你的 Secret Key
set -l S3_ENDPOINT $DEFAULT_ENDPOINT
set -l S3_REGION $DEFAULT_REGION

# ============== 解析参数 ==============
set -l source_dir ""
set -l bucket_name $DEFAULT_BUCKET

# 解析位置参数和选项
for i in (seq 1 (count $argv))
    switch $argv[$i]
        case --bucket
            set i (math $i + 1)
            set bucket_name $argv[$i]
        case --help -h
            echo "用法: s3_backup.fish [文件夹] [--bucket 桶名]"
            echo ""
            echo "参数:"
            echo "  文件夹    要备份的文件夹路径 (默认: 当前目录)"
            echo "  --bucket  S3 桶名 (默认: $DEFAULT_BUCKET)"
            echo ""
            echo "环境变量 (优先级高于脚本内置配置):"
            echo "  AWS_ACCESS_KEY_ID     S3 Access Key"
            echo "  AWS_SECRET_ACCESS_KEY S3 Secret Key"
            echo "  AWS_ENDPOINT_URL      S3 Endpoint URL"
            echo "  AWS_REGION            S3 Region"
            exit 0
        case '*'
            if test -z "$source_dir"
                set source_dir $argv[$i]
            end
    end
end

# 默认使用当前目录
if test -z "$source_dir"
    set source_dir (pwd)
end

# 转换为绝对路径
set source_dir (realpath $source_dir)

# 检查源目录是否存在
if not test -d "$source_dir"
    echo "错误: 目录不存在: $source_dir"
    exit 1
end

# ============== 配置 S3 凭证 (环境变量优先) ==============
# AWS CLI 会自动读取这些环境变量
# 优先级: 环境变量 > 脚本内置默认值

if test -z "$AWS_ACCESS_KEY_ID"
    if test -n "$S3_ACCESS_KEY"
        set -gx AWS_ACCESS_KEY_ID $S3_ACCESS_KEY
    else
        echo "错误: 未设置 S3 Access Key"
        echo "请设置环境变量 AWS_ACCESS_KEY_ID 或在脚本中配置 S3_ACCESS_KEY"
        exit 1
    end
end

if test -z "$AWS_SECRET_ACCESS_KEY"
    if test -n "$S3_SECRET_KEY"
        set -gx AWS_SECRET_ACCESS_KEY $S3_SECRET_KEY
    else
        echo "错误: 未设置 S3 Secret Key"
        echo "请设置环境变量 AWS_SECRET_ACCESS_KEY 或在脚本中配置 S3_SECRET_KEY"
        exit 1
    end
end

if test -z "$AWS_ENDPOINT_URL"
    set -gx AWS_ENDPOINT_URL $S3_ENDPOINT
end

if test -z "$AWS_REGION"
    set -gx AWS_REGION $S3_REGION
end

# ============== 执行增量备份 ==============
# 获取文件夹名称作为 S3 路径前缀
set -l folder_name (basename $source_dir)
set -l s3_path "s3://$bucket_name/$folder_name"

echo "============================================"
echo "S3 增量备份"
echo "============================================"
echo "源目录: $source_dir"
echo "目标:   $s3_path"
echo "Endpoint: $AWS_ENDPOINT_URL"
echo "Region:   $AWS_REGION"
echo "============================================"
echo ""

# 使用 aws s3 sync 进行增量同步
# --delete: 删除目标中源目录不存在的文件
# --storage-class: 存储类别 (可选: STANDARD, REDUCED_REDUNDANCY, GLACIER 等)
aws s3 sync "$source_dir" "$s3_path" \
    --endpoint-url "$AWS_ENDPOINT_URL" \
    --region "$AWS_REGION"

set -l exit_status $status

if test $exit_status -eq 0
    echo ""
    echo "✓ 备份完成: $s3_path"
else
    echo ""
    echo "✗ 备份失败，退出码: $exit_status"
end

exit $exit_status