import requests
import json

# 全局变量
current_conversation_id = None
USE_STREAMING = False # 默认不使用流式
# bearer_token 会在 main 函数中定义

def call_ai_hub_api_streaming(query_text, auth_token, conv_id_to_use):
    """
    以流式模式调用 AI Hub API，并管理 conversation_id。
    实时打印事件，并返回从响应中获取的 conversation_id 和完整的消息。
    """
    global current_conversation_id # 允许函数修改全局对话ID

    url = 'https://aihub.scnu.edu.cn/api/chat-messages'
    headers = {
        'accept': '*/*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'authorization': f'Bearer {auth_token}',
        'cache-control': 'no-cache',
        'content-type': 'application/json',
        'dnt': '1',
        'origin': 'https://aihub.scnu.edu.cn',
        'pragma': 'no-cache',
        'priority': 'u=1, i',
        'referer': 'https://aihub.scnu.edu.cn/',
        'sec-ch-ua': '"Chromium";v="136", "Microsoft Edge";v="136", "Not.A/Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0'
    }
    request_payload_conv_id = conv_id_to_use if conv_id_to_use else ""
    data_payload = {
        "response_mode": "streaming",
        "conversation_id": request_payload_conv_id,
        "files": [],
        "query": query_text,
        "inputs": {},
        "parent_message_id": None
    }

    accumulated_answer_chunks = []
    stream_derived_conversation_id = None 
    response_message_id = None 

    print("\n--- Streaming Response ---")
    try:
        with requests.post(url, headers=headers, json=data_payload, stream=True, timeout=120) as response: 
            response.raise_for_status()
            for line_bytes in response.iter_lines():
                if line_bytes:
                    line_str = line_bytes.decode('utf-8')
                    if line_str == 'event: ping':
                        continue
                    if line_str.startswith('data: '):
                        json_payload_str = line_str[len('data: '):]
                        if not json_payload_str: continue
                        try:
                            event = json.loads(json_payload_str)
                            event_type = event.get("event")

                            if "conversation_id" in event and event["conversation_id"]:
                                if not stream_derived_conversation_id: 
                                    stream_derived_conversation_id = event["conversation_id"]
                                if not request_payload_conv_id and stream_derived_conversation_id:
                                    print(f"[System Info] New conversation started with ID: {stream_derived_conversation_id}")
                                    current_conversation_id = stream_derived_conversation_id 
                            
                            if "message_id" in event and event["message_id"]:
                                response_message_id = event["message_id"]

                            if event_type == "agent_thought":
                                thought_content = event.get("data", {}).get("thought", "")
                                if thought_content:
                                    if accumulated_answer_chunks: print() 
                                    print(f"<THINKING>\n{thought_content.strip()}\n</THINKING>", flush=True)
                            elif event_type == "message_chunk":
                                chunk_text = event.get("data", {}).get("text", "")
                                if chunk_text:
                                    print(chunk_text, end='', flush=True)
                                    accumulated_answer_chunks.append(chunk_text)
                            elif event_type == "message":
                                answer_from_message_event = event.get("answer")
                                if answer_from_message_event and not accumulated_answer_chunks:
                                    print(answer_from_message_event, end='', flush=True)
                                    accumulated_answer_chunks.append(answer_from_message_event)
                                elif not accumulated_answer_chunks:
                                    print(flush=True)
                            elif event_type == "message_end":
                                print("\n--- Stream Ended ---")
                                usage_info = event.get("metadata", {}).get("usage", {})
                                if usage_info: print(f"[Usage Info] {usage_info}")
                                break 
                            elif event_type == "error":
                                error_details = event.get("data", event) 
                                print(f"\n[API Error] Code: {error_details.get('code')}, Message: {error_details.get('message')}, Status: {error_details.get('status')}")
                                break 
                        except json.JSONDecodeError:
                            print(f"\n[System Error] Failed to parse JSON: '{json_payload_str}'")
                        except Exception as e:
                            print(f"\n[System Error] Error processing event: {e}\nProblematic data: {json_payload_str}")
                    elif line_str: 
                        print(f"DEBUG UNEXPECTED LINE: {line_str}")
            if accumulated_answer_chunks: print(flush=True)
            final_returned_conv_id = stream_derived_conversation_id if stream_derived_conversation_id else conv_id_to_use
            return final_returned_conv_id, "".join(accumulated_answer_chunks), response_message_id
    except requests.exceptions.HTTPError as http_err:
        print(f"HTTP error occurred: {http_err}")
        if 'response' in locals() and response and response.text: print(f"Response content: {response.text}")
    except requests.exceptions.RequestException as req_err:
        print(f"Request error occurred: {req_err}")
    return conv_id_to_use, "".join(accumulated_answer_chunks), None


