(() => {
  const chatEl = document.getElementById("chat");
  const composerEl = document.getElementById("composer");
  const inputEl = document.getElementById("input");
  const sendEl = document.getElementById("send");
  const newThreadEl = document.getElementById("newThread");

  const THREAD_KEY = "daemo.threadId";
  const threadIdState = {
    get() {
      return window.localStorage.getItem(THREAD_KEY) || "";
    },
    set(v) {
      if (!v) window.localStorage.removeItem(THREAD_KEY);
      else window.localStorage.setItem(THREAD_KEY, v);
    },
    clear() {
      window.localStorage.removeItem(THREAD_KEY);
    },
  };

  function nowTime() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function inlineFormat(value) {
    let formatted = value;
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    formatted = formatted.replace(/`([^`]+)`/g, "<code>$1</code>");
    return formatted;
  }

  function renderMarkdown(text) {
    const safe = escapeHtml(text);
    const lines = safe.split(/\r?\n/);
    const parts = [];
    let inOl = false;
    let inUl = false;

    const closeLists = () => {
      if (inOl) {
        parts.push("</ol>");
        inOl = false;
      }
      if (inUl) {
        parts.push("</ul>");
        inUl = false;
      }
    };

    for (const line of lines) {
      const olMatch = line.match(/^\s*(\d+)\.\s+(.*)$/);
      const ulMatch = line.match(/^\s*[-*]\s+(.*)$/);

      if (olMatch) {
        if (!inOl) {
          closeLists();
          parts.push("<ol>");
          inOl = true;
        }
        parts.push(`<li>${inlineFormat(olMatch[2])}</li>`);
        continue;
      }

      if (ulMatch) {
        if (!inUl) {
          closeLists();
          parts.push("<ul>");
          inUl = true;
        }
        parts.push(`<li>${inlineFormat(ulMatch[1])}</li>`);
        continue;
      }

      if (line.trim() === "") {
        closeLists();
        parts.push("<br>");
        continue;
      }

      closeLists();
      parts.push(`<p>${inlineFormat(line)}</p>`);
    }

    closeLists();
    return parts.join("");
  }

  function appendMessage(role, text, meta) {
    const row = document.createElement("div");
    row.className = `row ${role}`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (role === "assistant") {
      bubble.innerHTML = renderMarkdown(text);
    } else {
      bubble.textContent = text;
    }

    if (meta) {
      const metaEl = document.createElement("div");
      metaEl.className = "meta";
      metaEl.textContent = meta;
      bubble.appendChild(metaEl);
    }

    row.appendChild(bubble);
    chatEl.appendChild(row);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json && (json.error || json.errorMessage) ? json.error || json.errorMessage : "Request failed";
      throw new Error(msg);
    }
    return json;
  }

  function setBusy(isBusy) {
    sendEl.disabled = isBusy;
    inputEl.disabled = isBusy;
    newThreadEl.disabled = isBusy;
  }

  async function sendMessage() {
    const message = (inputEl.value || "").trim();
    if (!message) return;
    inputEl.value = "";

    appendMessage("user", message, nowTime());
    setBusy(true);

    try {
      const threadId = threadIdState.get() || undefined;
      const result = await postJson("/api/chat", { message, threadId });

      if (result && result.threadId) threadIdState.set(result.threadId);

      const responseText = result && typeof result.response === "string" ? result.response : "";
      const meta = result && typeof result.executionTimeMs === "number" ? `${nowTime()} • ${result.executionTimeMs}ms` : nowTime();

      appendMessage("assistant", responseText || "(no response)", meta);
    } catch (err) {
      appendMessage("assistant", `Error: ${err && err.message ? err.message : "Unknown error"}`, nowTime());
    } finally {
      setBusy(false);
      inputEl.focus();
    }
  }

  composerEl.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage();
  });

  newThreadEl.addEventListener("click", () => {
    threadIdState.clear();
    chatEl.innerHTML = "";
    appendMessage("assistant", "New chat started. How can I help?", nowTime());
    inputEl.focus();
  });

  appendMessage(
    "assistant",
    threadIdState.get()
      ? "Welcome back. Your previous thread is loaded (stored in localStorage)."
      : "Hello! Ask me about S3, EC2, or RDS. (This UI runs locally; your API key stays server-side.)",
    nowTime()
  );
})();

