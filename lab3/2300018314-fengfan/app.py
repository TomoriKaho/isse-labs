"""支持多个独立的 DeepSeek 会话，并用 JSON 文件保存会话与问答。"""

import json
import os
import tempfile
from itertools import count
from pathlib import Path
from threading import Lock

import requests
from flask import Flask, jsonify, request
from werkzeug.exceptions import (
    BadGateway,
    BadRequest,
    Conflict,
    GatewayTimeout,
    HTTPException,
    NotFound,
    ServiceUnavailable,
    UnsupportedMediaType,
)


# Key 只从容器运行时环境变量读取，不加载本地 .env 文件。

# 将 frontend 中的文件映射到根路径，供 HTML 中的相对资源地址使用。
app = Flask(__name__, static_folder="frontend", static_url_path="")
app.json.ensure_ascii = False

DATA_FILE = Path(__file__).resolve().parent / "data" / "conversations.json"
LEGACY_FILE = DATA_FILE.with_name("messages.json")
MISSING_FILE = object()


def read_saved_json(path):
    """用独立标记表示文件不存在，避免把 JSON null 当成缺失文件。"""
    try:
        content = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return MISSING_FILE
    except OSError:
        raise RuntimeError(f"无法读取 data/{path.name}，请检查文件访问权限") from None
    try:
        return json.loads(content) if content.strip() else []
    except ValueError:
        raise RuntimeError(f"data/{path.name} 不是有效 JSON，请修复后重启；原文件未被覆盖") from None


def load_conversations():
    """仅在新文件不存在时迁移旧记录，避免删除会话后旧记录重新出现。"""
    saved = read_saved_json(DATA_FILE)
    migrate = saved is MISSING_FILE
    if migrate:
        legacy = read_saved_json(LEGACY_FILE)
        if legacy is not MISSING_FILE and not isinstance(legacy, list):
            raise RuntimeError("data/messages.json 最外层必须是数组；原文件未被覆盖")
        saved = (
            [{"id": 1, "title": "历史记录", "messages": legacy}]
            if legacy is not MISSING_FILE and legacy else []
        )
    try:
        if not isinstance(saved, list):
            raise ValueError
        restored = {}
        seen_message_ids = set()
        for conversation in saved:
            if (
                not isinstance(conversation, dict)
                or type(conversation.get("id")) is not int
                or conversation["id"] < 1
                or conversation["id"] in restored
                or not isinstance(conversation.get("title"), str)
                or not conversation["title"].strip()
                or not isinstance(conversation.get("messages"), list)
            ):
                raise ValueError
            for record in conversation["messages"]:
                if (
                    not isinstance(record, dict)
                    or type(record.get("id")) is not int
                    or record["id"] < 1
                    or record["id"] in seen_message_ids
                    or not isinstance(record.get("message"), str)
                    or not isinstance(record.get("reply"), str)
                ):
                    raise ValueError
                seen_message_ids.add(record["id"])
            restored[conversation["id"]] = conversation
    except (ValueError, TypeError):
        raise RuntimeError("聊天数据结构不正确，请检查 data 下的 JSON 文件；原文件未被覆盖") from None
    if migrate:
        # 先生成新文件，旧文件保留为迁移备份，此后不再更新或读取它。
        write_conversations(restored)
    return restored


def write_conversations(updated):
    """先完整写入临时文件，再替换原文件。"""
    temporary_path = None
    try:
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=DATA_FILE.parent,
            prefix="conversations-", suffix=".tmp", delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            json.dump(list(updated.values()), temporary_file, ensure_ascii=False, indent=2)
            temporary_file.write("\n")
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, DATA_FILE)
    except OSError:
        raise ServiceUnavailable("聊天记录保存失败，本次更改未生效，请检查磁盘空间和文件权限") from None
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


def save_conversations(updated):
    """在锁内调用；磁盘保存成功后才替换内存数据。"""
    write_conversations(updated)
    conversations.clear()
    conversations.update(updated)


