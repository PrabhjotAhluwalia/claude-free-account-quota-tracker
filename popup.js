const STORAGE_KEYS = {
  accounts: "claudeAccounts",
  activeAccountId: "claudeActiveAccountId"
};

const accountList = document.getElementById("accountList");
const summary = document.getElementById("summary");
const refreshButton = document.getElementById("refreshButton");
const accountTemplate = document.getElementById("accountTemplate");

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function formatRelative(timestamp) {
  const diff = timestamp - Date.now();
  if (diff <= 0) {
    return "now";
  }

  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} hr ${remainingMinutes} min` : `${hours} hr`;
}

function accountSortValue(account) {
  return account.lastSeenAt || account.firstSeenAt || 0;
}

function setEmptyState() {
  accountList.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = "No Claude accounts detected yet. Open claude.ai while logged in, then reopen this popup.";
  accountList.append(empty);
  summary.textContent = "Waiting for the content script to see an account.";
}

function renderAccount(account, activeAccountId) {
  const node = accountTemplate.content.firstElementChild.cloneNode(true);
  const label = node.querySelector(".account-label");
  const meta = node.querySelector(".account-meta");
  const status = node.querySelector(".account-status");
  const resetAt = Number(account.quotaResetAt || 0);
  const isUnavailable = resetAt > Date.now();

  label.textContent = account.email || account.id;

  const metaBits = [];
  if (account.id === activeAccountId) {
    metaBits.push("Active now");
  }
  if (account.lastSeenAt) {
    metaBits.push(`Last seen ${formatDateTime(account.lastSeenAt)}`);
  }
  meta.textContent = metaBits.join(" · ") || "Saved account";

  if (isUnavailable) {
    status.className = "account-status unavailable";
    status.textContent = `Unavailable till ${formatDateTime(resetAt)} (${formatRelative(resetAt)})`;
  } else {
    status.className = "account-status available";
    status.textContent = "AVAILABLE";
  }

  return node;
}

async function loadAccounts() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.accounts, STORAGE_KEYS.activeAccountId]);
  const accounts = coalesceEmailAccounts(Object.values(data[STORAGE_KEYS.accounts] || {}), data[STORAGE_KEYS.activeAccountId])
    .sort((a, b) => accountSortValue(b) - accountSortValue(a));

  accountList.innerHTML = "";

  if (accounts.length === 0) {
    setEmptyState();
    return;
  }

  const unavailableCount = accounts.filter((account) => Number(account.quotaResetAt || 0) > Date.now()).length;
  const availableCount = accounts.length - unavailableCount;
  summary.textContent = `${availableCount} available, ${unavailableCount} unavailable`;

  for (const account of accounts) {
    accountList.append(renderAccount(account, data[STORAGE_KEYS.activeAccountId]));
  }
}

function coalesceEmailAccounts(rawAccounts, activeAccountId) {
  const byEmail = new Map();

  for (const account of rawAccounts) {
    const email = account.email || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.id || "") ? account.id : null);
    if (!email) {
      continue;
    }

    const key = email.toLowerCase();
    const previous = byEmail.get(key) || {};
    byEmail.set(key, {
      ...previous,
      ...account,
      id: key,
      email: key,
      username: null,
      label: key,
      firstSeenAt: Math.min(previous.firstSeenAt || account.firstSeenAt || Date.now(), account.firstSeenAt || Date.now()),
      lastSeenAt: Math.max(previous.lastSeenAt || 0, account.lastSeenAt || 0),
      quotaResetAt: Math.max(Number(previous.quotaResetAt || 0), Number(account.quotaResetAt || 0))
    });
  }

  carryForwardLegacyQuotaBlocks(rawAccounts, byEmail, activeAccountId);

  return [...byEmail.values()];
}

function carryForwardLegacyQuotaBlocks(rawAccounts, byEmail, activeAccountId) {
  const now = Date.now();
  const legacyBlocks = rawAccounts.filter((account) => {
    const hasEmail = account.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.id || "");
    return !hasEmail && Number(account.quotaResetAt || 0) > now;
  });

  for (const legacyBlock of legacyBlocks) {
    const candidates = [...byEmail.values()]
      .filter((account) => account.id !== activeAccountId && Number(account.quotaResetAt || 0) <= now)
      .sort((a, b) => {
        const aDistance = Math.abs(Number(a.lastSeenAt || 0) - Number(legacyBlock.lastSeenAt || 0));
        const bDistance = Math.abs(Number(b.lastSeenAt || 0) - Number(legacyBlock.lastSeenAt || 0));
        return aDistance - bDistance;
      });

    if (candidates.length === 0) {
      continue;
    }

    const target = candidates[0];
    byEmail.set(target.id, {
      ...target,
      quotaResetAt: legacyBlock.quotaResetAt,
      quotaMessage: legacyBlock.quotaMessage,
      quotaDetectedAt: legacyBlock.quotaDetectedAt
    });
  }
}

refreshButton.addEventListener("click", loadAccounts);
document.addEventListener("DOMContentLoaded", loadAccounts);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && (changes[STORAGE_KEYS.accounts] || changes[STORAGE_KEYS.activeAccountId])) {
    loadAccounts();
  }
});
