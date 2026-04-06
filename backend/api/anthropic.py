from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import StreamingResponse
import json
import logging
import asyncio
import uuid
from backend.services.qwen_client import QwenClient
from backend.services.token_calc import calculate_usage
from backend.services.prompt_builder import build_prompt_with_tools
from backend.services.tool_sieve import ToolSieve
from backend.core.config import resolve_model

log = logging.getLogger("qwen2api.anthropic")
router = APIRouter()

@router.post("/messages")
@router.post("/v1/messages")
@router.post("/anthropic/v1/messages")
async def anthropic_messages(request: Request):
    """
    Claude API 协议转换层 -> 转入 OpenAI/Qwen 统一处理内核
    """
    app = request.app
    users_db = app.state.users_db
    client: QwenClient = app.state.qwen_client

    # 鉴权 (完全复原单文件逻辑)
    token = request.headers.get("x-api-key", "").strip()

    # Anthropic 请求可能没有传 x-api-key 而是使用 Bearer Token
    if not token:
        bearer = request.headers.get("Authorization", "")
        if bearer.startswith("Bearer "):
            token = bearer[7:].strip()

    # 有些工具可能会传在 querystring 中
    if not token:
        token = request.query_params.get("key", "").strip() or request.query_params.get("api_key", "").strip()

    from backend.core.config import API_KEYS, settings
    admin_k = settings.ADMIN_KEY

    if API_KEYS:
        if token != admin_k and token not in API_KEYS and not token:
            raise HTTPException(status_code=401, detail="Invalid API Key")

    # 获取下游用户处理配额
    users = await users_db.get()
    user = next((u for u in users if u["id"] == token), None)
    if user and user.get("quota", 0) <= user.get("used_tokens", 0):
        raise HTTPException(status_code=402, detail="Quota Exceeded")
        
    body = await request.json()
    model = resolve_model(body.get("model", "claude-3-5-sonnet"))
    messages = body.get("messages", [])
    tools = body.get("tools", [])
    
    # 构造兼容 OpenAI 的消息格式给 Prompt builder
    system_text = body.get("system", "")
    oai_msgs = []
    if system_text:
        oai_msgs.append({"role": "system", "content": system_text})
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        # 处理 Claude 特有的数组形式
        if isinstance(content, list):
            text_blocks = [blk.get("text", "") for blk in content if blk.get("type") == "text"]
            content = "\n".join(text_blocks)
        oai_msgs.append({"role": role, "content": content})
        
    content = build_prompt_with_tools(oai_msgs, tools)
            
    log.info(f"[Anthropic] model={model}, stream=True, tools={[t.get('name') for t in tools]}, prompt_len={len(content)}")

    try:
        events, chat_id, acc = await client.chat_stream_events_with_retry(model, content)
    except Exception as e:
        log.error(f"Anthropic proxy failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
        
    async def generate():
        full_text = ""
        sieve = ToolSieve()
        
        # 预计算输入 token
        input_usage = calculate_usage(content, "")["prompt_tokens"]
        
        # 状态追踪：满足 Anthropic 严格的流式事件顺序
        has_started_text = False
        current_index = 0
        has_tool_call = False
        
        try:
            # 初始 MessageStart
            start_event = {
                "type": "message_start",
                "message": {
                    "id": f"msg_{uuid.uuid4().hex[:12]}", 
                    "type": "message", 
                    "role": "assistant", 
                    "model": model, 
                    "content": [],
                    "usage": {"input_tokens": input_usage, "output_tokens": 0}
                }
            }
            yield f"event: message_start\ndata: {json.dumps(start_event)}\n\n"


            for evt in events:
                if evt.get("type") == "delta":
                    text = evt.get("content", "")
                    safe_text, tool_calls = sieve.process_delta(text)
                    full_text += safe_text

                    if safe_text:
                        if not has_started_text:
                            yield f"event: content_block_start\ndata: {json.dumps({'type': 'content_block_start', 'index': current_index, 'content_block': {'type': 'text', 'text': ''}})}\n\n"

                            has_started_text = True
                            
                        chunk = {
                            "type": "content_block_delta",
                            "index": current_index,
                            "delta": {"type": "text_delta", "text": safe_text}
                        }
                        yield f"event: content_block_delta\ndata: {json.dumps(chunk)}\n\n"


                    for tc in tool_calls:
                        has_tool_call = True
                        if has_started_text:
                            yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': current_index})}\n\n"

                            has_started_text = False
                            current_index += 1
                            
                        log.info(f"[Anthropic] Tool Call Emitted: {tc.get('name')} with args: {tc.get('input')}")
                        yield f"event: content_block_start\ndata: {json.dumps({'type': 'content_block_start', 'index': current_index, 'content_block': {'type': 'tool_use', 'id': f'toolu_{uuid.uuid4().hex[:8]}', 'name': tc.get('name', ''), 'input': {}}})}\n\n"

                        yield f"event: content_block_delta\ndata: {json.dumps({'type': 'content_block_delta', 'index': current_index, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(tc.get('input', {}), ensure_ascii=False)}})}\n\n"

                        yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': current_index})}\n\n"

                        current_index += 1

            # flush 残余文本
            safe_text, tool_calls = sieve.flush()
            full_text += safe_text
            
            if safe_text:
                if not has_started_text:
                    yield f"event: content_block_start\ndata: {json.dumps({'type': 'content_block_start', 'index': current_index, 'content_block': {'type': 'text', 'text': ''}})}\n\n"

                    has_started_text = True
                    
                chunk = {
                    "type": "content_block_delta",
                    "index": current_index,
                    "delta": {"type": "text_delta", "text": safe_text}
                }
                yield f"event: content_block_delta\ndata: {json.dumps(chunk)}\n\n"


            for tc in tool_calls:
                has_tool_call = True
                if has_started_text:
                    yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': current_index})}\n\n"

                    has_started_text = False
                    current_index += 1
                    
                log.info(f"[Anthropic] Tool Call Emitted (flushed): {tc.get('name')} with args: {tc.get('input')}")
                yield f"event: content_block_start\ndata: {json.dumps({'type': 'content_block_start', 'index': current_index, 'content_block': {'type': 'tool_use', 'id': f'toolu_{uuid.uuid4().hex[:8]}', 'name': tc.get('name', ''), 'input': {}}})}\n\n"

                yield f"event: content_block_delta\ndata: {json.dumps({'type': 'content_block_delta', 'index': current_index, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(tc.get('input', {}), ensure_ascii=False)}})}\n\n"

                yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': current_index})}\n\n"

                current_index += 1
                
            if has_started_text:
                yield f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': current_index})}\n\n"

                has_started_text = False

            log.info(f"[Anthropic] Request complete. Generated {len(full_text)} characters.")

            usage = calculate_usage(content, full_text)

            stop_reason = "tool_use" if has_tool_call else "end_turn"
            msg_delta = {
                "type": "message_delta",
                "delta": {"stop_reason": stop_reason},
                "usage": {"output_tokens": usage["completion_tokens"]}
            }
            yield f"event: message_delta\ndata: {json.dumps(msg_delta)}\n\n"

            
            stop_event = {"type": "message_stop"}
            yield f"event: message_stop\ndata: {json.dumps(stop_event)}\n\n"


            users = await users_db.get()
            for u in users:
                if u["id"] == token:
                    u["used_tokens"] += usage["total_tokens"]
                    break
            await users_db.save(users)

        finally:
            client.account_pool.release(acc)
            asyncio.create_task(client.delete_chat(acc.token, chat_id))

    return StreamingResponse(generate(), media_type="text/event-stream")
