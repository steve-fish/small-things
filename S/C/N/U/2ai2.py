import requests
import json
import time
import uuid
import os
from typing import List, Optional, Dict, Any, Union, Generator

# FastAPI and Pydantic
from fastapi import FastAPI, Request, HTTPException, Header
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field
import uvicorn

# --- Pydantic Models for OpenAI Compatibility ---

class ChatMessageInput(BaseModel):
    role: str
    content: str

class ChatCompletionsRequest(BaseModel):
    model: Optional[str] = "scnu-aihub-model" # Model name, can be placeholder
    messages: List[ChatMessageInput]
    stream: Optional[bool] = False
    # We can add other OpenAI params like temperature, max_tokens if SCNU API supports them
    # For now, they are ignored.

    # Custom SCNU parameters (not part of OpenAI spec, but useful for passthrough)
    # conversation_id: Optional[str] = None # Alternative to X-SCNU-Conversation-ID header

class ChoiceDelta(BaseModel):
    content: Optional[str] = None
    role: Optional[str] = None

class StreamingChoice(BaseModel):
    index: int
    delta: ChoiceDelta
    finish_reason: Optional[str] = None

class ChatCompletionChunk(BaseModel):
    id: str = Field(default_factory=lambda: f"chatcmpl-{uuid.uuid4().hex}")
    object: str = "chat.completion.chunk"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str
    choices: List[StreamingChoice]
    # Dify/SCNU specific usage information might be added here if needed in the stream
    # For OpenAI compatibility, usage is typically not in chunks or only in the last one.

class MessageOutput(BaseModel):
    role: str
    content: str

class BlockingChoice(BaseModel):
    index: int
    message: MessageOutput
    finish_reason: str = "stop"

class UsageInfo(BaseModel):
    prompt_tokens: int = 0 # Placeholder, SCNU usage may differ
    completion_tokens: int = 0 # Placeholder
    total_tokens: int = 0 # Placeholder

class ChatCompletionResponse(BaseModel):
    id: str = Field(default_factory=lambda: f"chatcmpl-{uuid.uuid4().hex}")
    object: str = "chat.completion"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str
    choices: List[BlockingChoice]
    usage: Optional[UsageInfo] = None
    # Custom SCNU output
    # scnu_conversation_id: Optional[str] = None # Can be put in headers instead


# --- Refactored SCNU API Client Functions ---
# These functions are modified to return data instead of printing,
# and to be more suitable for use in an API.

