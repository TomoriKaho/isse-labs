"use strict";

const messageList = document.querySelector("#message-list");
const messageForm = document.querySelector("#message-form");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const reloadButton = document.querySelector("#reload-button");
const recordCount = document.querySelector("#record-count");
const statusMessage = document.querySelector("#status-message");
const conversationList = document.querySelector("#conversation-list");
const conversationForm = document.querySelector("#conversation-form");
const conversationTitle = document.querySelector("#conversation-title");
const createConversationButton = document.querySelector("#create-conversation-button");
const renameConversationButton = document.querySelector("#rename-conversation-button");
const deleteConversationButton = document.querySelector("#delete-conversation-button");
const conversationEditor = document.querySelector("#conversation-editor");
const chatHeading = document.querySelector("#chat-heading");

let records = [];
let conversations = [];
let activeId = null;
let conversationMode = null;
const drafts = new Map();
let loaded = false;
let busy = false;
let editingId = null;
let deletingId = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showStatus(text, isError = false) {
  statusMessage.textContent = text;
  statusMessage.classList.toggle("is-error", isError);
  statusMessage.setAttribute("role", isError ? "alert" : "status");
}

function updateControls() {
  reloadButton.disabled = busy;
  messageInput.disabled = busy || !loaded || activeId === null;
  sendButton.disabled = busy || !loaded || activeId === null;
  conversationTitle.disabled = busy || !loaded;
  createConversationButton.disabled = busy || !loaded;
  renameConversationButton.disabled = busy || activeId === null;
  deleteConversationButton.disabled = busy || activeId === null;
  conversationList.querySelectorAll("button").forEach((control) => { control.disabled = busy; });
  conversationEditor.querySelectorAll("button, input").forEach((control) => { control.disabled = busy; });
  messageList.setAttribute("aria-busy", String(busy));
  messageList.querySelectorAll("button, textarea").forEach((control) => {
    control.disabled = busy;
  });
}

// 所有数据读写通过自己的 Flask API 完成；用户文字只作为文本显示。
async function api(path, method = "GET", data) {
  const options = { method, headers: { Accept: "application/json" }, cache: "no-store" };
  if (data !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(data);
  }

  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error("无法连接服务。请确认应用正在运行，并使用当前部署地址访问页面。");
  }
  if (response.status === 204) return null;

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`服务返回了无法识别的响应（HTTP ${response.status}）。`);
  }
  if (!response.ok) {
    throw new Error(result.error || `请求失败（HTTP ${response.status}）。`);
  }
  return result;
}

async function runAction(action, successText, progressText = "正在处理…") {
  if (busy) return false;
  busy = true;
  updateControls();
  showStatus(progressText);
  try {
    await action();
    renderPage();
    showStatus(successText);
    return true;
  } catch (error) {
    showStatus(error.message, true);
    return false;
  } finally {
    busy = false;
    updateControls();
  }
}

function actionButton(label, handler, extraClass = "") {
  const button = element("button", `text-button ${extraClass}`, label);
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}

function messagesPath() {
  return `/api/conversations/${activeId}/messages`;
}

function selectLoadedConversation(conversation) {
  if (activeId !== null) drafts.set(activeId, messageInput.value);
  activeId = conversation?.id ?? null;
  records = conversation?.messages ?? [];
  messageInput.value = drafts.get(activeId) ?? "";
  editingId = null;
  deletingId = null;
  conversationMode = null;
}

function renderConversations() {
  if (!conversations.length) {
    conversationList.replaceChildren(element("p", "sidebar-hint", "还没有会话，先为想聊的话题起个名字吧。"));
  } else {
    conversationList.replaceChildren(...conversations.map((conversation) => {
      const selected = conversation.id === activeId;
      const button = actionButton("", async () => {
        if (selected || busy) return;
        await runAction(async () => {
          const result = await api(`/api/conversations/${conversation.id}`);
          selectLoadedConversation(result);
        }, "已切换会话。");
      });
      button.className = `conversation-item${selected ? " is-active" : ""}`;
      button.setAttribute("aria-pressed", String(selected));
      button.append(
        element("span", "conversation-name", conversation.title),
        element("span", "conversation-count", `${selected ? records.length : conversation.message_count} 轮问答`),
      );
      return button;
    }));
  }
  chatHeading.textContent = conversations.find((item) => item.id === activeId)?.title ?? "选择或新建会话";
}

