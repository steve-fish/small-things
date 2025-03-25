"""
title: DSider
author: gemini
author_url: https://deepsider.ai/
funding_url: https://deepsider.ai/
version: 0.1
description: DSider
"""

import asyncio
import aiohttp
import json
from pydantic import BaseModel, Field
from typing import List, Optional, Callable, Awaitable, AsyncGenerator
from datetime import datetime
import uuid
from aiohttp import ClientResponse


# DEEPSIDER_API_BASE = "https://api.chargpt.ai/api/v2"  # Moved to Valves
TOKEN_INDEX = 0  # Global variable to track the current token index

# Model mapping table
MODEL_MAPPING: dict[str, str] = {
    "gpt-4o-mini": "openai/gpt-4o-mini",
    "gpt-4o": "openai/gpt-4o",
    "o1": "openai/o1",
    "o3-mini": "oopenai/o3-mini",
    "claude-3.5-sonnet": "anthropic/claude-3.5-sonnet",
    "claude-3.7-sonnet": "anthropic/claude-3.7-sonnet",
    "grok-3": "x-ai/grok-3",
    "grok-3-reasoner": "x-ai/grok-3-reasoner",
    "deepseek-v3": "deepseek/deepseek-chat",
    "deepseek-r1": "deepseek/deepseek-r1",
    "gemini-2.0-flash": "google/gemini-2.0-flash",
    "gemini-2.0-pro-exp": "google/gemini-2.0-pro-exp-02-05",
    "gemini-2.0-flash-thinking-exp": "google/gemini-2.0-flash-thinking-exp-1219",
    "qwq-32b": "qwen/qwq-32b",
    "qwen-max": "qwen/qwen-max",
}


class ChatMessage(BaseModel):
    role: str
    content: str
    name: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    model: str
    messages: List[ChatMessage]
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    n: Optional[int] = None
    stream: Optional[bool] = None
    stop: Optional[List[str] | str] = None
    max_tokens: Optional[int] = None
    presence_penalty: Optional[float] = None
    frequency_penalty: Optional[float] = None
    user: Optional[str] = None


