const STORAGE_DEFAULTS = {
  claudeAccounts: {},
  claudeActiveAccountId: null,
  claudeLastQuotaEvent: null
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(STORAGE_DEFAULTS));
  const patch = {};

  for (const [key, value] of Object.entries(STORAGE_DEFAULTS)) {
    if (typeof existing[key] === "undefined") {
      patch[key] = value;
    }
  }

  if (Object.keys(patch).length > 0) {
    await chrome.storage.local.set(patch);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== "claude-quota-tracker") {
    return false;
  }

  if (message.type === "account-detected") {
    chrome.action.setBadgeText({ text: "" });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "quota-block-detected") {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
