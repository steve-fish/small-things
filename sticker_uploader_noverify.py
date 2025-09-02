
import os
import requests
import json
import getpass
import mimetypes
import urllib3

# 禁用 InsecureRequestWarning
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def upload_sticker(homeserver, token, file_path, filename, verify_ssl):
    """Uploads a single sticker file to the homeserver."""
    print(f"正在上传 {filename}...")
    
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": mimetypes.guess_type(file_path)[0] or "application/octet-stream"
    }
    
    with open(file_path, "rb") as f:
        data = f.read()

    upload_url = f"{homeserver}/_matrix/media/v3/upload?filename={filename}"
    
    try:
        response = requests.post(upload_url, headers=headers, data=data, timeout=30, verify=verify_ssl)
        response.raise_for_status()
        return response.json()["content_uri"]
    except requests.exceptions.RequestException as e:
        print(f"  上传失败: {e}")
        if e.response is not None:
            print(f"  服务器响应: {e.response.text}")
        return None

def get_current_sticker_pack(homeserver, token, room_id, verify_ssl):
    """Fetches the current sticker pack state from the room."""
    print("正在获取当前表情包状态...")
    state_url = f"{homeserver}/_matrix/client/v3/rooms/{room_id}/state/im.ponies.room_emotes"
    headers = {"Authorization": f"Bearer {token}"}
    
    try:
        response = requests.get(state_url, headers=headers, timeout=30, verify=verify_ssl)
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

def update_sticker_pack(homeserver, token, room_id, new_state, verify_ssl):
    """Updates the sticker pack state in the room."""
    print("正在更新房间内的表情包...")
    update_url = f"{homeserver}/_matrix/client/v3/rooms/{room_id}/state/im.ponies.room_emotes"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    try:
        response = requests.put(update_url, headers=headers, json=new_state, timeout=30, verify=verify_ssl)
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

    disable_ssl_verification = input("是否要禁用 SSL 验证进行诊断? (yes/no) [no]: ").strip().lower()
    verify_ssl = False if disable_ssl_verification == 'yes' else True
    
    if not verify_ssl:
        print("\n警告: 正在禁用 SSL 验证。这仅应用于诊断目的。\n")

    # --- 输入验证 ---
    if not all([homeserver, room_id, token, folder_path]):
        print("错误：所有字段都是必填的。")
        return
        
    if not os.path.isdir(folder_path):
        print(f"错误：找不到文件夹 '{folder_path}'。请检查路径是否正确。")
        return

    # --- 核心逻辑 ---
    sticker_pack_state = get_current_sticker_pack(homeserver, token, room_id, verify_ssl)
    if sticker_pack_state is None:
        return # 如果获取失败则退出

    update_count = 0
    for filename in os.listdir(folder_path):
        file_path = os.path.join(folder_path, filename)
        if os.path.isfile(file_path):
            shortcode = os.path.splitext(filename)[0]
            
            if shortcode in sticker_pack_state.get("images", {}):
                print(f"表情 '{shortcode}' 已存在，跳过。")
                continue

            mxc_uri = upload_sticker(homeserver, token, file_path, filename, verify_ssl)
            
            if mxc_uri:
                update_count += 1
                file_size = os.path.getsize(file_path)
                mime_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
                
                sticker_pack_state["images"][shortcode] = {
                    "url": mxc_uri,
                    "info": {
                        "mimetype": mime_type,
                        "size": file_size
                    }
                }

    if update_count > 0:
        update_sticker_pack(homeserver, token, room_id, sticker_pack_state, verify_ssl)
    else:
        print("没有新的表情需要上传。")

if __name__ == "__main__":
    main()