conversations = load_conversations()
conversation_ids = count(max(conversations, default=0) + 1)
message_ids = count(max(
    (record["id"] for conversation in conversations.values() for record in conversation["messages"]),
    default=0,
) + 1)
data_lock = Lock()
MAX_MESSAGE_LENGTH = 4000
MAX_CONTEXT_ROUNDS = 10
DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"
DEEPSEEK_MODEL = "deepseek-flash"


def read_text(field, limit):
    """校验 JSON 请求中的文本字段，并去掉首尾空白。"""
    if not request.is_json:
        raise UnsupportedMediaType("请使用 application/json 格式发送请求")
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise BadRequest("请求内容必须是有效的 JSON 对象")
    message = data.get(field)
    if not isinstance(message, str) or not message.strip():
        raise BadRequest(f"{field} 必须是非空字符串")
    message = message.strip()
    if len(message) > limit:
        raise BadRequest(f"{field} 不能超过 {limit} 个字符")
    return message


def get_ai_reply(message, history):
    """调用 DeepSeek，只返回回答文本，不向浏览器转发上游原始响应。"""
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not api_key or api_key == "your_api_key_here":
        raise ServiceUnavailable("后端尚未配置 DeepSeek API Key，请在容器运行时设置 DEEPSEEK_API_KEY 并重启服务")
    if not api_key.isascii() or any(char.isspace() for char in api_key):
        raise ServiceUnavailable("DeepSeek API Key 格式不正确，请检查容器运行时环境变量并重启服务")

    context = []
    for record in history[-MAX_CONTEXT_ROUNDS:]:
        context.append({"role": "user", "content": record["message"]})
        context.append({"role": "assistant", "content": record["reply"]})
    context.append({"role": "user", "content": message})
    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": context,
        "thinking": {"type": "disabled"},
        "stream": False,
        "max_tokens": 2048,
    }
    try:
        with requests.post(
            DEEPSEEK_API_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json=payload,
            timeout=(10, 60),
            allow_redirects=False,
        ) as response:
            if response.status_code in (401, 403):
                raise ServiceUnavailable("DeepSeek 身份验证失败，请检查后端 API Key 或账户权限")
            if response.status_code == 402:
                raise ServiceUnavailable("DeepSeek 账户余额不足，请在开放平台检查余额")
            if response.status_code == 429:
                raise ServiceUnavailable("DeepSeek 请求过于频繁，请稍后重试")
            if response.status_code != 200:
                raise BadGateway(f"DeepSeek 调用失败（HTTP {response.status_code}），请稍后重试")

            try:
                result = response.json()
                reply = result["choices"][0]["message"]["content"]
            except (ValueError, KeyError, IndexError, TypeError):
                raise BadGateway("DeepSeek 返回的数据格式异常，请稍后重试") from None
    except requests.Timeout:
        raise GatewayTimeout("等待 DeepSeek 回复超时，请稍后重试；本次未保存聊天记录") from None
    except requests.RequestException:
        # 不返回异常原文，避免其中携带请求头或其他敏感信息。
        raise BadGateway("无法连接 DeepSeek 服务，请检查网络后重试") from None

    if not isinstance(reply, str) or not reply.strip():
        raise BadGateway("DeepSeek 未返回有效的回答文本，请稍后重试")
    return reply.strip()


@app.errorhandler(HTTPException)
def handle_http_error(error):
    if request.path.startswith("/api/"):
        return jsonify({"error": error.description}), error.code
    return error


@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/hello")
def hello():
    return jsonify({"message": "你好"})


def find_conversation(conversation_id):
    conversation = conversations.get(conversation_id)
    if conversation is None:
        raise NotFound("找不到这个会话，请刷新列表后重试")
    return conversation


def store_conversation(conversation):
    """调用者持有 data_lock，并传入新对象，不直接修改旧对象。"""
    updated = dict(conversations)
    updated[conversation["id"]] = conversation
    save_conversations(updated)


