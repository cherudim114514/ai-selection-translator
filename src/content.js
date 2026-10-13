(() => {
  const MAX_TEXT_LENGTH = 6000;
  const HOST_ID = "ai-translation-extension-host";

  let currentSelection = null;
  let hideTimer = null;
  let activePort = null;
  let activeRequestId = 0;
  let qrText = "";

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.position = "fixed";
  host.style.zIndex = "2147483647";
  host.style.display = "none";
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "closed" });
  shadow.appendChild(createStyles());
  const button = createButton();
  const panel = createPanel();
  const qrPanel = createQrPanel();
  shadow.append(button, panel, qrPanel);

  document.addEventListener("mouseup", scheduleSelectionCheck, true);
  document.addEventListener("touchend", scheduleSelectionCheck, true);
  document.addEventListener("selectionchange", scheduleSelectionCheck, true);
  document.addEventListener("mousedown", handlePageMouseDown, true);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", () => {
    if (currentSelection) {
      showPanel();
      requestTranslation(currentSelection.text);
    }
  });

  panel.querySelector('[data-action="close"]').addEventListener("click", hide);
  panel.querySelector('[data-action="copy"]').addEventListener("click", copyTranslation);
  panel.querySelector('[data-action="replace"]').addEventListener("click", replaceSelectedText);
  panel.querySelector('[data-action="retry"]').addEventListener("click", () => {
    if (currentSelection) {
      requestTranslation(currentSelection.text);
    }
  });
  panel.querySelector('[data-action="settings"]').addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
  });
  qrPanel.querySelector('[data-action="close"]').addEventListener("click", hide);
  qrPanel.querySelector('[data-action="copy-qr"]').addEventListener("click", copyQrResult);

  function scheduleSelectionCheck() {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(captureSelection, 80);
  }

  function captureSelection() {
    if (
      shadow.activeElement ||
      panel.classList.contains("is-open") ||
      qrPanel.classList.contains("is-open")
    ) {
      return;
    }

    const controlSelection = captureFormControlSelection();
    if (controlSelection) {
      currentSelection = controlSelection;
      positionAt(controlSelection.rect);
      showButton();
      return;
    }

    const selection = window.getSelection();
    const selectedText = selection?.toString() || "";
    const text = selectedText.trim();
    if (!selection || !text || selection.rangeCount === 0) {
      if (!panel.classList.contains("is-open")) {
        hide();
      }
      return;
    }

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    currentSelection = {
      text,
      selectedText,
      rect,
      range: selection.getRangeAt(0).cloneRange()
    };
    positionAt(rect);
    showButton();
  }

  function captureFormControlSelection() {
    const control = document.activeElement;
    if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
      return null;
    }
    if (control.disabled || control.readOnly || !control.isConnected) {
      return null;
    }

    let start;
    let end;
    try {
      start = control.selectionStart;
      end = control.selectionEnd;
    } catch {
      return null;
    }
    if (start === null || end === null || start === end) {
      return null;
    }

    const selectedText = control.value.slice(start, end);
    if (!selectedText.trim()) {
      return null;
    }
    return {
      text: selectedText.trim(),
      selectedText,
      rect: control.getBoundingClientRect(),
      control,
      start,
      end
    };
  }

  function handlePageMouseDown(event) {
    if (event.composedPath().includes(host)) {
      return;
    }
    hide();
  }

  function showButton() {
    button.hidden = false;
    panel.classList.remove("is-open");
    qrPanel.classList.remove("is-open");
    host.style.display = "block";
  }

  function showPanel() {
    button.hidden = true;
    panel.classList.add("is-open");
    qrPanel.classList.remove("is-open");
    host.style.display = "block";
    setStatus("正在翻译...", "loading");
    panel.querySelector(".translation-text").textContent = "";
    panel.querySelector('[data-action="copy"]').disabled = true;
    panel.querySelector('[data-action="replace"]').hidden = true;
    panel.querySelector('[data-action="retry"]').hidden = true;
    panel.querySelector('[data-action="settings"]').hidden = true;
    reposition();
  }

  function hide() {
    closeActivePort();
    currentSelection = null;
    qrText = "";
    host.style.display = "none";
    button.hidden = false;
    panel.classList.remove("is-open");
    qrPanel.classList.remove("is-open");
  }

  function positionAt(rect) {
    const panelOpen = panel.classList.contains("is-open");
    const hostRect = host.getBoundingClientRect();
    const width = hostRect.width || (panelOpen ? 360 : 76);
    const height = hostRect.height || (panelOpen ? 220 : 40);
    const gap = 8;
    let left = rect.right + gap;
    let top = Math.max(12, rect.top);

    if (left + width > window.innerWidth - 12) {
      left = Math.max(12, rect.left - width - gap);
    }
    if (top + height > window.innerHeight - 12) {
      top = Math.max(12, window.innerHeight - height - 12);
    }
    host.style.left = Math.round(left) + "px";
    host.style.top = Math.round(top) + "px";
  }

  function reposition() {
    if (currentSelection && host.style.display !== "none") {
      positionAt(currentSelection.rect);
    } else if (qrPanel.classList.contains("is-open")) {
      positionQrPanel();
    }
  }

  function handleRuntimeMessage(message) {
    if (message?.type === "QR_RECOGNITION_STARTED") {
      showQrPanel("正在读取图片并识别二维码...", "loading", "");
    } else if (message?.type === "QR_RECOGNITION_RESULT") {
      showQrPanel("识别完成", "success", message.text || "");
    } else if (message?.type === "QR_RECOGNITION_ERROR") {
      showQrPanel(message.message || "二维码识别失败", "error", "");
    }
  }

  function showQrPanel(statusMessage, statusType, text) {
    closeActivePort();
    currentSelection = null;
    qrText = text;
    button.hidden = true;
    panel.classList.remove("is-open");
    qrPanel.classList.add("is-open");
    host.style.display = "block";
    qrPanel.querySelector(".qr-status").textContent = statusMessage;
    qrPanel.querySelector(".qr-status").dataset.type = statusType;
    qrPanel.querySelector(".qr-text").textContent = text;
    qrPanel.querySelector('[data-action="copy-qr"]').disabled = !text;
    positionQrPanel();
  }

  function positionQrPanel() {
    const panelRect = qrPanel.getBoundingClientRect();
    const width = panelRect.width || 360;
    const height = panelRect.height || 190;
    const left = Math.max(12, Math.round((window.innerWidth - width) / 2));
    const top = Math.max(12, Math.round((window.innerHeight - height) / 3));
    host.style.left = left + "px";
    host.style.top = top + "px";
  }

  function requestTranslation(text) {
    closeActivePort();
    const requestId = ++activeRequestId;
    let output = "";
    panel.querySelector(".translation-text").textContent = "";
    panel.querySelector('[data-action="copy"]').disabled = true;
    panel.querySelector('[data-action="replace"]').hidden = true;
    panel.querySelector('[data-action="retry"]').hidden = true;
    panel.querySelector('[data-action="settings"]').hidden = true;
    setStatus("正在翻译...", "loading");
    activePort = chrome.runtime.connect({ name: "ai-translation" });

    activePort.onMessage.addListener((message) => {
      if (requestId !== activeRequestId) {
        return;
      }
      if (message.type === "TRANSLATION_STARTED") {
        const prefix = message.detectedChinese ? "检测到中文，" : "";
        setStatus(prefix + "正在翻译为" + message.targetLanguage + "...", "loading");
      } else if (message.type === "TRANSLATION_CHUNK") {
        output += message.chunk;
        panel.querySelector(".translation-text").textContent = output;
        panel.querySelector('[data-action="copy"]').disabled = !output;
      } else if (message.type === "TRANSLATION_DONE") {
        setStatus("翻译完成", "success");
        panel.querySelector('[data-action="replace"]').hidden = !canReplaceSelection();
        panel.querySelector('[data-action="retry"]').hidden = false;
      } else if (message.type === "TRANSLATION_ERROR") {
        setStatus(message.message, "error");
        panel.querySelector('[data-action="replace"]').hidden = true;
        panel.querySelector('[data-action="retry"]').hidden = false;
        panel.querySelector('[data-action="settings"]').hidden = message.message.includes("设置");
      }
    });

    activePort.onDisconnect.addListener(() => {
      if (requestId === activeRequestId) {
        activePort = null;
      }
    });
    activePort.postMessage({
      type: "START_TRANSLATION",
      requestId,
      text
    });
  }

  async function copyTranslation() {
    const text = panel.querySelector(".translation-text").textContent;
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus("已复制到剪贴板", "success");
    } catch {
      setStatus("复制失败，请手动选择译文", "error");
    }
  }

  function canReplaceSelection() {
    if (!currentSelection) {
      return false;
    }

    if (currentSelection.control) {
      const { control, start, end, text } = currentSelection;
      return control.isConnected &&
        !control.disabled &&
        !control.readOnly &&
        typeof control.setRangeText === "function" &&
        control.value.slice(start, end).trim() === text;
    }

    const { range, text } = currentSelection;
    if (!range || !range.startContainer.isConnected || !range.endContainer.isConnected) {
      return false;
    }
    const root = getEditableRoot(range.startContainer);
    return Boolean(
      root &&
      root === getEditableRoot(range.endContainer) &&
      range.toString().trim() === text
    );
  }

  function getEditableRoot(node) {
    let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (element && !element.isContentEditable) {
      element = element.parentElement;
    }
    return element;
  }

  function replaceSelectedText() {
    const translated = panel.querySelector(".translation-text").textContent;
    if (!translated) {
      return;
    }
    if (!canReplaceSelection()) {
      setStatus("原文选区已失效，无法替换", "error");
      panel.querySelector('[data-action="replace"]').hidden = true;
      return;
    }

    if (currentSelection.control) {
      const { control, start, end } = currentSelection;
      control.focus();
      control.setRangeText(translated, start, end, "end");
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const range = currentSelection.range;
      const root = getEditableRoot(range.startContainer);
      range.deleteContents();
      const replacement = document.createTextNode(translated);
      range.insertNode(replacement);
      const selection = window.getSelection();
      const replacementRange = document.createRange();
      replacementRange.selectNode(replacement);
      selection.removeAllRanges();
      selection.addRange(replacementRange);
      root.dispatchEvent(new Event("input", { bubbles: true }));
    }

    setStatus("已替换原文", "success");
    panel.querySelector('[data-action="replace"]').hidden = true;
  }

  async function copyQrResult() {
    if (!qrText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(qrText);
      qrPanel.querySelector(".qr-status").textContent = "已复制到剪贴板";
      qrPanel.querySelector(".qr-status").dataset.type = "success";
    } catch {
      qrPanel.querySelector(".qr-status").textContent = "复制失败，请手动选择结果";
      qrPanel.querySelector(".qr-status").dataset.type = "error";
    }
  }

  function closeActivePort() {
    activeRequestId += 1;
    if (activePort) {
      activePort.disconnect();
      activePort = null;
    }
  }

  function setStatus(message, type) {
    const status = panel.querySelector(".translation-status");
    status.textContent = message;
    status.dataset.type = type;
  }

  function createButton() {
    const element = document.createElement("button");
    element.className = "translate-button";
    element.type = "button";
    element.textContent = "翻译";
    element.title = "翻译选中文字";
    return element;
  }

  function createPanel() {
    const element = document.createElement("section");
    element.className = "translation-panel";

    const header = document.createElement("div");
    header.className = "panel-header";
    const title = document.createElement("strong");
    title.textContent = "AI 翻译";
    const close = createActionButton("×", "close", "关闭");
    close.className = "icon-button";
    header.append(title, close);

    const status = document.createElement("div");
    status.className = "translation-status";
    status.dataset.type = "loading";
    status.textContent = "正在翻译...";

    const text = document.createElement("div");
    text.className = "translation-text";
    text.setAttribute("aria-live", "polite");

    const actions = document.createElement("div");
    actions.className = "panel-actions";
    const copy = createActionButton("复制", "copy", "复制译文");
    copy.disabled = true;
    const replace = createActionButton("替换原文", "replace", "用译文替换原选区");
    replace.hidden = true;
    const retry = createActionButton("重试", "retry", "重新翻译");
    retry.hidden = true;
    const settings = createActionButton("打开设置", "settings", "打开插件设置");
    settings.hidden = true;
    actions.append(copy, replace, retry, settings);

    element.append(header, status, text, actions);
    return element;
  }

  function createQrPanel() {
    const element = document.createElement("section");
    element.className = "qr-panel";

    const header = document.createElement("div");
    header.className = "panel-header";
    const title = document.createElement("strong");
    title.textContent = "二维码识别";
    const close = createActionButton("×", "close", "关闭");
    close.className = "icon-button";
    header.append(title, close);

    const status = document.createElement("div");
    status.className = "qr-status";
    status.dataset.type = "loading";

    const text = document.createElement("div");
    text.className = "qr-text";
    text.setAttribute("aria-live", "polite");

    const actions = document.createElement("div");
    actions.className = "panel-actions";
    const copy = createActionButton("复制结果", "copy-qr", "复制二维码内容");
    copy.disabled = true;
    actions.append(copy);

    element.append(header, status, text, actions);
    return element;
  }

  function createActionButton(label, action, title) {
    const element = document.createElement("button");
    element.type = "button";
    element.dataset.action = action;
    element.title = title;
    element.textContent = label;
    return element;
  }

  function createStyles() {
    const style = document.createElement("style");
    style.textContent = [
      ":host, * { box-sizing: border-box; }",
      "button { font: inherit; }",
      ".translate-button { min-width: 64px; height: 36px; padding: 0 14px; border: 1px solid #173b57; border-radius: 6px; background: #173b57; color: #fff; cursor: pointer; box-shadow: 0 4px 16px rgba(10, 31, 45, .22); font-size: 13px; font-weight: 600; }",
      ".translate-button:hover { background: #225575; }",
      ".translation-panel { display: none; width: 360px; max-width: calc(100vw - 24px); overflow: hidden; border: 1px solid #cbd5dc; border-radius: 8px; background: #fff; color: #16242d; box-shadow: 0 10px 34px rgba(13, 33, 47, .22); font-size: 13px; line-height: 1.55; }",
      ".translation-panel.is-open { display: block; }",
      ".qr-panel { display: none; width: 360px; max-width: calc(100vw - 24px); overflow: hidden; border: 1px solid #cbd5dc; border-radius: 8px; background: #fff; color: #16242d; box-shadow: 0 10px 34px rgba(13, 33, 47, .22); font-size: 13px; line-height: 1.55; }",
      ".qr-panel.is-open { display: block; }",
      ".panel-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #e4e9ed; }",
      ".panel-header strong { font-size: 14px; }",
      ".icon-button { width: 24px; height: 24px; padding: 0; border: 0; background: transparent; color: #66737c; cursor: pointer; font-size: 20px; line-height: 20px; }",
      ".icon-button:hover { color: #16242d; }",
      ".translation-status { min-height: 28px; padding: 8px 12px 0; color: #53636d; font-size: 12px; }",
      ".translation-status[data-type='error'] { color: #b42318; }",
      ".translation-status[data-type='success'] { color: #087443; }",
      ".translation-status[data-type='warning'] { color: #995700; }",
      ".translation-text { min-height: 72px; max-height: 260px; overflow: auto; padding: 6px 12px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }",
      ".qr-status { min-height: 28px; padding: 8px 12px 0; color: #53636d; font-size: 12px; }",
      ".qr-status[data-type='error'] { color: #b42318; }",
      ".qr-status[data-type='success'] { color: #087443; }",
      ".qr-text { min-height: 72px; max-height: 260px; overflow: auto; padding: 6px 12px 12px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }",
      ".panel-actions { display: flex; gap: 8px; padding: 8px 12px 12px; border-top: 1px solid #e4e9ed; }",
      ".panel-actions button { min-height: 30px; padding: 0 10px; border: 1px solid #cbd5dc; border-radius: 5px; background: #fff; color: #29404e; cursor: pointer; font-size: 12px; }",
      ".panel-actions button:hover:not(:disabled) { background: #f3f6f8; }",
      ".panel-actions button:disabled { cursor: not-allowed; opacity: .5; }",
      ".panel-actions [data-action='replace'] { border-color: #087443; color: #087443; }",
      ".panel-actions [data-action='settings'] { border-color: #173b57; background: #173b57; color: #fff; }"
    ].join("");
    return style;
  }
})();