def call_ai_hub_api_streaming_adapter(
    query_text: str, 
    auth_token: str, 
    conv_id_to_use: Optional[str]
) -> Generator[Dict[str, Any], None, None]:
    """
    Calls AI Hub API in streaming mode, yielding events.
    Events:
    - {"type": "id_update", "conversation_id": str, "message_id": str}
    - {"type": "thought", "content": str}
    - {"type": "chunk", "text": str}
    - {"type": "error", "code": int, "message": str, "status": str}
    - {"type": "final_answer", "text": str} # If full answer is sent in a 'message' event
    - {"type": "end", "usage": dict, "conversation_id": str, "message_id": str}
    """
    url = 'https://aihub.scnu.edu.cn/api/chat-messages'
    headers = {
        'accept': '*/*', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'authorization': f'Bearer {auth_token}', 'cache-control': 'no-cache',
        'content-type': 'application/json', 'dnt': '1', 'origin': 'https://aihub.scnu.edu.cn',
        'pragma': 'no-cache', 'priority': 'u=1, i', 'referer': 'https://aihub.scnu.edu.cn/',
        'sec-ch-ua': '"Chromium";v="136", "Microsoft Edge";v="136", "Not.A/Brand";v="99"',
        'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0'
    }
    request_payload_conv_id = conv_id_to_use if conv_id_to_use else ""
    data_payload = {
        "response_mode": "streaming", "conversation_id": request_payload_conv_id,
        "files": [], "query": query_text, "inputs": {}, "parent_message_id": None
    }

    stream_derived_conversation_id = None
    response_message_id = None
    accumulated_answer_chunks = [] # To form full answer if needed by caller

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

                            # Capture conversation_id and message_id as soon as available
                            new_conv_id = event.get("conversation_id")
                            new_msg_id = event.get("message_id")
                            ids_updated = False
                            if new_conv_id and not stream_derived_conversation_id:
                                stream_derived_conversation_id = new_conv_id
                                ids_updated = True
                            if new_msg_id and not response_message_id:
                                response_message_id = new_msg_id
                                ids_updated = True
                            
                            if ids_updated and stream_derived_conversation_id and response_message_id:
                                yield {"type": "id_update", 
                                       "conversation_id": stream_derived_conversation_id,
                                       "message_id": response_message_id}
                                
                            if event_type == "agent_thought":
                                thought_content = event.get("data", {}).get("thought", "")
                                if thought_content:
                                    yield {"type": "thought", "content": thought_content.strip()}
                            elif event_type == "message_chunk":
                                chunk_text = event.get("data", {}).get("text", "")
                                if chunk_text:
                                    accumulated_answer_chunks.append(chunk_text)
                                    yield {"type": "chunk", "text": chunk_text}
                            elif event_type == "message": # Dify might send full message if not chunking well
                                answer_from_message_event = event.get("answer")
                                if answer_from_message_event:
                                    accumulated_answer_chunks.append(answer_from_message_event)
                                    yield {"type": "final_answer", "text": answer_from_message_event}
                            elif event_type == "message_end":
                                usage_info = event.get("metadata", {}).get("usage", {})
                                final_conv_id = stream_derived_conversation_id or conv_id_to_use or "" # Ensure we have one
                                yield {"type": "end", 
                                       "usage": usage_info, 
                                       "full_answer": "".join(accumulated_answer_chunks),
                                       "conversation_id": final_conv_id,
                                       "message_id": response_message_id}
                                return # End of stream
                            elif event_type == "error":
                                error_details = event.get("data", event)
                                yield {"type": "error", "code": error_details.get('code'), 
                                       "message": error_details.get('message'), 
                                       "status": error_details.get('status')}
                                return # Error ends stream
                        except json.JSONDecodeError:
                            yield {"type": "error", "message": f"Failed to parse JSON: '{json_payload_str}'"}
                        except Exception as e:
                             yield {"type": "error", "message": f"Error processing event: {e}, Data: {json_payload_str}"}
            # If stream ends without a message_end event but we got data
            if accumulated_answer_chunks and stream_derived_conversation_id :
                 yield {"type": "end", "usage": {}, "full_answer": "".join(accumulated_answer_chunks), "conversation_id": stream_derived_conversation_id, "message_id": response_message_id}


    except requests.exceptions.HTTPError as http_err:
        err_msg = f"HTTP error: {http_err}"
        if 'response' in locals() and response and response.text: err_msg += f" Response: {response.text}"
        yield {"type": "error", "message": err_msg}
    except requests.exceptions.RequestException as req_err:
        yield {"type": "error", "message": f"Request error: {req_err}"}


def call_ai_hub_api_blocking_adapter(
    query_text: str, 
    auth_token: str, 
    conv_id_to_use: Optional[str]
) -> Dict[str, Any]:
    """
    Calls AI Hub API in blocking mode, returning a dictionary of results.
    Returns: {"status": "success", "answer": str, "conversation_id": str, "message_id": str, "thoughts": list, "usage": dict}
             or {"status": "error", "message": str, "code": str/int (optional)}
    """
    url = 'https://aihub.scnu.edu.cn/api/chat-messages'
    headers = {
        'accept': 'application/json', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'authorization': f'Bearer {auth_token}', 'content-type': 'application/json', 'dnt': '1',
        'origin': 'https://aihub.scnu.edu.cn', 'priority': 'u=1, i', 'referer': 'https://aihub.scnu.edu.cn/',
        'sec-ch-ua': '"Chromium";v="136", "Microsoft Edge";v="136", "Not.A/Brand";v="99"',
        'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0'
    }
    request_payload_conv_id = conv_id_to_use if conv_id_to_use else ""
    data_payload = {
        "response_mode": "blocking", "conversation_id": request_payload_conv_id,
        "files": [], "query": query_text, "inputs": {}, "parent_message_id": None
    }

    try:
        response = requests.post(url, headers=headers, json=data_payload, timeout=120)
        response.raise_for_status()
        json_response = response.json()

        if json_response.get("event") == "error" or ("code" in json_response and "message" in json_response and "answer" not in json_response):
            error_data = json_response.get("data", json_response)
            return {"status": "error", "message": error_data.get('message'), "code": error_data.get('code')}

        full_answer = json_response.get("answer", "")
        returned_conv_id = json_response.get("conversation_id", conv_id_to_use or "")
        response_message_id = json_response.get("id")
        
        thoughts = []
        agent_thoughts_raw = json_response.get("agent_thoughts")
        if agent_thoughts_raw and isinstance(agent_thoughts_raw, list):
            for thought_item in agent_thoughts_raw:
                if isinstance(thought_item, dict) and "thought" in thought_item:
                    thoughts.append(thought_item['thought'].strip())
                elif isinstance(thought_item, str):
                    thoughts.append(thought_item.strip())
        
        usage_info = json_response.get("metadata", {}).get("usage", {})

        return {
            "status": "success", "answer": full_answer, "conversation_id": returned_conv_id,
            "message_id": response_message_id, "thoughts": thoughts, "usage": usage_info
        }

    except requests.exceptions.HTTPError as http_err:
        err_msg = f"HTTP error: {http_err}"
        if 'response' in locals() and response and response.text: 
            err_msg += f" Response: {response.text}"
            try:
                error_json = response.json()
                if "message" in error_json: err_msg += f" API Error: {error_json['message']}"
            except json.JSONDecodeError: pass
        return {"status": "error", "message": err_msg}
    except requests.exceptions.RequestException as req_err:
        return {"status": "error", "message": f"Request error: {req_err}"}
    except json.JSONDecodeError:
        err_msg = "Failed to parse JSON response from blocking API."
        if 'response' in locals() and response and response.text: err_msg += f" Response: {response.text}"
        return {"status": "error", "message": err_msg}

