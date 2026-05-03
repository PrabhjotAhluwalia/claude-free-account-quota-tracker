(() => {
  "use strict";

  /*
   * Claude changes DOM class names often. Keep edits here first:
   *
   * ACCOUNT_SELECTORS:
   *   Selectors that may contain the logged-in user's email/name. Good targets
   *   are profile menu buttons, account switcher menus, avatar buttons, and
   *   elements with stable data-testid/aria-label text.
   *
   * QUOTA_MESSAGE_SELECTORS:
   *   Selectors that may contain banners, toasts, alerts, modals, or composer
   *   notices. If Claude moves the quota text, inspect the element in DevTools
   *   and add one stable selector here.
   */
  const ACCOUNT_SELECTORS = [
    "[data-testid*='account' i]",
    "[data-testid*='profile' i]",
    "[data-testid*='user' i]",
    "[data-testid*='avatar' i]",
    "button[aria-label*='account' i]",
    "button[aria-label*='profile' i]",
    "button[aria-label*='user' i]",
    "button[aria-label*='settings' i]",
    "button[title*='account' i]",
    "button[title*='profile' i]",
    "[aria-label*='settings' i]",
    "[role='menu']",
    "[role='dialog']"
  ];

  const LOGGED_IN_HINT_SELECTORS = [
    "textarea",
    "div[contenteditable='true']",
    "[data-testid*='composer' i]",
    "[data-testid*='chat' i]",
    "a[href='/new']",
    "a[href*='/chat']"
  ];

  const QUOTA_MESSAGE_SELECTORS = [
    "[role='alert']",
    "[aria-live]",
    "[data-testid*='toast' i]",
    "[data-testid*='banner' i]",
    "[data-testid*='modal' i]",
    "[data-testid*='limit' i]",
    "[class*='toast' i]",
    "[class*='banner' i]",
    "[class*='modal' i]",
    "main",
    "body"
  ];

  const RATE_LIMIT_TEXT_PATTERNS = [
    /out of free messages/i,
    /out of messages/i,
    /free messages? (?:until|limit|used|remaining)/i,
    /message limit/i,
    /rate limit/i,
    /usage limit/i,
    /quota/i,
    /try again (?:at|after|in|later)/i,
    /resets? (?:at|on|in)/i,
    /available again/i
  ];

  const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const ACCOUNT_NAME_KEYS = new Set([
    "email",
    "username",
    "name",
    "displayName",
    "display_name",
    "preferredName",
    "preferred_name",
    "fullName",
    "full_name"
  ]);

  const STORAGE_KEYS = {
    accounts: "claudeAccounts",
    activeAccountId: "claudeActiveAccountId",
    lastQuotaEvent: "claudeLastQuotaEvent"
  };

  let lastQuotaSignature = "";
  let scanTimer = null;

  const storageGet = (keys) => chrome.storage.local.get(keys);
  const storageSet = (value) => chrome.storage.local.set(value);

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function safeTextFromElement(element) {
    const parts = [
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ];

    return normalizeWhitespace(parts.filter(Boolean).join(" "));
  }

  function accountIdFromCandidate(candidate) {
    if (candidate.email) {
      return candidate.email.toLowerCase();
    }

    return null;
  }

  function extractEmails(text) {
    return [...new Set((text.match(EMAIL_REGEX) || []).map((email) => email.toLowerCase()))];
  }

  function candidateFromText(text, source, score) {
    const cleanText = normalizeWhitespace(text);
    if (!cleanText) {
      return null;
    }

    const emails = extractEmails(cleanText);
    if (emails.length > 0) {
      return {
        email: emails[0],
        label: emails[0],
        source,
        score: score + 30
      };
    }

    const accountLabelPatterns = [
      /signed in as\s+(.+)/i,
      /logged in as\s+(.+)/i,
      /account\s*[:\-]\s*(.+)/i,
      /profile\s*[:\-]\s*(.+)/i,
      /user\s*[:\-]\s*(.+)/i,
      /^(.+?),\s*settings$/i
    ];

    for (const pattern of accountLabelPatterns) {
      const match = cleanText.match(pattern);
      if (match?.[1] && match[1].length <= 80) {
        return {
          username: match[1].trim(),
          label: match[1].trim(),
          source,
          score: score + 15
        };
      }
    }

    const planLabelMatch = cleanText.match(/(?:^|\b)([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4})\s+(?:Free|Pro|Max|Team|Enterprise)\s+plan\b/);
    if (planLabelMatch?.[1]) {
      return {
        username: planLabelMatch[1].trim(),
        label: planLabelMatch[1].trim(),
        source,
        score: score + 12
      };
    }

    return null;
  }

  function collectDomAccountCandidates() {
    const candidates = [];

    for (const selector of ACCOUNT_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        const candidate = candidateFromText(safeTextFromElement(element), `dom:${selector}`, 20);
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }

    return candidates;
  }

  function collectStorageAccountCandidates() {
    const candidates = [];
    const stores = [
      ["localStorage", window.localStorage],
      ["sessionStorage", window.sessionStorage]
    ];

    for (const [storeName, store] of stores) {
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        const value = store.getItem(key);
        const lowerKey = String(key || "").toLowerCase();
        const keyLooksRelevant = /user|account|profile|session|email|auth|identity|member/.test(lowerKey);

        if (value && value.length < 75000) {
          const emailCandidate = candidateFromText(value, `${storeName}:${key}`, keyLooksRelevant ? 45 : 10);
          if (emailCandidate?.email) {
            candidates.push(emailCandidate);
          }
        }

        if (value && keyLooksRelevant) {
          try {
            const parsed = JSON.parse(value);
            candidates.push(...collectJsonAccountCandidates(parsed, `${storeName}:${key}`, 60));
          } catch (_error) {
            // Storage entries are often plain strings. Ignore JSON parse misses.
          }
        }
      }
    }

    return candidates;
  }

  function collectJsonAccountCandidates(value, source, score, depth = 0) {
    if (!value || depth > 4) {
      return [];
    }

    if (typeof value === "string") {
      const candidate = candidateFromText(value, source, score);
      return candidate ? [candidate] : [];
    }

    if (Array.isArray(value)) {
      return value.flatMap((entry) => collectJsonAccountCandidates(entry, source, score - 5, depth + 1));
    }

    if (typeof value !== "object") {
      return [];
    }

    const candidates = [];
    let email = null;
    let username = null;
    let label = null;

    for (const [key, entry] of Object.entries(value)) {
      const keyName = key.replace(/[_-]/g, "");
      const stringEntry = typeof entry === "string" ? normalizeWhitespace(entry) : "";

      if (ACCOUNT_NAME_KEYS.has(key) || ACCOUNT_NAME_KEYS.has(keyName)) {
        const nestedCandidate = candidateFromText(stringEntry, `${source}.${key}`, score + 10);
        if (nestedCandidate?.email) {
          email = nestedCandidate.email;
        } else if (stringEntry && stringEntry.length <= 100) {
          username = username || stringEntry;
        }
      }

      if (/email/i.test(key) && stringEntry) {
        const emails = extractEmails(stringEntry);
        email = email || emails[0] || null;
      }

      if (/(name|username|display)/i.test(key) && stringEntry && stringEntry.length <= 100) {
        label = label || stringEntry;
      }

      candidates.push(...collectJsonAccountCandidates(entry, `${source}.${key}`, score - 4, depth + 1));
    }

    if (email || username || label) {
      candidates.push({
        email,
        username: username || label,
        label: email || label || username,
        source,
        score: score + (email ? 40 : 10)
      });
    }

    return candidates;
  }

  function appearsLoggedIn() {
    if (/\/(login|signin|signup|register)(?:\/|$)/i.test(window.location.pathname)) {
      return false;
    }

    return LOGGED_IN_HINT_SELECTORS.some((selector) => document.querySelector(selector));
  }

  async function detectActiveAccount() {
    if (!appearsLoggedIn()) {
      return null;
    }

    const candidates = [
      ...collectStorageAccountCandidates(),
      ...collectDomAccountCandidates()
    ].filter((candidate) => accountIdFromCandidate(candidate));

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const id = accountIdFromCandidate(best);

    return {
      id,
      email: best.email || null,
      username: best.username || null,
      label: best.label || best.email || best.username || id,
      source: best.source
    };
  }

  async function rememberActiveAccount(account) {
    if (!account?.id) {
      return null;
    }

    const now = Date.now();
    const existing = await storageGet([STORAGE_KEYS.accounts]);
    const accounts = existing[STORAGE_KEYS.accounts] || {};
    const previous = accounts[account.id] || {};
    const mergedAliasData = findMatchingUsernameAlias(accounts, account) || {};

    accounts[account.id] = {
      ...mergedAliasData,
      ...previous,
      id: account.id,
      email: account.email || previous.email || null,
      username: null,
      label: account.email || account.id,
      detectionSource: account.source || previous.detectionSource || "unknown",
      firstSeenAt: previous.firstSeenAt || mergedAliasData.firstSeenAt || now,
      lastSeenAt: now,
      lastUrl: window.location.href
    };

    removeUsernameAliases(accounts, account);

    await storageSet({
      [STORAGE_KEYS.accounts]: accounts,
      [STORAGE_KEYS.activeAccountId]: account.id
    });

    chrome.runtime.sendMessage({
      source: "claude-quota-tracker",
      type: "account-detected",
      accountId: account.id
    }).catch(() => {});

    return accounts[account.id];
  }

  async function getStoredActiveEmailAccount() {
    const data = await storageGet([STORAGE_KEYS.accounts, STORAGE_KEYS.activeAccountId]);
    const accounts = data[STORAGE_KEYS.accounts] || {};
    const activeAccountId = data[STORAGE_KEYS.activeAccountId];
    const activeAccount = activeAccountId ? accounts[activeAccountId] : null;

    if (activeAccount?.email || extractEmails(activeAccountId || "").length > 0) {
      return {
        ...activeAccount,
        id: activeAccountId,
        email: activeAccount.email || activeAccountId
      };
    }

    const emailAccounts = Object.values(accounts)
      .filter((account) => account.email || extractEmails(account.id || "").length > 0)
      .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));

    return emailAccounts[0] || null;
  }

  function normalizeAccountAlias(value) {
    return normalizeWhitespace(value).toLowerCase().replace(/^(dn|ns)\s+/, "");
  }

  function findMatchingUsernameAlias(accounts, account) {
    const aliases = new Set([
      normalizeAccountAlias(account.username),
      normalizeAccountAlias(account.label)
    ].filter(Boolean));

    for (const entry of Object.values(accounts)) {
      if (entry.email || !entry.id?.startsWith("username:")) {
        continue;
      }

      const entryAliases = [
        normalizeAccountAlias(entry.username),
        normalizeAccountAlias(entry.label),
        normalizeAccountAlias(entry.id.replace(/^username:/, ""))
      ];

      if (entryAliases.some((alias) => aliases.has(alias))) {
        return entry;
      }
    }

    return null;
  }

  function removeUsernameAliases(accounts, account) {
    const aliases = new Set([
      normalizeAccountAlias(account.username),
      normalizeAccountAlias(account.label)
    ].filter(Boolean));

    for (const [id, entry] of Object.entries(accounts)) {
      if (entry.email || !id.startsWith("username:")) {
        continue;
      }

      const entryAliases = [
        normalizeAccountAlias(entry.username),
        normalizeAccountAlias(entry.label),
        normalizeAccountAlias(id.replace(/^username:/, ""))
      ];

      if (entryAliases.some((alias) => aliases.has(alias))) {
        delete accounts[id];
      }
    }
  }

  function isRateLimitText(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized || normalized.length > 5000) {
      return false;
    }

    const hasLimitLanguage = RATE_LIMIT_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
    const hasResetTime = /(?:until|resets?|try again|available again|in)\b/i.test(normalized)
      && /(\d{1,2}(?::\d{2})?\s*(?:AM|PM|A\.M\.|P\.M\.)|tomorrow|today|\d+\s*(?:minutes?|mins?|hours?|hrs?))/i.test(normalized);

    return hasLimitLanguage && hasResetTime;
  }

  function scanForQuotaMessage() {
    const seen = new Set();
    const texts = [];

    for (const selector of QUOTA_MESSAGE_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element)) {
          continue;
        }

        seen.add(element);
        const text = safeTextFromElement(element);
        if (isRateLimitText(text)) {
          texts.push(text);
        }
      }
    }

    texts.push(...scanCompactTextNodesForQuota());
    texts.sort((a, b) => a.length - b.length);
    return texts[0] || null;
  }

  function scanCompactTextNodesForQuota() {
    const matches = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const text = normalizeWhitespace(node.nodeValue);
          if (!text || text.length < 12 || text.length > 300) {
            return NodeFilter.FILTER_REJECT;
          }

          if (!RATE_LIMIT_TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
            return NodeFilter.FILTER_REJECT;
          }

          const parent = node.parentElement;
          if (!parent || parent.closest("script, style, noscript")) {
            return NodeFilter.FILTER_REJECT;
          }

          const style = window.getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    while (walker.nextNode()) {
      const parentText = normalizeWhitespace(walker.currentNode.parentElement?.innerText || walker.currentNode.nodeValue);
      if (isRateLimitText(parentText)) {
        matches.push(parentText);
      }
    }

    return [...new Set(matches)];
  }

  function parseResetTimestamp(message, baseDate = new Date()) {
    const text = normalizeWhitespace(message);
    const lowerText = text.toLowerCase();

    const relativeMatch = lowerText.match(/\bin\s+(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h)\b/i);
    if (relativeMatch) {
      const amount = Number(relativeMatch[1]);
      const unit = relativeMatch[2].toLowerCase();
      const multiplier = unit.startsWith("h") ? 60 * 60 * 1000 : 60 * 1000;
      return baseDate.getTime() + amount * multiplier;
    }

    const explicitDate = parseExplicitDateWithTime(text, baseDate);
    if (explicitDate) {
      return explicitDate.getTime();
    }

    const weekdayDate = parseWeekdayWithTime(text, baseDate);
    if (weekdayDate) {
      return weekdayDate.getTime();
    }

    const clockMatch = text.match(/(?:until|resets?\s*(?:at|on)?|try again\s*(?:at|after|on)?|available again\s*(?:at|on)?)\s*(?:today\s*)?(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(AM|PM|A\.M\.|P\.M\.)/i)
      || text.match(/\b(\d{1,2})(?::(\d{2}))\s*(AM|PM|A\.M\.|P\.M\.)\b/i);

    if (!clockMatch) {
      return null;
    }

    const candidate = applyClockToDate(baseDate, clockMatch[1], clockMatch[2] || "00", clockMatch[3]);

    if (/\btomorrow\b/i.test(text) || candidate.getTime() <= baseDate.getTime() - 60 * 1000) {
      candidate.setDate(candidate.getDate() + 1);
    }

    return candidate.getTime();
  }

  function parseExplicitDateWithTime(text, baseDate) {
    const monthNames = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
    const monthPattern = new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?(?:\\s+at)?\\s+(\\d{1,2})(?::(\\d{2}))?\\s*(AM|PM|A\\.M\\.|P\\.M\\.)\\b`, "i");
    const monthMatch = text.match(monthPattern);

    if (monthMatch) {
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const monthIndex = months.findIndex((month) => monthMatch[1].toLowerCase().startsWith(month));
      const year = Number(monthMatch[3] || baseDate.getFullYear());
      const date = applyClockToDate(new Date(year, monthIndex, Number(monthMatch[2])), monthMatch[4], monthMatch[5] || "00", monthMatch[6]);

      if (!monthMatch[3] && date.getTime() <= baseDate.getTime() - 60 * 1000) {
        date.setFullYear(date.getFullYear() + 1);
      }

      return date;
    }

    const numericMatch = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM|A\.M\.|P\.M\.)\b/i);
    if (numericMatch) {
      const yearPart = numericMatch[3] ? Number(numericMatch[3]) : baseDate.getFullYear();
      const year = yearPart < 100 ? 2000 + yearPart : yearPart;
      const date = applyClockToDate(new Date(year, Number(numericMatch[1]) - 1, Number(numericMatch[2])), numericMatch[4], numericMatch[5] || "00", numericMatch[6]);

      if (!numericMatch[3] && date.getTime() <= baseDate.getTime() - 60 * 1000) {
        date.setFullYear(date.getFullYear() + 1);
      }

      return date;
    }

    return null;
  }

  function parseWeekdayWithTime(text, baseDate) {
    const match = text.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM|A\.M\.|P\.M\.)\b/i);
    if (!match) {
      return null;
    }

    const targetDay = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(match[1].toLowerCase());
    const date = applyClockToDate(baseDate, match[2], match[3] || "00", match[4]);
    let daysUntil = (targetDay - baseDate.getDay() + 7) % 7;

    if (daysUntil === 0 && date.getTime() <= baseDate.getTime() - 60 * 1000) {
      daysUntil = 7;
    }

    date.setDate(date.getDate() + daysUntil);
    return date;
  }

  function applyClockToDate(baseDate, hourText, minuteText, meridiemText) {
    let hours = Number(hourText);
    const minutes = Number(minuteText);
    const meridiem = meridiemText.replace(/\./g, "").toUpperCase();

    if (meridiem === "PM" && hours !== 12) {
      hours += 12;
    }

    if (meridiem === "AM" && hours === 12) {
      hours = 0;
    }

    const date = new Date(baseDate);
    date.setHours(hours, minutes, 0, 0);
    return date;
  }

  async function recordQuotaBlock(message) {
    const resetAt = parseResetTimestamp(message);
    if (!resetAt) {
      return;
    }

    const activeAccount = await detectActiveAccount();
    const rememberedAccount = activeAccount
      ? await rememberActiveAccount(activeAccount)
      : await getStoredActiveEmailAccount();
    const accountId = rememberedAccount?.id;
    const now = Date.now();

    const existing = await storageGet([STORAGE_KEYS.accounts]);
    const accounts = existing[STORAGE_KEYS.accounts] || {};

    if (accountId && accounts[accountId]) {
      accounts[accountId] = {
        ...accounts[accountId],
        quotaResetAt: resetAt,
        quotaMessage: message,
        quotaDetectedAt: now,
        lastSeenAt: now,
        lastUrl: window.location.href
      };
    }

    await storageSet({
      [STORAGE_KEYS.accounts]: accounts,
      [STORAGE_KEYS.lastQuotaEvent]: {
        accountId: accountId || null,
        message,
        resetAt,
        detectedAt: now,
        url: window.location.href
      }
    });

    chrome.runtime.sendMessage({
      source: "claude-quota-tracker",
      type: "quota-block-detected",
      accountId: accountId || null,
      resetAt
    }).catch(() => {});
  }

  async function scan() {
    try {
      const account = await detectActiveAccount();
      if (account) {
        await rememberActiveAccount(account);
      }

      const quotaMessage = scanForQuotaMessage();
      if (!quotaMessage) {
        return;
      }

      const resetAt = parseResetTimestamp(quotaMessage);
      const signature = `${quotaMessage}|${resetAt || "unknown"}`;

      if (resetAt && signature !== lastQuotaSignature) {
        lastQuotaSignature = signature;
        await recordQuotaBlock(quotaMessage);
      }
    } catch (error) {
      console.warn("[Claude Quota Tracker] Scan failed:", error);
    }
  }

  function scheduleScan(delay = 250) {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, delay);
  }

  function startObserver() {
    const observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "title", "data-testid", "class"]
    });

    scheduleScan(500);
    window.setInterval(() => scheduleScan(0), 15000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }
})();