def call_ai_hub_api_blocking(query_text, auth_token, conv_id_to_use):
    """
    以阻塞模式调用 AI Hub API，并管理 conversation_id。
    打印完整的消息，并返回从响应中获取的 conversation_id 和消息。
    """
    global current_conversation_id

    url = 'https://aihub.scnu.edu.cn/api/chat-messages'
    headers = {
        'accept': 'application/json', # Expecting a JSON response
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'authorization': f'Bearer {auth_token}',
        'content-type': 'application/json',
        'dnt': '1',
        'origin': 'https://aihub.scnu.edu.cn',
        'priority': 'u=1, i',
        'referer': 'https://aihub.scnu.edu.cn/',
        'sec-ch-ua': '"Chromium";v="136", "Microsoft Edge";v="136", "Not.A/Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0'
    }

    request_payload_conv_id = conv_id_to_use if conv_id_to_use else ""
    data_payload = {
        "response_mode": "blocking", # Key change for non-streaming
        "conversation_id": request_payload_conv_id,
        "files": [],
        "query": query_text,
        "inputs": {},
        "parent_message_id": None
    }

    full_answer = ""
    returned_conv_id = conv_id_to_use 
    response_message_id = None

    print("\n--- Blocking Response ---")
    try:
        response = requests.post(url, headers=headers, json=data_payload, timeout=120)
        response.raise_for_status() 

        json_response = response.json()

        # Check for API-specific error structure (e.g., from Dify)
        if json_response.get("event") == "error": # Matches streaming error event type
            error_data = json_response.get("data", json_response)
            print(f"\n[API Error] Code: {error_data.get('code')}, Message: {error_data.get('message')}, Status: {error_data.get('status')}")
            return returned_conv_id, "", None
        # Dify might also return error details directly in blocking mode with a 200 OK but an error in JSON
        elif "code" in json_response and "message" in json_response and (response.status_code == 200 or response.status_code >=400) :
            # Check if 'answer' is missing, indicating it's likely an error payload
            if "answer" not in json_response:
                print(f"\n[API Error] Code: {json_response.get('code')}, Message: {json_response.get('message')}")
                return returned_conv_id, "", None
        
        full_answer = json_response.get("answer", "")
        returned_conv_id = json_response.get("conversation_id", returned_conv_id)
        response_message_id = json_response.get("id") # Dify uses "id" for message_id

        if not request_payload_conv_id and returned_conv_id and returned_conv_id != request_payload_conv_id:
            print(f"[System Info] New conversation started with ID: {returned_conv_id}")
            current_conversation_id = returned_conv_id
        
        agent_thoughts = json_response.get("agent_thoughts") # Dify might include this
        if agent_thoughts and isinstance(agent_thoughts, list):
            for thought_item in agent_thoughts:
                if isinstance(thought_item, dict) and "thought" in thought_item:
                     print(f"<THINKING>\n{thought_item['thought'].strip()}\n</THINKING>", flush=True)
                elif isinstance(thought_item, str):
                     print(f"<THINKING>\n{thought_item.strip()}\n</THINKING>", flush=True)
        
        print("\n<AI Response>")
        print(full_answer.strip())
        print("</AI Response>\n")

        usage_info = json_response.get("metadata", {}).get("usage", {})
        if usage_info:
            print(f"[Usage Info] {usage_info}")
        
        print("--- Request End ---")

    except requests.exceptions.HTTPError as http_err:
        print(f"HTTP error occurred: {http_err}")
        if response and response.text: 
            print(f"Response content: {response.text}")
            try:
                error_json = response.json()
                if "message" in error_json: print(f"API Error Message: {error_json['message']}")
            except json.JSONDecodeError: pass
        return conv_id_to_use, "", None
    except requests.exceptions.RequestException as req_err:
        print(f"Request error occurred: {req_err}")
        return conv_id_to_use, "", None
    except json.JSONDecodeError:
        print(f"\n[System Error] Failed to parse JSON response from blocking API.")
        if response and response.text: print(f"Response content: {response.text}")
        return conv_id_to_use, "", None

    return returned_conv_id, full_answer, response_message_id


