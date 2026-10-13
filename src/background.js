importScripts("./jsQR.js");

const DEFAULT_SETTINGS = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  targetLanguage: "简体中文",
  translateChineseToOtherLanguage: true,
  chineseTargetLanguage: "英语",
  sourceLanguage: "自动检测",
  style: "自然、准确，保留原文段落结构",
  apiKey: ""
};

const activeRequests = new WeakMap();
const QR_MENU_ID = "recognize-qr-code";
const MAX_QR_IMAGE_DIMENSION = 4096;

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(() => {
  createQrContextMenu();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== QR_MENU_ID || !tab?.id || !info.srcUrl) {
    return;
  }

  sendQrMessage(tab.id, { type: "QR_RECOGNITION_STARTED" });

  try {
    const text = await decodeQrFromImage(info.srcUrl);
    sendQrMessage(tab.id, {
      type: "QR_RECOGNITION_RESULT",
      text
    });
  } catch (error) {
    sendQrMessage(tab.id, {
      type: "QR_RECOGNITION_ERROR",
      message: error.message || "二维码识别失败"
    });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set({
    ...DEFAULT_SETTINGS,
    ...existing
  });
});

function createQrContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: QR_MENU_ID,
      title: "识别二维码",
      contexts: ["image"]
    });
  });
}

async function decodeQrFromImage(srcUrl) {
  if (/^blob:/i.test(srcUrl)) {
    throw new Error("此图片地址无法从后台读取，请尝试保存图片后再识别");
  }

  let response;
  try {
    response = await fetch(srcUrl, {
      credentials: "include",
      cache: "no-store"
    });
  } catch {
    throw new Error("图片下载失败，请检查网络或图片权限");
  }

  if (!response.ok) {
    throw new Error("图片下载失败（" + response.status + "）");
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(await response.blob());
  } catch {
    throw new Error("图片格式无法解析");
  }

  try {
    const scale = Math.min(
      1,
      MAX_QR_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height)
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("当前浏览器不支持图片解码");
    }

    context.drawImage(bitmap, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const result = self.jsQR(image.data, image.width, image.height, {
      inversionAttempts: "attemptBoth"
    });
    if (!result?.data) {
      throw new Error("未识别到二维码，请确保二维码清晰完整");
    }
    return result.data;
  } finally {
    bitmap.close();
  }
}

function sendQrMessage(tabId, message) {
  chrome.tabs.sendMessage(tabId, message, () => {
    void chrome.runtime.lastError;
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (message?.type === "GET_SETTINGS") {
    chrome.storage.local.get(DEFAULT_SETTINGS).then((settings) => {
      sendResponse({
        configured: Boolean(settings.apiKey && settings.baseUrl && settings.model)
      });
    });
    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ai-translation") {
    return;
  }

  port.onMessage.addListener(async (message) => {
    if (message?.type !== "START_TRANSLATION") {
      return;
    }

    const previousController = activeRequests.get(port);
    previousController?.abort();

    const controller = new AbortController();
    activeRequests.set(port, controller);

    try {
      const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
      validateSettings(settings);
      validateText(message.text);

      await streamTranslation({
        port,
        controller,
        settings,
        text: message.text
      });
    } catch (error) {
      if (error.name !== "AbortError") {
        postError(port, error.message || "翻译请求失败");
      }
    } finally {
      if (activeRequests.get(port) === controller) {
        activeRequests.delete(port);
      }
    }
  });

  port.onDisconnect.addListener(() => {
    activeRequests.get(port)?.abort();
    activeRequests.delete(port);
  });
});

function validateSettings(settings) {
  if (!settings.apiKey) {
    throw new Error("请先在插件设置中填写 API Key");
  }
  if (!settings.baseUrl) {
    throw new Error("请先在插件设置中填写 API Base URL");
  }
  if (!settings.model) {
    throw new Error("请先在插件设置中填写模型名称");
  }
}

function validateText(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("没有可翻译的文字");
  }
  if (text.length > 6000) {
    throw new Error("选中文字过长，请控制在 6000 个字符以内");
  }
}