class Pipe:
    class Valves(BaseModel):
        api_url: str = Field(
            default="https://api.chargpt.ai/api/v2",
            description="Base URL for the DeepSider API.",
        )
        api_key: str = Field(
            default="", description="API key for DeepSider API."
        )  # Add API key to Valves

    def __init__(self):
        self.type = "manifold"
        self.name = "DSider."
        self.valves = self.Valves()
        self.emitter = None
        self.logger = Logger()  # Use the logger defined above

    async def emit_status(self, message: str = "", done: bool = False):
        if self.emitter:
            await self.emitter(
                {"type": "status", "data": {"description": message, "done": done}}
            )

    def _get_headers(self) -> dict[str, str]:
        global TOKEN_INDEX
        api_key = self.valves.api_key
        tokens = api_key.split(",")
        current_token = (
            tokens[TOKEN_INDEX % len(tokens)].strip() if tokens else api_key.strip()
        )
        TOKEN_INDEX = (TOKEN_INDEX + 1) % len(tokens)  # Correctly update token index

        return {
            "accept": "*/*",
            "accept-encoding": "gzip, deflate, br, zstd",
            "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
            "content-type": "application/json",
            "origin": "chrome-extension://client",
            "i-lang": "zh-CN",
            "i-version": "1.1.64",
            "sec-ch-ua": '"Chromium";v="134", "Not:A-Brand";v="24"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "cross-site",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
            "authorization": f"Bearer {current_token}",
        }

    def _verify_api_key(self, auth_header: Optional[str]) -> Optional[str]:
        if not auth_header or not auth_header.startswith("Bearer "):
            return None
        return auth_header.replace("Bearer ", "")

    def _map_openai_to_deepsider_model(self, model: str) -> Optional[str]:
        return MODEL_MAPPING.get(model)  # Return None if not found

    def _format_messages_for_deepsider(self, messages: List[ChatMessage]) -> str:
        prompt = ""
        for msg in messages:
            role = msg.role
            if role == "system":
                prompt = f"{msg.content}\n\n{prompt}"
            elif role == "user":
                prompt += f"Human: {msg.content}\n\n"
            elif role == "assistant":
                prompt += f"Assistant: {msg.content}\n\n"
            else:
                prompt += f"Human ({role}): {msg.content}\n\n"

        #  No additional prompt if last message role is assistant
        return prompt.strip()

    async def _generate_openai_response(
        self, full_response: str, request_id: str, model: str
    ) -> dict:
        timestamp = int(datetime.utcnow().timestamp())
        return {
            "id": f"chatcmpl-{request_id}",
            "object": "chat.completion",
            "created": timestamp,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": full_response},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 0,  # Placeholder
                "completion_tokens": 0,  # Placeholder
                "total_tokens": 0,  # Placeholder
            },
        }

    async def _process_stream(
        self, response: ClientResponse
    ) -> AsyncGenerator[str, None]:
        buffer = b""
        async for chunk in response.content.iter_any():
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                line = line.strip()

                if not line or not line.startswith(b"data: "):
                    continue

                data_str = line[6:].decode("utf-8", errors="ignore")

                try:
                    data = json.loads(data_str)
                    if (
                        data.get("code") == 202
                        and data.get("data", {}).get("type") == "chat"
                    ):
                        content = data.get("data", {}).get("content", "")
                        if content:
                            yield content
                    elif data.get("code") == 203:
                        # End of stream
                        return
                except json.JSONDecodeError:
                    self.logger.warning(f"Cannot parse response: {data_str}")

    async def _stream_openai_response(
        self,
        response: ClientResponse,
        request_id: str,
        model: str,
        token_index: int,
    ) -> AsyncGenerator[str, None]:
        timestamp = int(datetime.utcnow().timestamp())
        full_response = ""

        try:
            async for content in self._process_stream(response):
                full_response += content
                chunk = {
                    "id": f"chatcmpl-{request_id}",
                    "object": "chat.completion.chunk",
                    "created": timestamp,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": content},
                            "finish_reason": None,
                        }
                    ],
                }
                yield f"data: {json.dumps(chunk)}\n\n"

            # Send completion signal
            chunk = {
                "id": f"chatcmpl-{request_id}",
                "object": "chat.completion.chunk",
                "created": timestamp,
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            yield f"data: {json.dumps(chunk)}\n\n"
            yield "data: [DONE]\n\n"

        except Exception as e:
            self.logger.error(f"Error processing streaming response: {e}")

            # Return error message
            error_chunk = {
                "id": f"chatcmpl-{request_id}",
                "object": "chat.completion.chunk",
                "created": timestamp,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": f"\n\n[Error processing response: {e}]"},
                        "finish_reason": "stop",
                    }
                ],
            }
            yield f"data: {json.dumps(error_chunk)}\n\n"
            yield "data: [DONE]\n\n"

    async def _check_account_balance(
        self, token_index: Optional[int] = None
    ) -> tuple[bool, dict]:

        api_key = self.valves.api_key
        tokens = api_key.split(",")
        current_token = (
            tokens[token_index].strip()
            if token_index is not None and len(tokens) > token_index
            else (tokens[0].strip() if tokens else api_key.strip())
        )

        headers = {
            "accept": "*/*",
            "content-type": "application/json",
            "authorization": f"Bearer {current_token}",
        }
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{self.valves.api_url.replace('/v2', '')}/quota/retrieve",  # Use api_url from Valves
                    headers=headers,
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        if data.get("code") == 0:
                            quota_list = data.get("data", {}).get("list", [])
                            quota_info = {
                                item.get("type", ""): {
                                    "total": item.get("total", 0),
                                    "available": item.get("available", 0),
                                    "title": item.get("title", ""),
                                }
                                for item in quota_list
                            }
                            return True, quota_info
                    return False, {}
        except Exception as e:
            self.logger.warning(f"Error checking account balance: {e}")
            return False, {}

    def get_models(self):
        models = []
        for openai_model in MODEL_MAPPING:
            models.append(
                {
                    "id": openai_model,
                    "name": openai_model,  # Or any other display name
                    "object": "model",
                    "created": int(datetime.utcnow().timestamp()),
                    "owned_by": "openai-proxy",
                }
            )
        return models

    def pipes(self) -> List[dict]:
        return [{"id": model["id"], "name": model["id"]} for model in self.get_models()]

    async def pipe(
        self,
        body: dict,
        __user__: Optional[dict] = None,
        __event_emitter__: Callable[[dict], Awaitable[None]] = None,
        __event_call__: Callable[[dict], Awaitable[dict]] = None,
    ) -> AsyncGenerator[str, None]:
        self.emitter = __event_emitter__
        await self.emit_status("Validating request...")

        if not self.valves.api_key:
            await self.emit_status("API key is missing in Valves.", done=True)
            yield "❌ Error: API key is missing in Valves."
            return

        try:
            chat_request = ChatCompletionRequest(**body)
            request_id = str(uuid.uuid4())

            if "." in chat_request.model:
                deepsider_model = self._map_openai_to_deepsider_model(
                    chat_request.model.split(".", 1)[1]
                )
            else:
                deepsider_model = self._map_openai_to_deepsider_model(
                    chat_request.model
                )

            if deepsider_model is None:
                await self.emit_status(
                    f"Unsupported model: {chat_request.model}", done=True
                )
                yield f"❌ Error: Unsupported model: {chat_request.model}"
                return

            prompt_messages = self._format_messages_for_deepsider(chat_request.messages)
            payload = {
                "model": deepsider_model,
                "prompt": prompt_messages,
                "webAccess": "close",
                "timezone": "Asia/Shanghai",
            }

            headers = self._get_headers()
            tokens = self.valves.api_key.split(",")
            current_token_index = (TOKEN_INDEX - 1) % len(tokens) if tokens else 0

            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.valves.api_url}/chat/conversation",  # Use api_url from Valves
                    headers=headers,
                    json=payload,
                ) as response:
                    if response.status != 200:
                        error_msg = f"DeepSider API request failed: {response.status}"
                        try:
                            error_data = await response.json()
                            error_msg += f" - {error_data.get('message', '')}"
                        except:
                            error_msg += f" - {await response.text()}"

                        self.logger.error(error_msg)
                        await self.emit_status(
                            f"API request failed: {response.status}", done=True
                        )
                        yield f"❌ Error: API request failed: {response.status}"
                        return

                    if chat_request.stream:
                        await self.emit_status(
                            "Starting streaming response...", done=False
                        )
                        async for chunk in self._stream_openai_response(
                            response,
                            request_id,
                            chat_request.model,
                            current_token_index,
                        ):
                            await self.emit_status("Streaming...", done=False)
                            yield chunk  # Yield the OpenAI formatted chunk
                    else:
                        await self.emit_status("Receiving response...", done=False)
                        try:
                            # Directly parse JSON response
                            response_data = await response.json()
                            if (
                                response_data.get("code") == 202
                                and response_data.get("data", {}).get("type") == "chat"
                            ):
                                full_response = response_data.get("data", {}).get(
                                    "content", ""
                                )
                            else:
                                # Handle unexpected response format
                                await self.emit_status(
                                    "Unexpected response format.", done=True
                                )
                                yield f"❌ Error: Unexpected response format: {response_data}"
                                return

                        except json.JSONDecodeError as e:
                            self.logger.error(f"JSONDecodeError: {e}")
                            self.logger.error(
                                f"Response Text: {await response.text()}"
                            )  # Log the raw response
                            await self.emit_status(
                                f"Failed to decode response: {e}", done=True
                            )
                            yield f"❌ Error: Failed to decode response: {e}"
                            return

                        await self.emit_status(
                            "Generating OpenAI response...", done=False
                        )

                        openai_response = await self._generate_openai_response(
                            full_response, request_id, chat_request.model
                        )
                        yield f"data: {json.dumps(openai_response)}\n\n"
                        yield "data: [DONE]\n\n"

        except Exception as e:
            await self.emit_status(f"An error occurred: {e}", done=True)
            self.logger.exception(f"Error processing request: {e}")
            yield f"❌ Error: {e}"
        finally:
            await self.emit_status("Completed generation.", done=True)

    async def admin_balance(self, auth_header: str, admin_key: str) -> dict:

        if not admin_key or admin_key != "admin":  # Hardcoded admin key
            return {"detail": "Unauthorized"}

        api_key = self.valves.api_key

        if not api_key:
            return {"detail": "Missing API key in Valves"}

        tokens = api_key.split(",")
        result: dict[str, any] = {}

        for i in range(len(tokens)):
            token_display = f"token_{i + 1}"
            success, quota_info = await self._check_account_balance(i)
            if success:
                result[token_display] = {"status": "success", "quota": quota_info}
            else:
                result[token_display] = {
                    "status": "error",
                    "message": "Could not get account balance information",
                }
        return result

    async def not_found(self, path: str) -> dict:
        return {
            "error": {
                "message": f"Resource not found: {path}",
                "type": "not_found_error",
                "code": "not_found",
            }
        }


# Simplified Logger
class Logger:
    def info(self, message: str):
        print(f"INFO: {datetime.utcnow().isoformat()} - {message}")

    def warning(self, message: str):
        print(f"WARNING: {datetime.utcnow().isoformat()} - {message}")

    def error(self, message: str):
        print(f"ERROR: {datetime.utcnow().isoformat()} - {message}")

    def exception(self, message: str):
        print(f"EXCEPTION: {datetime.utcnow().isoformat()} - {message}")