def delete_conversation_on_server(conv_id_to_delete, auth_token):
    """
    向服务器发送 DELETE 请求以删除指定的对话。
    """
    if not conv_id_to_delete:
        print("[System Info] No active conversation ID to delete.")
        return False

    url = f'https://aihub.scnu.edu.cn/api/conversations/{conv_id_to_delete}'
    headers = {
        'accept': '*/*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'authorization': f'Bearer {auth_token}',
        'content-type': 'application/json',
        'dnt': '1',
        'origin': 'https://aihub.scnu.edu.cn',
        'priority': 'u=1, i',
        'referer': f'https://aihub.scnu.edu.cn/chat/{conv_id_to_delete}',
        'sec-ch-ua': '"Chromium";v="136", "Microsoft Edge";v="136", "Not.A/Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0'
    }

    print(f"\nAttempting to delete conversation {conv_id_to_delete} from server...")
    try:
        response = requests.delete(url, headers=headers, timeout=30)
        response.raise_for_status()
        if response.status_code == 200 or response.status_code == 204:
            print(f"[System Info] Conversation {conv_id_to_delete} deleted successfully from server (Status: {response.status_code}).")
            return True
        else:
            print(f"[System Error] Unexpected success status code: {response.status_code} while deleting conversation.")
            print(f"Response content: {response.text}")
            return False
    except requests.exceptions.HTTPError as http_err:
        print(f"HTTP error occurred while deleting conversation: {http_err}")
        if 'response' in locals() and response and response.text: print(f"Response content: {response.text}")
        return False
    except requests.exceptions.RequestException as req_err:
        print(f"Request error occurred while deleting conversation: {req_err}")
        return False


if __name__ == "__main__":
    bearer_token = "" # 请替换为你的有效Token 通过网页抓包获取，应该有效期不长…… （P.S. 网页后端是dify……
    
    print("AI Hub API Interactive Client")
    print("--------------------------------------------------------------------")
    print("Commands:")
    print("  Type your query and press Enter.")
    print("  /new         - Start a new conversation.")
    print("  /delete      - Delete current conversation from server and locally.")
    print("  /show_id     - Display current conversation ID.")
    print("  /stream_on   - Enable streaming mode for responses.")
    print("  /stream_off  - Disable streaming mode (blocking responses). (Default)")
    print("  /exit or /quit - Stop the client.")
    print("--------------------------------------------------------------------")

    while True:
        prompt_conv_id_display = current_conversation_id[:8] if current_conversation_id else "New Conv"
        mode_display = "Stream" if USE_STREAMING else "Block"
        user_input = input(f"[{prompt_conv_id_display}][{mode_display}] Your query: ")
        
        if user_input.lower() in ['/exit', '/quit']:
            print("Exiting client...")
            break
        
        if user_input.lower() == '/new':
            current_conversation_id = None
            print("Conversation reset. Starting a new conversation.")
            print("--------------------------------------------------------------------")
            continue

        if user_input.lower() == '/delete':
            if current_conversation_id:
                confirm = input(f"Are you sure you want to delete conversation {current_conversation_id} from the server? This cannot be undone. (yes/no): ")
                if confirm.lower() == 'yes':
                    if delete_conversation_on_server(current_conversation_id, bearer_token):
                        print(f"[System Info] Local reference to conversation {current_conversation_id} cleared.")
                        current_conversation_id = None
                    else:
                        print(f"[System Error] Failed to delete conversation {current_conversation_id} from server.")
                else:
                    print("Deletion cancelled.")
            else:
                print("No active conversation to delete.")
            print("--------------------------------------------------------------------")
            continue

        if user_input.lower() == '/show_id':
            if current_conversation_id:
                print(f"Current Conversation ID: {current_conversation_id}")
            else:
                print("No active conversation. A new one will be started on your next query.")
            print("--------------------------------------------------------------------")
            continue
        
        if user_input.lower() == '/stream_on':
            USE_STREAMING = True
            print("Streaming mode ENABLED.")
            print("--------------------------------------------------------------------")
            continue

        if user_input.lower() == '/stream_off':
            USE_STREAMING = False
            print("Streaming mode DISABLED (blocking responses).")
            print("--------------------------------------------------------------------")
            continue
            
        if not user_input.strip():
            print("Query cannot be empty. Please try again.")
            continue

        user_query = user_input 
        print(f"\nSending query: '{user_query}' (Mode: {'Streaming' if USE_STREAMING else 'Blocking'})...")
        
        returned_conv_id = None
        full_answer_text = "" # To store the complete answer text for potential future use
        ai_message_id = None

        if USE_STREAMING:
            returned_conv_id, full_answer_text, ai_message_id = call_ai_hub_api_streaming(
                user_query, 
                bearer_token, 
                current_conversation_id 
            )
        else:
            returned_conv_id, full_answer_text, ai_message_id = call_ai_hub_api_blocking(
                user_query,
                bearer_token,
                current_conversation_id
            )
        
        if returned_conv_id: 
            current_conversation_id = returned_conv_id # Ensure global ID is updated from function's return
            
        print("\n--------------------------------------------------------------------")