function closeConversationAction() {
  conversationMode = null;
  renderConversationEditor();
  renameConversationButton.focus();
}

function renderConversationEditor() {
  conversationEditor.replaceChildren();
  if (activeId === null || conversationMode === null) return;
  const conversation = conversations.find((item) => item.id === activeId);
  if (conversationMode === "rename") {
    const form = element("form", "edit-form");
    form.noValidate = true;
    const label = element("label", "edit-label", "会话名称");
    const input = element("input", "");
    input.id = "rename-conversation-input";
    input.value = conversation.title;
    input.maxLength = 100;
    label.htmlFor = input.id;
    const controls = element("div", "inline-actions");
    const save = element("button", "send-button", "保存名称");
    save.type = "submit";
    controls.append(save, actionButton("取消", closeConversationAction));
    form.append(label, input, controls);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      const title = input.value.trim();
      if (!title || title.length > 100) {
        showStatus("会话名称需为 1 至 100 个字符。", true);
        input.focus();
        return;
      }
      await runAction(async () => {
        const result = await api(`/api/conversations/${activeId}`, "PATCH", { title });
        conversations = conversations.map((item) => item.id === result.id
          ? { id: result.id, title: result.title, message_count: result.messages.length } : item);
        selectLoadedConversation(result);
      }, "会话已重命名。");
    });
    conversationEditor.append(form);
  } else {
    const box = element("div", "delete-confirmation");
    box.append(element("p", "", `确定删除“${conversation.title}”和其中的所有问答？删除后无法恢复。`));
    const controls = element("div", "inline-actions");
    controls.append(
      actionButton("确认删除会话", async () => {
        await runAction(async () => {
          const removedId = activeId;
          await api(`/api/conversations/${removedId}`, "DELETE");
          conversations = conversations.filter((item) => item.id !== removedId);
          selectLoadedConversation(null);
          drafts.delete(removedId);
        }, "会话已删除，可以选择其他会话或新建会话。");
      }, "danger-button"),
      actionButton("取消", closeConversationAction),
    );
    box.append(controls);
    conversationEditor.append(box);
  }
  updateControls();
}

function renderPage() {
  conversations = conversations.map((item) => item.id === activeId
    ? { ...item, message_count: records.length } : item);
  renderConversations();
  renderConversationEditor();
  renderRecords();
}

function messageRow(role, text) {
  const isUser = role === "user";
  const row = element("div", `message-row ${role}-row`);
  const avatar = element("span", `avatar ${role}-avatar`, isUser ? "你" : "AI");
  avatar.setAttribute("aria-hidden", "true");
  const content = element("div", "message-content");
  content.append(
    element("span", "speaker", isUser ? "你的问题" : "AI 助手"),
    element("p", `bubble ${role}-bubble`, text),
  );
  row.append(avatar, content);
  return row;
}

function closeRecordAction() {
  const previousId = editingId ?? deletingId;
  editingId = null;
  deletingId = null;
  renderRecords();
  messageList.querySelector(`[data-record-id="${previousId}"] button`)?.focus();
}

function editForm(record) {
  const form = element("form", "edit-form");
  form.noValidate = true;
  const label = element("label", "edit-label", "修改问题");
  const input = element("textarea", "edit-input");
  input.id = `edit-message-${record.id}`;
  input.value = record.message;
  input.rows = 3;
  input.maxLength = 4000;
  input.required = true;
  label.htmlFor = input.id;
  const errorText = element("p", "inline-error");
  errorText.id = `edit-error-${record.id}`;
  errorText.setAttribute("role", "alert");
  input.setAttribute("aria-describedby", errorText.id);

  const controls = element("div", "inline-actions");
  const saveButton = element("button", "send-button", "保存修改");
  saveButton.type = "submit";
  controls.append(saveButton, actionButton("取消", closeRecordAction));
  form.append(label, input,
    element("p", "edit-help", "修改问题不会重新生成已有回答；后续提问会使用修改后的历史。"),
    errorText, controls);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const message = input.value.trim();
    if (!message) {
      errorText.textContent = "问题不能只包含空格。";
      input.focus();
      return;
    }
    errorText.textContent = "";
    const saved = await runAction(async () => {
      const updated = await api(`${messagesPath()}/${record.id}`, "PATCH", { message });
      records = records.map((item) => item.id === updated.id ? updated : item);
      editingId = null;
    }, "聊天记录已修改。");
    if (saved) messageList.querySelector(`[data-record-id="${record.id}"] button`)?.focus();
  });
  return form;
}