async function streamTranslation({ port, controller, settings, text }) {
  const endpoint = buildEndpoint(settings.baseUrl);
  const detectedChinese = isChineseText(text);
  const useChineseTarget = settings.translateChineseToOtherLanguage && detectedChinese;
  const targetLanguage = useChineseTarget
    ? (settings.chineseTargetLanguage || "英语")
    : (settings.targetLanguage || "简体中文");
  const sourceLanguage = detectedChinese ? "中文" : (settings.sourceLanguage || "自动检测");
  const prompt = [
    "请将下面的文本翻译成" + targetLanguage + "。",
    "源语言：" + sourceLanguage + "。",
    "翻译要求：" + (settings.style || "自然、准确，保留原文段落结构") + "。",
    "只输出译文，不要解释翻译过程。",
    "",
    "原文：",
    text
  ].join("\n");

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 45000);

  try {
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + settings.apiKey
        },
        body: JSON.stringify({
          model: settings.model,
          stream: true,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: "你是一个专业的翻译助手。"
            },
            {
              role: "user",
              content: prompt
            }
          ]
        }),
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === "AbortError" && timedOut) {
        throw new Error("API 请求超时，请稍后重试");
      }
      if (error.name === "AbortError") {
        throw error;
      }
      throw new Error("无法连接 API，请检查地址和网络");
    }

    if (!response.ok) {
      throw new Error(await getApiError(response));
    }

    if (!response.body) {
      throw new Error("API 没有返回可读取的内容");
    }

    port.postMessage({
      type: "TRANSLATION_STARTED",
      detectedChinese,
      targetLanguage
    });
    try {
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        await readJsonResponse(response, port);
        return;
      }
      await readSse(response.body, port, controller.signal);
    } catch (error) {
      if (error.name === "AbortError" && timedOut) {
        throw new Error("API 请求超时，请稍后重试");
      }
      throw error;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function isChineseText(text) {
  const hanCount = countCharacters(text, /\p{Script=Han}/gu);
  if (hanCount === 0) {
    return false;
  }

  const kanaCount = countCharacters(text, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangulCount = countCharacters(text, /\p{Script=Hangul}/gu);
  if (kanaCount > 0 || hangulCount > 0) {
    return false;
  }

  const latinCount = countCharacters(text, /\p{Script=Latin}/gu);
  return hanCount / (hanCount + latinCount) >= 0.3;
}

function countCharacters(text, pattern) {
  return text.match(pattern)?.length || 0;
}

function buildEndpoint(baseUrl) {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }
  return normalized + "/chat/completions";
}

async function readJsonResponse(response, port) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("API 返回格式无法解析");
  }

  const content = payload.choices?.[0]?.message?.content
    ?? payload.choices?.[0]?.text
    ?? "";
  if (!content) {
    throw new Error("API 返回为空，请检查模型和接口格式");
  }
  port.postMessage({ type: "TRANSLATION_CHUNK", chunk: content });
  port.postMessage({ type: "TRANSLATION_DONE" });
}

async function readSse(body, port, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedText = false;

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    if (signal.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }

    buffer += decoder.decode(result.value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";

    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");

      if (!data || data === "[DONE]") {
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }

      const chunk = payload.choices?.[0]?.delta?.content
        ?? payload.choices?.[0]?.message?.content
        ?? "";
      if (chunk) {
        receivedText = true;
        port.postMessage({ type: "TRANSLATION_CHUNK", chunk });
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const data = buffer
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (data && data !== "[DONE]") {
      try {
        const payload = JSON.parse(data);
        const chunk = payload.choices?.[0]?.delta?.content
          ?? payload.choices?.[0]?.message?.content
          ?? "";
        if (chunk) {
          receivedText = true;
          port.postMessage({ type: "TRANSLATION_CHUNK", chunk });
        }
      } catch {
        // Some providers omit a final complete SSE event.
      }
    }
  }

  if (!receivedText) {
    throw new Error("API 返回为空，请检查模型和接口格式");
  }
  port.postMessage({ type: "TRANSLATION_DONE" });
}

async function getApiError(response) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    return "API 请求失败（" + response.status + "）";
  }

  try {
    const json = JSON.parse(body);
    const message = json.error?.message || json.message;
    if (message) {
      return "API 请求失败：" + message;
    }
  } catch {
    // Fall through to a status-based message.
  }

  if (response.status === 401) {
    return "API Key 无效或没有权限";
  }
  if (response.status === 429) {
    return "请求过于频繁或余额不足";
  }
  return "API 请求失败（" + response.status + "）";
}

function postError(port, message) {
  try {
    port.postMessage({ type: "TRANSLATION_ERROR", message });
  } catch {
    // The page may have closed the port while the request was finishing.
  }
}
