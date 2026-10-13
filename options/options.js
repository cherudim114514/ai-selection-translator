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

const form = document.querySelector("#settings-form");
const status = document.querySelector("#save-status");
const chineseTranslationToggle = document.querySelector("#translate-chinese");
const chineseTargetLanguage = document.querySelector("#chinese-target-language");
const apiKeyInput = document.querySelector("#api-key");
const toggleApiKeyButton = document.querySelector("#toggle-api-key");

document.addEventListener("DOMContentLoaded", loadSettings);
form.addEventListener("submit", saveSettings);
chineseTranslationToggle.addEventListener("change", updateChineseTargetState);
toggleApiKeyButton.addEventListener("click", toggleApiKeyVisibility);

async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements.namedItem(key);
    if (field) {
      if (field.type === "checkbox") {
        field.checked = Boolean(value);
      } else {
        field.value = value;
      }
    }
  }
  updateChineseTargetState();
}

async function saveSettings(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  data.baseUrl = data.baseUrl.trim().replace(/\/+$/, "");
  data.model = data.model.trim();
  data.apiKey = data.apiKey.trim();
  data.translateChineseToOtherLanguage = chineseTranslationToggle.checked;
  data.chineseTargetLanguage = chineseTargetLanguage.value;

  if (!data.baseUrl || !data.model || !data.apiKey) {
    showStatus("请填写 API 地址、API Key 和模型名称", "error");
    return;
  }

  try {
    new URL(data.baseUrl);
  } catch {
    showStatus("API Base URL 不是有效地址", "error");
    return;
  }

  await chrome.storage.local.set({
    ...DEFAULT_SETTINGS,
    ...data
  });
  showStatus("设置已保存", "success");
}

function updateChineseTargetState() {
  chineseTargetLanguage.disabled = !chineseTranslationToggle.checked;
  document.querySelector("#chinese-target-setting").classList.toggle(
    "is-disabled",
    !chineseTranslationToggle.checked
  );
}

function toggleApiKeyVisibility() {
  const isVisible = apiKeyInput.type === "text";
  apiKeyInput.type = isVisible ? "password" : "text";
  toggleApiKeyButton.textContent = isVisible ? "查看 API Key" : "隐藏 API Key";
  toggleApiKeyButton.setAttribute("aria-pressed", String(!isVisible));
}

function showStatus(message, type) {
  status.textContent = message;
  status.dataset.type = type;
  window.clearTimeout(showStatus.timer);
  showStatus.timer = window.setTimeout(() => {
    status.textContent = "";
    status.dataset.type = "";
  }, 3000);
}