function deleteConfirmation(record) {
  const box = element("div", "delete-confirmation");
  box.append(element("p", "", "确定删除这条问题及其回答？删除后无法恢复。"));
  const controls = element("div", "inline-actions");
  controls.append(
    actionButton("确认删除", async () => {
      const deleted = await runAction(async () => {
        await api(`${messagesPath()}/${record.id}`, "DELETE");
        records = records.filter((item) => item.id !== record.id);
        deletingId = null;
      }, "聊天记录已删除。");
      if (deleted) messageInput.focus();
    }, "danger-button"),
    actionButton("取消", closeRecordAction),
  );
  box.append(controls);
  return box;
}

function renderRecord(record) {
  const article = element("article", "message-record");
  article.dataset.recordId = record.id;
  article.setAttribute("aria-label", `聊天记录 ${record.id}`);
  article.append(messageRow("user", record.message), messageRow("assistant", record.reply));

  if (editingId === record.id) {
    article.append(editForm(record));
  } else if (deletingId === record.id) {
    article.append(deleteConfirmation(record));
  } else {
    const actions = element("div", "record-actions");
    actions.append(
      actionButton("修改", () => {
        editingId = record.id;
        deletingId = null;
        renderRecords();
        document.querySelector(`#edit-message-${record.id}`).focus();
      }),
      actionButton("删除", () => {
        deletingId = record.id;
        editingId = null;
        renderRecords();
        messageList.querySelector(".delete-confirmation button").focus();
      }, "delete-button"),
    );
    article.append(actions);
  }
  return article;
}

function renderRecords() {
  recordCount.textContent = `${records.length} 条记录`;
  if (activeId === null) {
    messageList.replaceChildren(element("p", "empty-state", "请选择已有会话，或新建一个会话后开始聊天。"));
  } else if (records.length === 0) {
    messageList.replaceChildren(element("p", "empty-state", "还没有聊天记录，写下你的第一个问题吧。"));
  } else {
    messageList.replaceChildren(...records.map(renderRecord));
  }
  updateControls();
}

async function loadRecords() {
  const success = await runAction(async () => {
    const result = await api("/api/conversations");
    if (!Array.isArray(result)) throw new Error("会话列表格式不正确，请检查服务后重试。");
    const selected = result.find((item) => item.id === activeId) ?? result[0];
    const detail = selected ? await api(`/api/conversations/${selected.id}`) : null;
    conversations = result;
    selectLoadedConversation(detail);
    loaded = true;
  }, "会话和聊天记录已加载。");
  if (!success && !loaded) {
    messageList.replaceChildren(element("p", "empty-state", "暂时无法加载记录，请点击“刷新列表”重试。"));
  }
}

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !loaded || activeId === null) return;
  const message = messageInput.value.trim();
  if (!message) {
    showStatus("请先输入问题，内容不能只包含空格。", true);
    messageInput.focus();
    return;
  }
  const sent = await runAction(async () => {
    const record = await api(messagesPath(), "POST", { message });
    records.push(record);
    editingId = null;
    deletingId = null;
    messageInput.value = "";
    drafts.delete(activeId);
  }, "消息已发送，回复已收到。", "正在等待 AI 回复，请稍候…");
  if (sent) {
    messageList.scrollTop = messageList.scrollHeight;
    messageInput.focus();
  }
});

conversationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !loaded) return;
  const title = conversationTitle.value.trim();
  if (!title || title.length > 100) {
    showStatus("请填写 1 至 100 个字符的会话名称。", true);
    conversationTitle.focus();
    return;
  }
  const created = await runAction(async () => {
    const result = await api("/api/conversations", "POST", { title });
    conversations.push({ id: result.id, title: result.title, message_count: 0 });
    selectLoadedConversation(result);
    conversationTitle.value = "";
  }, "会话已创建，可以开始聊天。");
  if (created) messageInput.focus();
});

renameConversationButton.addEventListener("click", () => {
  if (busy || activeId === null) return;
  conversationMode = "rename";
  renderConversationEditor();
  conversationEditor.querySelector("input").focus();
});

deleteConversationButton.addEventListener("click", () => {
  if (busy || activeId === null) return;
  conversationMode = "delete";
  renderConversationEditor();
  conversationEditor.querySelector("button").focus();
});

reloadButton.addEventListener("click", loadRecords);
loadRecords();