# --- FastAPI Application ---
app = FastAPI(title="SCNU AI Hub OpenAI-Compatible API")

# Global variable for the CLI part's conversation ID.
_cli_current_conversation_id: Optional[str] = None
_cli_use_streaming: bool = False

# Default bearer token for SCNU AI Hub (can be overridden by environment variable SCNU_BEARER_TOKEN).
# This token is used by the CLI client. The API endpoint /v1/chat/completions
# requires clients to provide their own token via the Authorization header.
SCNU_BEARER_TOKEN = os.getenv("SCNU_BEARER_TOKEN", "")
#token自己抓

@app.post("/v1/chat/completions", response_model=None) # response_model handled by direct Response/StreamingResponse
async def chat_completions(
    request_data: ChatCompletionsRequest,
    authorization: Optional[str] = Header(None),
    x_scnu_conversation_id: Optional[str] = Header(None, alias="X-SCNU-Conversation-ID")
):
    # Validate Authorization header and extract SCNU bearer token
    if authorization is None:
        raise HTTPException(status_code=401, detail="Authorization header is missing.")
    
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Authorization header must use the Bearer scheme (e.g., 'Bearer <token>').")

    # Extract the token part after "bearer "
    # The startswith("bearer ") check (case-insensitive for "bearer", sensitive for the space) ensures "bearer " is present.
    # So, authorization[len("bearer "):] will access the part after "bearer ".
    scnu_auth_token = authorization[len("bearer "):].strip()

    if not scnu_auth_token:
        # This case handles "Authorization: Bearer " or "Authorization: Bearer    " (empty token after stripping)
        raise HTTPException(status_code=401, detail="Bearer token is present in Authorization header but is empty.")

    # At this point, scnu_auth_token is the non-empty token provided in the header.
    # The global SCNU_BEARER_TOKEN is not used as a fallback by this API endpoint.

    if not request_data.messages:
        raise HTTPException(status_code=400, detail="No messages provided")

    # Use the content of the last message as the query
    query_text = request_data.messages[-1].content
    if request_data.messages[-1].role != "user":
        # OpenAI typically expects last message to be user, but we can be flexible
        # Or raise error: HTTPException(status_code=400, detail="Last message must be from user")
        pass


    openai_model_name = request_data.model or "scnu-aihub-model"
    # The SCNU conversation ID to use for this request
    scnu_conv_id_for_request = x_scnu_conversation_id 
    
    final_scnu_conv_id: Optional[str] = None
    response_headers = {}

    if request_data.stream:
        async def stream_generator():
            nonlocal final_scnu_conv_id
            generated_first_chunk = False
            completion_id = f"chatcmpl-stream-{uuid.uuid4().hex}"
            
            for event in call_ai_hub_api_streaming_adapter(query_text, scnu_auth_token, scnu_conv_id_for_request):
                if event["type"] == "id_update":
                    final_scnu_conv_id = event.get("conversation_id")
                    # message_id = event.get("message_id") # SCNU message_id

                elif event["type"] == "chunk":
                    if not generated_first_chunk:
                        # First chunk sends role
                        delta_role = ChoiceDelta(role="assistant")
                        choice_role = StreamingChoice(index=0, delta=delta_role)
                        chunk_role = ChatCompletionChunk(id=completion_id, model=openai_model_name, choices=[choice_role])
                        yield f"data: {chunk_role.model_dump_json()}\n\n"
                        generated_first_chunk = True
                    
                    delta = ChoiceDelta(content=event["text"])
                    choice = StreamingChoice(index=0, delta=delta)
                    chunk = ChatCompletionChunk(id=completion_id, model=openai_model_name, choices=[choice])
                    yield f"data: {chunk.model_dump_json()}\n\n"

                elif event["type"] == "final_answer": # If SCNU sends full answer in stream
                    if not generated_first_chunk: # Treat as a single chunk if no prior chunks
                        delta_role = ChoiceDelta(role="assistant")
                        choice_role = StreamingChoice(index=0, delta=delta_role)
                        chunk_role = ChatCompletionChunk(id=completion_id, model=openai_model_name, choices=[choice_role])
                        yield f"data: {chunk_role.model_dump_json()}\n\n"
                        generated_first_chunk = True
                    delta = ChoiceDelta(content=event["text"])
                    choice = StreamingChoice(index=0, delta=delta)
                    chunk = ChatCompletionChunk(id=completion_id, model=openai_model_name, choices=[choice])
                    yield f"data: {chunk.model_dump_json()}\n\n"
                
                elif event["type"] == "thought":
                    # OpenAI stream doesn't have "thoughts". Log server-side or ignore.
                    print(f"[SCNU Thought via API Adapter] {event['content']}")

                elif event["type"] == "end":
                    final_scnu_conv_id = event.get("conversation_id", final_scnu_conv_id) # update if available
                    # scnu_usage = event.get("usage") # SCNU usage data
                    # OpenAI spec: send finish_reason in the last chunk's delta
                    delta_finish = ChoiceDelta() # Empty delta, just finish_reason
                    choice_finish = StreamingChoice(index=0, delta=delta_finish, finish_reason="stop")
                    chunk_finish = ChatCompletionChunk(id=completion_id, model=openai_model_name, choices=[choice_finish])
                    yield f"data: {chunk_finish.model_dump_json()}\n\n"
                    break # End of SCNU stream

                elif event["type"] == "error":
                    error_payload = {
                        "error": {
                            "message": event.get("message", "Unknown stream error"),
                            "type": "api_error", 
                            "param": None,
                            "code": event.get("code", "unknown_error_code")
                        }
                    }
                    yield f"data: {json.dumps(error_payload)}\n\n"
                    break
            
            yield "data: [DONE]\n\n"

        if scnu_conv_id_for_request:
             response_headers["X-SCNU-Conversation-ID"] = scnu_conv_id_for_request
        # Note: if final_scnu_conv_id is newly created during stream, it cannot be easily put in response headers.
        # Client should manage conversation IDs if it needs to reuse them across requests.

        return StreamingResponse(stream_generator(), media_type="text/event-stream", headers=response_headers)

    else: # Blocking mode
        result = call_ai_hub_api_blocking_adapter(query_text, scnu_auth_token, scnu_conv_id_for_request)

        if result["status"] == "error":
            raise HTTPException(status_code=502, detail=f"SCNU API Error: {result.get('message', 'Unknown error')}")

        final_scnu_conv_id = result.get("conversation_id")
        scnu_usage = result.get("usage", {}) 

        usage_data = UsageInfo(
            prompt_tokens=scnu_usage.get("prompt_tokens", 0) or scnu_usage.get("total_tokens",0), 
            completion_tokens=scnu_usage.get("completion_tokens", 0),
            total_tokens=scnu_usage.get("total_tokens", 0)
        )
        
        response_message = MessageOutput(role="assistant", content=result["answer"])
        choice = BlockingChoice(index=0, message=response_message, finish_reason="stop")
        openai_response = ChatCompletionResponse(
            model=openai_model_name,
            choices=[choice],
            usage=usage_data
        )
        
        if final_scnu_conv_id:
            response_headers["X-SCNU-Conversation-ID"] = final_scnu_conv_id
        
        return JSONResponse(content=openai_response.model_dump(), headers=response_headers)