@app.post("/api/conversations")
def create_conversation():
    title = read_text("title", 100)
    with data_lock:
        conversation = {"id": next(conversation_ids), "title": title, "messages": []}
        store_conversation(conversation)
        return jsonify(conversation), 201


@app.get("/api/conversations")
def list_conversations():
    with data_lock:
        return jsonify([
            {"id": item["id"], "title": item["title"], "message_count": len(item["messages"])}
            for item in conversations.values()
        ])


@app.get("/api/conversations/<int:conversation_id>")
def get_conversation(conversation_id):
    with data_lock:
        return jsonify(find_conversation(conversation_id))


@app.patch("/api/conversations/<int:conversation_id>")
def rename_conversation(conversation_id):
    title = read_text("title", 100)
    with data_lock:
        conversation = {**find_conversation(conversation_id), "title": title}
        store_conversation(conversation)
        return jsonify(conversation)


@app.delete("/api/conversations/<int:conversation_id>")
def delete_conversation(conversation_id):
    with data_lock:
        find_conversation(conversation_id)
        updated = dict(conversations)
        del updated[conversation_id]
        save_conversations(updated)
    return "", 204


@app.post("/api/messages")
@app.post("/api/conversations/<int:conversation_id>/messages")
def create_message(conversation_id=None):
    message = read_text("message", MAX_MESSAGE_LENGTH)
    with data_lock:
        # 兼容原来的 POST：使用第一个会话；没有会话时创建默认会话。
        if conversation_id is None:
            if not conversations:
                store_conversation({"id": next(conversation_ids), "title": "默认会话", "messages": []})
            conversation_id = next(iter(conversations))
        conversation = find_conversation(conversation_id)
        history = conversation["messages"]

    # 网络调用在锁外完成；其他会话仍可读写。
    reply = get_ai_reply(message, history)
    with data_lock:
        conversation = find_conversation(conversation_id)
        # 历史使用新列表替换。调用期间被修改时，不保存基于旧上下文的回答。
        if conversation["messages"] is not history:
            raise Conflict("等待回复期间，该会话记录已变化；本次回复未保存，请刷新后重试")
        record = {"id": next(message_ids), "message": message, "reply": reply}
        store_conversation({**conversation, "messages": [*history, record]})
        return jsonify(record), 201


@app.get("/api/messages")
@app.get("/api/conversations/<int:conversation_id>/messages")
def list_messages(conversation_id=None):
    with data_lock:
        if conversation_id is not None:
            return jsonify(find_conversation(conversation_id)["messages"])
        return jsonify([record for item in conversations.values() for record in item["messages"]])


def find_record(message_id, conversation_id):
    candidates = (
        [find_conversation(conversation_id)] if conversation_id is not None
        else conversations.values()
    )
    for conversation in candidates:
        for record in conversation["messages"]:
            if record["id"] == message_id:
                return conversation, record
    raise NotFound("找不到这条聊天记录，请刷新列表后重试")


@app.patch("/api/messages/<int:message_id>")
@app.patch("/api/conversations/<int:conversation_id>/messages/<int:message_id>")
def update_message(message_id, conversation_id=None):
    message = read_text("message", MAX_MESSAGE_LENGTH)
    with data_lock:
        conversation, original = find_record(message_id, conversation_id)
        record = {**original, "message": message}
        updated = [record if item["id"] == message_id else item for item in conversation["messages"]]
        store_conversation({**conversation, "messages": updated})
        return jsonify(record)


@app.delete("/api/messages/<int:message_id>")
@app.delete("/api/conversations/<int:conversation_id>/messages/<int:message_id>")
def delete_message(message_id, conversation_id=None):
    with data_lock:
        conversation, _ = find_record(message_id, conversation_id)
        updated = [item for item in conversation["messages"] if item["id"] != message_id]
        store_conversation({**conversation, "messages": updated})
    return "", 204


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=False)
