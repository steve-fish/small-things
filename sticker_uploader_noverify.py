import os
import requests
import json
import getpass
import mimetypes

# 根据用户提供的列表，创建一个自定义的MIME类型映射作为备用
CUSTOM_MIME_TYPES = {
    '.aac': 'audio/aac',
    '.apng': 'image/apng',
    '.avif': 'image/avif',
    '.avi': 'video/x-msvideo',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.htm': 'text/html',
    '.html': 'text/html',
    '.ico': 'image/vnd.microsoft.icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.mpeg': 'video/mpeg',
    '.oga': 'audio/ogg',
    '.ogv': 'video/ogg',
    '.ogx': 'application/ogg',
    '.opus': 'audio/opus',
    '.otf': 'font/otf',
    '.png': 'image/png',
    '.pdf': 'application/pdf',
    '.svg': 'image/svg+xml',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.ts': 'video/mp2t',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain',
    '.wav': 'audio/wav',
    '.weba': 'audio/webm',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.xml': 'application/xml',
}

def get_mime_type(file_path):
    """更可靠地获取文件的MIME类型."""
    # 首先尝试标准库
    mime_type, _ = mimetypes.guess_type(file_path)
    if mime_type:
        return mime_type
    
    # 如果标准库失败，使用自定义的映射
    ext = os.path.splitext(file_path)[1].lower()
    return CUSTOM_MIME_TYPES.get(ext, 'application/octet-stream')

def upload_sticker(homeserver, token, file_path, filename):
    """Uploads a single sticker file to the homeserver."""
    print(f"正在上传 {filename}...")
    
    mime_type = get_mime_type(file_path)
    print(f"  -> 检测到MIME类型: {mime_type}")

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": mime_type
    }
    
    with open(file_path, "rb") as f:
        data = f.read()

    upload_url = f"{homeserver}/_matrix/media/v3/upload?filename={filename}"
    
    try:
        response = requests.post(upload_url, headers=headers, data=data, timeout=30)
        response.raise_for_status()
        return response.json()["content_uri"]
    except requests.exceptions.RequestException as e:
        print(f"  上传失败: {e}")
        if e.response is not None:
            print(f"  服务器响应: {e.response.text}")
        return None

def get_current_sticker_pack(homeserver, token, room_id):
    """Fetches the current sticker pack state from the room."""
    print("正在获取当前表情包状态...")
    state_url = f"{homeserver}/_matrix/client/v3/rooms/{room_id}/state/im.ponies.room_emotes"
    headers = {"Authorization": f"Bearer {token}"}
    
    try:
        response = requests.get(state_url, headers=headers, timeout=30)
        if response.status_code == 404:
            print("  未找到现有表情包，将创建一个新的。")
            return {"images": {}, "pack": {}}
        response.raise_for_status()
        print("  成功获取现有表情包。")
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"  获取表情包状态失败: {e}")
        if e.response is not None:
            print(f"  服务器响应: {e.response.text}")
        return None

def update_sticker_pack(homeserver, token, room_id, new_state):
    """Updates the sticker pack state in the room."""
    print("正在更新房间内的表情包...")
    update_url = f"{homeserver}/_matrix/client/v3/rooms/{room_id}/state/im.ponies.room_emotes"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    try:
        response = requests.put(update_url, headers=headers, json=new_state, timeout=30)
        response.raise_for_status()
        print("  表情包更新成功！")
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"  更新失败: {e}")
        if e.response is not None:
            print(f"  服务器响应: {e.response.text}")
        return None

def main():
    """Main function to run the CLI tool."""
    print("--- FluffyChat 贴纸上传工具 ---")
    
    # --- 交互式获取输入 ---
    homeserver = input("请输入你的 Homeserver URL (例如: https://matrix.org): ").strip()
    room_id = input("请输入要添加表情的房间 ID: ").strip()
    folder_path = input("请输入包含表情图片的文件夹绝对路径: ").strip()
    
    try:
        token = getpass.getpass("请输入你的 Matrix Access Token (输入时不可见): ").strip()
    except Exception as error:
        print(f"错误：无法读取访问令牌 - {error}")
        return

    # --- 输入验证 ---
    if not all([homeserver, room_id, token, folder_path]):
        print("错误：所有字段都是必填的。")
        return
        
    if not os.path.isdir(folder_path):
        print(f"错误：找不到文件夹 '{folder_path}'。请检查路径是否正确。")
        return

    # --- 核心逻辑 ---
    sticker_pack_state = get_current_sticker_pack(homeserver, token, room_id)
    if sticker_pack_state is None:
        return

    update_count = 0
    for filename in sorted(os.listdir(folder_path)):
        file_path = os.path.join(folder_path, filename)
        if os.path.isfile(file_path):
            shortcode = os.path.splitext(filename)[0]
            
            if shortcode in sticker_pack_state.get("images", {}):
                print(f"表情 '{shortcode}' 已存在，跳过。")
                continue

            mxc_uri = upload_sticker(homeserver, token, file_path, filename)
            
            if mxc_uri:
                update_count += 1
                file_size = os.path.getsize(file_path)
                mime_type = get_mime_type(file_path)
                
                sticker_pack_state["images"][shortcode] = {
                    "url": mxc_uri,
                    "info": {
                        "mimetype": mime_type,
                        "size": file_size
                    }
                }

    if update_count > 0:
        update_sticker_pack(homeserver, token, room_id, sticker_pack_state)
    else:
        print("没有新的表情需要上传或更新。")

if __name__ == "__main__":
    main()