# --- Original SCNU Client Interaction Logic (for CLI, adapted) ---

def delete_conversation_on_server(conv_id_to_delete: str, auth_token: str) -> bool:
    if not conv_id_to_delete:
        print("[System Info] No active conversation ID to delete.")
        return False
    url = f'https://aihub.scnu.edu.cn/api/conversations/{conv_id_to_delete}'
    headers = {
        'accept': '*/*', 
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'authorization': f'Bearer {auth_token}', 
        'cache-control': 'no-cache',
        'dnt': '1',
        'origin': 'https://aihub.scnu.edu.cn', 
        'pragma': 'no-cache',
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
        # Dify returns 204 No Content on successful deletion
        if response.status_code == 204 or response.status_code == 200: # 200 for older/other systems
            print(f"[System Info] Conversation {conv_id_to_delete} deleted successfully from server (Status: {response.status_code}).")
            return True
        else:
            print(f"[System Error] Unexpected status {response.status_code} while deleting conversation {conv_id_to_delete}. Response: {response.text}")
            return False
    except requests.exceptions.HTTPError as http_err:
        err_response_text = http_err.response.text if http_err.response else "No response body"
        print(f"HTTP error deleting conversation {conv_id_to_delete}: {http_err}. Response: {err_response_text}")
        return False
    except requests.exceptions.RequestException as req_err:
        print(f"Request error deleting conversation {conv_id_to_delete}: {req_err}")
        return False


def run_cli_client():
    global _cli_current_conversation_id, _cli_use_streaming, SCNU_BEARER_TOKEN
    
    bearer_token_cli = SCNU_BEARER_TOKEN # Use the globally defined token for CLI
    if not bearer_token_cli:
        print("[Error] SCNU_BEARER_TOKEN is not set. Please set the environment variable or configure it in the script.")
        print("The CLI client cannot operate without a bearer token.")
        return
    
    print("AI Hub API Interactive Client (CLI Mode)")
    print("--------------------------------------------------------------------")
    print(f"  Using SCNU Bearer Token: ...{bearer_token_cli[-10:] if len(bearer_token_cli) > 10 else 'TOKEN_TOO_SHORT_TO_TRUNCATE'}")
    print("  Type your query and press Enter.")
    print("  /new         - Start a new SCNU conversation session locally.")
    print("  /delete      - Delete current SCNU conversation from server and locally.")
    print("  /show_id     - Display current SCNU conversation ID for this CLI session.")
    print("  /stream_on   - Enable streaming mode for responses.")
    print("  /stream_off  - Disable streaming mode (blocking responses).")
    print("  /exit or /quit - Stop the client.")
    print("--------------------------------------------------------------------")

    while True:
        prompt_conv_id_display = _cli_current_conversation_id[:8] if _cli_current_conversation_id else "New Conv"
        mode_display = "Stream" if _cli_use_streaming else "Block"
        user_input = input(f"[{prompt_conv_id_display}][{mode_display}] Your query: ")
        
        if user_input.lower() in ['/exit', '/quit']:
            print("Exiting client...")
            break
        
        if user_input.lower() == '/new':
            _cli_current_conversation_id = None
            print("Local SCNU conversation session reset. Next query will start a new one on server.")
            print("--------------------------------------------------------------------")
            continue

        if user_input.lower() == '/delete':
            if _cli_current_conversation_id:
                confirm = input(f"Delete SCNU conversation {_cli_current_conversation_id} from server? (yes/no): ")
                if confirm.lower() == 'yes':
                    if delete_conversation_on_server(_cli_current_conversation_id, bearer_token_cli):
                        print(f"[System Info] Local reference to SCNU conversation {_cli_current_conversation_id} cleared.")
                        _cli_current_conversation_id = None
                    else:
                        print(f"[System Error] Failed to delete SCNU conversation {_cli_current_conversation_id} from server.")
                else:
                    print("Deletion cancelled.")
            else:
                print("No active SCNU conversation in this CLI session to delete.")
            print("--------------------------------------------------------------------")
            continue

        if user_input.lower() == '/show_id':
            if _cli_current_conversation_id:
                print(f"Current SCNU Conversation ID (CLI Session): {_cli_current_conversation_id}")
            else:
                print("No active SCNU conversation in this CLI session.")
            print("--------------------------------------------------------------------")
            continue
        
        if user_input.lower() == '/stream_on':
            _cli_use_streaming = True
            print("Streaming mode ENABLED for CLI.")
            print("--------------------------------------------------------------------")
            continue

        if user_input.lower() == '/stream_off':
            _cli_use_streaming = False
            print("Streaming mode DISABLED (blocking responses) for CLI.")
            print("--------------------------------------------------------------------")
            continue
            
        if not user_input.strip():
            print("Query cannot be empty.")
            continue

        user_query = user_input 
        print(f"\nSending query: '{user_query}' (Mode: {'Streaming' if _cli_use_streaming else 'Blocking'})...")
        
        if _cli_use_streaming:
            full_response_text = []
            print("\n--- Streaming Response (CLI) ---")
            active_conv_id_for_request = _cli_current_conversation_id
            new_conv_id_from_stream = None
            for event in call_ai_hub_api_streaming_adapter(user_query, bearer_token_cli, active_conv_id_for_request):
                if event["type"] == "id_update":
                    new_conv_id_from_stream = event.get("conversation_id")
                    if new_conv_id_from_stream and new_conv_id_from_stream != _cli_current_conversation_id :
                         print(f"[System Info CLI] SCNU conversation ID updated/received: {new_conv_id_from_stream}")
                         _cli_current_conversation_id = new_conv_id_from_stream # Update global CLI conv ID
                elif event["type"] == "chunk":
                    print(event["text"], end='', flush=True)
                    full_response_text.append(event["text"])
                elif event["type"] == "final_answer": # Should ideally not happen if chunks are working
                    print(event["text"], end='', flush=True)
                    full_response_text.append(event["text"])
                elif event["type"] == "thought":
                    print(f"\n<THINKING>\n{event['content']}\n</THINKING>", flush=True)
                elif event["type"] == "end":
                    print("\n--- Stream Ended (CLI) ---")
                    final_conv_id_from_end = event.get("conversation_id")
                    if final_conv_id_from_end and final_conv_id_from_end != _cli_current_conversation_id:
                        print(f"[System Info CLI] Final SCNU conversation ID: {final_conv_id_from_end}")
                        _cli_current_conversation_id = final_conv_id_from_end
                    elif not _cli_current_conversation_id and new_conv_id_from_stream: # if first message in new conv
                        _cli_current_conversation_id = new_conv_id_from_stream
                    if event.get("usage"): print(f"[Usage Info CLI] {event['usage']}")
                    break
                elif event["type"] == "error":
                    print(f"\n[API Error CLI] Code: {event.get('code')}, Message: {event.get('message')}")
                    # Potentially clear conv_id if error is related to it, e.g. 404 on conv_id
                    break
            if not full_response_text: print() 

        else: # Blocking mode for CLI
            print("\n--- Blocking Response (CLI) ---")
            result = call_ai_hub_api_blocking_adapter(user_query, bearer_token_cli, _cli_current_conversation_id)
            if result["status"] == "success":
                returned_conv_id = result.get("conversation_id")
                if returned_conv_id and returned_conv_id != _cli_current_conversation_id :
                    print(f"[System Info CLI] SCNU conversation ID updated/received: {returned_conv_id}")
                    _cli_current_conversation_id = returned_conv_id

                if result.get("thoughts"):
                    for thought in result["thoughts"]:
                        print(f"<THINKING>\n{thought}\n</THINKING>", flush=True)
                
                print("\n<AI Response CLI>")
                print(result["answer"].strip())
                print("</AI Response CLI>\n")
                if result.get("usage"): print(f"[Usage Info CLI] {result['usage']}")
            else:
                print(f"[API Error CLI] Message: {result.get('message')}")
            print("--- Request End (CLI) ---")
        
        print("\n--------------------------------------------------------------------")


if __name__ == "__main__":
    print("This script provides an OpenAI-compatible API and a CLI client.")
    print("To run the FastAPI server for the OpenAI-compatible API, use a command like:")
    script_name = os.path.basename(__file__)
    print(f"  uvicorn {script_name.replace('.py', '')}:app --host 0.0.0.0 --port 8000")
    print("\nStarting CLI client by default...")
    run_cli_client()
