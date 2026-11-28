// SPDX-License-Identifier: GPL-3.0-or-later
// providers/openhands.js - the OpenHands Agent Canvas (app.all-hands.dev/canvas/) provider.
// Exports the same ZSProvider interface as providers/deepseek.js, gemini.js and
// glm.js; the core (core/main.js) is provider-agnostic. To DISABLE OpenHands
// support, remove this file from manifest.json (and its URL from background.js
// PROVIDER_URLS).
//
// OpenHands Canvas DOM notes (read from the shipped cloud bundle, 2026-11):
//  - React SPA served under the BASE PATH "/canvas" on the hosted app, so the
//    home/launcher screen is /canvas/ and a conversation is
//    /canvas/conversations/<uuid> (a launched-from-home conversation also uses
//    /canvas/conversations/task-<uuid> while the cloud task is provisioning).
//    A local standalone build runs the SAME components at "/". Selectors are
//    path-independent (data-testid), so both work; only isFreshChat()/
//    conversationKey() look at the pathname.
//  - ONE composer component serves every surface: a contentEditable div
//    `div[data-testid="chat-input"]` (class "chat-input", role="textbox",
//    data-placeholder "What do you want to build?"). It is NOT a <textarea>:
//    the app reads `chatInputRef.current.innerText` when submitting, so our
//    injection must produce REAL line breaks (<br>), not bare "\n" text - the
//    composer sets [white-space-collapse:inherit], which can collapse a text
//    node's newlines in innerText. We therefore rebuild the DOM (text nodes +
//    <br>) and fire a bubbling `input` event: the app's onInput -> syncCanSubmit
//    is what enables the send button, so without that event the click no-ops.
//  - Send: `button[data-testid="submit-button"]`, `disabled` until canSubmit.
//    Enter (no shift) also submits on desktop; Shift+Enter inserts a newline.
//    While the send is in flight the button's icon is swapped for
//    `[data-testid="submit-button-pending-icon"]` and the bubble below shows
//    data-pending-status="sending" ([data-testid="chat-message-sending"]).
//  - Stop: `button[data-testid="stop-button"]` exists ONLY while the agent state
//    is RUNNING (chat-input-actions.tsx -> AgentStatus). During sandbox/runtime
//    startup, INIT/LOADING and a reconnecting websocket the SAME slot renders
//    `[data-testid="agent-loading-spinner"]` instead. The two are mutually
//    exclusive, so "stop OR spinner" covers the whole turn - including the long
//    (30-120s) cloud runtime boot that has NO stop button and NO reply yet,
//    which is why the completion windows below stay wide.
//  - Turns: one React <article> per message - `article[data-testid="user-message"]`
//    (markdown bubble, line-clamped to 5 lines with a "View more" overlay, the
//    FULL text still in the DOM) and `article[data-testid="agent-message"]`
//    (both the action "thought" and the finalised message render through it).
//    The message list VIRTUALIZES past 150 rows, so absolute counts can drop -
//    every row wrapper carries data-row-key (single-*/thought-<id>/group-*),
//    which we expose as lastAssistantId() so turn identity survives it.
//  - Reasoning renders INSIDE the agent article as [data-testid="collapsible-
//    thinking"] (plus live-thinking/step-thinking/thinking-content while
//    streaming) and quotes the model's draft - every text read strips it, so a
//    command drafted in reasoning is never detected, shown or executed.
//  - Fenced code = CopyableContentWrapper: `div.relative` holding an absolute
//    `button[data-testid="copy-to-clipboard"]` and the <pre>/<div> code body
//    (react-syntax-highlighter keeps real "\n" text nodes, so textContent is the
//    verbatim source). Tool cards (Bash/file edits) are SEPARATE rows outside
//    the article, so the camouflage only ever meets the model's own text.
//  - Confirmation gate: when the agent waits for approval the composer is
//    DISABLED and `[data-testid="action-confirm-button"]` ("Yes, proceed")
//    appears. We deliberately do NOT click it - that is the user's sandbox, and
//    a stray approval could run a real command there. findContinueBtn() stays
//    null (see the note at its definition) so the core reports the parked turn
//    instead of pretending a complete reply was truncated.
//  - Attachments: an always-mounted hidden `input[data-testid="upload-image-input"]`
//    (multiple, accept */*). Setting .files + change runs the app's own pipeline
//    (use-chat-attachment-upload -> processImages), which converts the image
//    LOCALLY to a base64 data URL at send time - no CDN round-trip to wait for.
//    A staged chip is the composer card's <img src="blob:…">.
//  - HAZARD (why modeWarning exists): the same composer serves the Automations
//    flows too. On /canvas/automations/setup it is docked inside a surface whose
//    every testid is prefixed "automation-setup" (so that prefix gates the editor
//    off entirely - a send there creates an automation), and on the home screen
//    the "Code | Automate" pill (`[data-testid="home-launcher-mode-automate"]`,
//    aria-checked) routes the SAME composer's submit into automationSetup:true.
//    The pill is a user-visible toggle we must not click for them, so it is a
//    Start-time warning instead.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  const S = {
    userItem: 'article[data-testid="user-message"]',
    assistantItem: 'article[data-testid="agent-message"]',
    anyItem: 'article[data-testid="user-message"], article[data-testid="agent-message"]',
    thinking: [
      '[data-testid="collapsible-thinking"]',
      '[data-testid="live-thinking"]',
      '[data-testid="step-thinking"]',
      '[data-testid="thinking-content"]',
    ].join(","),
    editor: '[data-testid="chat-input"], div.chat-input[contenteditable="true"]',
    // The rounded composer CARD (ChatInputContainer: "bg-surface … rounded-composer").
    // The editor is a single line inside it, the controls row (attach / model
    // picker / send) sits below it in the same card.
    card: "div.rounded-composer",
    // Everything in a turn's bubble that is CHROME rather than message text. The
    // copy button must NOT be in here (it lives inside the code wrapper we hide);
    // these are the pieces that would otherwise prefix/pollute the parsed text:
    // "Just now" timestamps (absolute, but its text is always in the DOM), the
    // hover action bar, reaction counters, the "View more" label of a clamped
    // user bubble, the "Sending…"/"Failed to send" captions and image thumbnails.
    chrome: [
      '[data-testid="message-timestamp"]',
      '[data-testid="message-reactions"]',
      '[data-testid="message-edits"]',
      '[data-testid="chat-message-view-more"]',
      '[data-testid="chat-message-truncation-gradient"]',
      '[data-testid="chat-message-expand"]',
      '[data-testid="chat-message-sending"]',
      '[data-testid="chat-message-error"]',
      '[data-testid="chat-message-stop"]',
      '[data-testid="image-carousel"]',
      '[data-testid="image-preview"]',
      // The absolute hover bar (copy / branch / actions) on a bubble.
      'article > div.absolute',
    ].join(","),
    sendBtn: '[data-testid="submit-button"]',
    pendingIcon: '[data-testid="submit-button-pending-icon"]',
    stopBtn: '[data-testid="stop-button"]',
    spinner: '[data-testid="agent-loading-spinner"]',
    confirmBtn: '[data-testid="action-confirm-button"]',
    fileInput: 'input[type="file"][data-testid="upload-image-input"]',
    copyCodeBtn: '[data-testid="copy-to-clipboard"]',
    codeWrap: "div.relative",
    rowKey: "[data-row-key]",
    automation: '[data-testid^="automation-setup"]',
    // The home launcher's mode pill (Code | Automate). With "Automate" checked the
    // launcher still CREATES a conversation but flags it automationSetup:true and
    // hands the user straight to the automation editor - so the message becomes an
    // automation's prompt, not a chat turn.
    launchAutomate: '[data-testid="home-launcher-mode-automate"][aria-checked="true"]',
    // Banners that mean "this conversation cannot act right now", plus the
    // generic alert surfaces (sonner toasts, React-aria live regions).
    errorSurfaces: [
      '[data-testid="error-message-banner"]',
      '[data-testid="archived-conversation-banner"]',
      '[data-testid="resolved-conversation-banner"]',
      '[data-testid="home-llm-not-configured-banner"]',
      '[data-testid="skill-install-restart-banner"]',
      '[role="alert"]',
      "[data-sonner-toast]",
    ].join(","),
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|length|exceeded)",
        "maximum.{0,20}(context|tokens|length)",
        "(token|context).{0,10}limit",
        "please.{0,30}(start|create).{0,20}(new|fresh).{0,20}(chat|conversation)",
        "\\u4e0a\\u4e0b\\u6587.{0,10}(\\u8d85\\u51fa|\\u8fc7\\u957f|\\u9650\\u5236)",
      ].join("|"),
      "i"
    ),
    tooLong: /(conversation|context).{0,24}(too long|too large|exceeded)|start a new (chat|conversation)/i,
    busy: /try again later|something went wrong|temporarily (unavailable|unreachable)|rate.?limit|server is busy|\\u8bf7\\u7a0d\\u540e\\u518d\\u8bd5/i,
    // "Read-only" states: the site says so in a banner, and the composer is gone.
    readOnly: /read-only|archived|closed|resolved/i,
  };

  // Canvas needs the WIDEST windows in the family: a cloud conversation boots a
  // sandbox + runtime (30-120s) before the model even starts, and between its own
  // tool calls the agent's reply text can freeze for tens of seconds while the run
  // is still live. The stop-button/spinner signals carry those gaps; the numbers
  // bound them so a wedged run still resolves.
  const timings = {
    GEN_IDLE_MS: 2000,
    REASON_IDLE_MS: 15000,
    WARMUP_MS: 90000,
    REASON_NOREPLY_MS: 180000,
    STABLE_MS: 15000,
    RESPONSE_TIMEOUT_MS: 420000,
  };

  // ── DOM primitives ────────────────────────────────────────────────────────
  // Skip Studio Agent's own injected UI: on a page with no site composer (login,
  // settings) an unscoped match would find our #zs-set-text textarea and defeat
  // the "not on a chat page" guards in the send hooks.
  const q = (sel, root) => [...(root || document).querySelectorAll(sel)].filter((n) => !n.closest("#zs-root"));
  const q1 = (sel, root) => q(sel, root)[0] || null;

  const isUserItem = (item) => !!item && item.matches && item.matches(S.userItem);
  const isAssistantItem = (item) => !!item && item.matches && item.matches(S.assistantItem);

  // Walk an element's text, skipping the reasoning subtree, our chip, the
  // bubble's chrome and any extra exclusion. `<br>` becomes "\n" (the message
  // body is rendered markdown, where <br> IS a line break), and a block element
  // that the renderer uses as a paragraph/list item contributes a "\n" after it -
  // without that the fenced JSON would collapse onto one line and ZSParse's
  // line-oriented markers (###LUA### … ###END_LUA###) would never match.
  const BLOCK = "P,DIV,LI,BLOCKQUOTE,PRE,CODE,TR,H1,H2,H3,H4,UL,OL,SECTION,ARTICLE";
  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = S.thinking + ", .zs-chip, " + S.chrome + (excludeSel ? ", " + excludeSel : "");
    let out = "";
    const push = (s) => { out += s; };
    const walk = (n, inPre) => {
      if (n.nodeType === 3) { push(inPre ? n.nodeValue : n.nodeValue.replace(/\s+/g, " ")); return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      const tag = n.tagName;
      if (tag === "BR") { push("\n"); return; }
      const isBlock = !inPre && n.matches && n.matches(BLOCK);
      if (tag === "PRE" || tag === "CODE") inPre = true;
      if (isBlock && out && !out.endsWith("\n")) push("\n");
      for (const c of n.childNodes) walk(c, inPre);
      if (isBlock && out && !out.endsWith("\n")) push("\n");
    };
    walk(root, false);
    return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  const itemText = (item) => textWithout(item);
  const classifyText = (item, excludeSel) => textWithout(item, excludeSel);

  const allItems = () => q(S.anyItem);
  const assistantItems = () => q(S.assistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => q(S.userItem).length;

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  // Row identity: the message list keys every row wrapper with data-row-key
  // (single-<stepKey> / thought-<actionId> / group-<key>), and that wrapper keeps
  // its key across list virtualisation and streaming re-renders. null (NOT
  // undefined) when the row carries no key - the core then falls back to counts.
  function itemIdOf(item) {
    let n = item;
    while (n && n !== document.body) {
      const k = n.dataset && n.dataset.rowKey;
      if (k) return k;
      n = n.parentElement;
    }
    return null;
  }
  const lastAssistantId = () => {
    const it = lastAssistant();
    return it ? itemIdOf(it) : null;
  };

  // ── Composer ──────────────────────────────────────────────────────────────
  const getEditor = () => {
    for (const e of q(S.editor)) {
      // Never the Automations composer (submitting there CREATES AN AUTOMATION).
      if (e.closest(S.automation)) continue;
      // Skip a composer inside a modal (e.g. the "run automation" prompt dialog).
      const dlg = e.closest('[role="dialog"], [role="alertdialog"]');
      if (dlg) continue;
      return e;
    }
    return null;
  };
  const composerCard = () => {
    const ed = getEditor();
    if (!ed) return null;
    return ed.closest(S.card) || ed.closest("[data-testid='interactive-chat-box']") || (ed.parentElement ? ed.parentElement.parentElement : null);
  };
  // The composer's text, with `<br>` line breaks re-materialised as "\n".
  // innerText would be the natural read but returns "" in a HIDDEN tab (no
  // layout) - which the core's send/landed checks rely on - so walk the DOM.
  function editorText() {
    const ed = getEditor();
    if (!ed) return "";
    return textWithout(ed) || (ed.value != null ? ed.value : "");
  }
  // Raw (newline-preserving) content of the composer for the write-back check.
  function composerLines() {
    const ed = getEditor();
    if (!ed) return "";
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.tagName === "BR") { t += "\n"; return; }
      for (const c of n.childNodes) walk(c);
    };
    walk(ed);
    return t;
  }

  const chatIsEmpty = () => allItems().length === 0;
  // The Canvas home / launcher screen - a real conversation always sits under
  // /conversations/<id>, so "no id in the path" + composer + no turns == fresh.
  const convPathRe = /\/conversations\/[^/?#]+/;
  const isFreshChat = () => !convPathRe.test(location.pathname) && chatIsEmpty() && !!getEditor();

  // The composer box the "Agent is working…" cover blankets as one unit.
  const composerFrame = () => composerCard();
  // Cover the whole card (input line + controls row) so a click behind the
  // cover cannot focus the editor or hit the site's own send button mid-injection.
  const coverTarget = () => composerCard() || getEditor();
  // A card grown by a multi-line injection can pass the core's 200px clamp.
  const coverMaxH = 320;

  // Integrated status bar (same approach as GLM/Kimi): React reconciles the
  // composer subtree, so we must NOT insert our #zs-bar into the card. barAnchor()
  // returns the card and the core's anchored branch keeps the bar in #zs-root,
  // hugs its top edge at full width and reserves the strip with padding-top.
  function barAnchor() {
    const card = composerCard();
    return card && card.getBoundingClientRect ? card : null;
  }

  // ── Input lock ────────────────────────────────────────────────────────────
  // A contentEditable has no `readonly`: the site's own disabled state is
  // contentEditable=false (chat-input-field.tsx), so lock the same way. React
  // only writes that attribute when the component's `disabled` PROP changes, so
  // our mutation survives a re-render - but a remount recreates the node, hence
  // enforceComposer() re-asserts it on every sweep.
  let locked = false;
  function applyLock(on) {
    const ed = getEditor();
    if (!ed) return;
    if (on) {
      ed.setAttribute("contenteditable", "false");
      ed.setAttribute("aria-disabled", "true");
      ed.dataset.zsLock = "1";
    } else {
      ed.setAttribute("contenteditable", "true");
      ed.removeAttribute("aria-disabled");
      delete ed.dataset.zsLock;
    }
  }
  function setInputLock(on) {
    locked = !!on;
    applyLock(locked);
  }

  // ── Send / stop buttons ────────────────────────────────────────────────────
  const sendButton = () => q1(S.sendBtn, composerCard() || document);
  const stopButton = () => q1(S.stopBtn, composerCard() || document);
  const loadingSpinner = () => q1(S.spinner, composerCard() || document);
  const sendPending = () => !!q1(S.pendingIcon, composerCard() || document);

  // ── Generation detection ──────────────────────────────────────────────────
  function streamText(item) {
    if (!item) return "";
    const think = item.querySelector(S.thinking);
    return (think ? think.textContent || "" : "") + "\n" + textWithout(item);
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  // The stop button (RUNNING) and the loading spinner (INIT/LOADING/connecting)
  // are rendered in the SAME slot of AgentStatus, mutually exclusively, and
  // together span the whole turn - including the runtime boot with no reply yet.
  // The growth tail only covers the instant right after both clear.
  function genActive() {
    sampleStream();
    if (stopButton() || loadingSpinner()) return true;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  // Sending is blocked ONLY by a live agent run (the site itself disables the
  // submit button then). The spinner must NOT gate a send: our first send happens
  // while the app is still connecting, and OpenHands queues follow-ups anyway.
  const isBusyNow = () => !!stopButton();
  const isHardGenerating = () => !!stopButton();

  // Which sub-signal latched isGenerating - surfaced in the core's chip.why diag
  // so a "chip shows done while the model is still writing" report can be read.
  // `gate` is the OpenHands approval prompt: with it up the composer is disabled,
  // which is what makes a send fail without an error anywhere in the DOM.
  const genDebug = () => {
    sampleStream();
    return {
      stop: !!stopButton(),
      spin: !!loadingSpinner(),
      pending: sendPending(),
      gate: !!q1(S.confirmBtn),
      grewMs: _streamMax > 1 ? Date.now() - _streamAt : -1,
    };
  };

  // Canvas exposes no per-turn "stopped" marker → never halted by the site, and
  // no native "Continue" affordance for a truncated reply either (the model's
  // output is not length-capped by the site). Both must stay empty: the core reads
  // a non-null findContinueBtn() as "this reply was cut off, click to resume", so
  // returning OpenHands' `[data-testid="action-confirm-button"]` there would both
  // mis-classify a COMPLETE reply as truncated AND silently approve a sandbox tool
  // call the user never asked for. When that approval gate is up the site also
  // DISABLES its own composer, so a feedback send simply does not land and the
  // core's honest "Message could not be sent" banner tells the user to act in the
  // chat themselves - which is exactly what an agent approval needs.
  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const think = it.querySelector(S.thinking);
      return {
        th: think ? (think.textContent || "").trim().length : 0,
        rp: textWithout(it).length,
      };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const think = item.querySelector(S.thinking);
    return {
      present: true,
      reply: textWithout(item).trim(),
      thinking: think ? (think.textContent || "").trim() : "",
      item,
    };
  }

  // A command-shaped reply is still being written while the run is live (the
  // agent streams into the SAME article, and the row can also be re-created at
  // the markdown settle). Hold the parse verdict - bounded by the core's
  // UNSETTLED_GRACE_MS so a genuinely stuck read still resolves.
  function replyUnsettled(item) {
    if (!item || item !== lastAssistant()) return false;
    sampleStream();
    return !!(stopButton() || loadingSpinner() || grewWithin(timings.GEN_IDLE_MS));
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // ── Sending ─────────────────────────────────────────────────────────────────
  // Rebuild the composer's content as text nodes + <br>, then fire the input
  // event the app's onInput handler needs (it re-derives canSubmit from
  // innerText, and until it does, submit-button stays `disabled` and a click
  // silently no-ops). replaceChildren() wipes any restored draft first, so an
  // injection can never append to leftover text.
  function setComposerText(text) {
    const ed = getEditor();
    if (!ed) return false;
    const lines = String(text).split("\n");
    const frag = document.createDocumentFragment();
    lines.forEach((line, i) => {
      if (i) frag.appendChild(document.createElement("br"));
      if (line) frag.appendChild(document.createTextNode(line));
    });
    try { ed.replaceChildren(frag); } catch { ed.textContent = String(text); }
    fireInput(ed);
    return true;
  }
  function fireInput(ed) {
    let ev;
    try {
      ev = new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: "" });
    } catch {
      ev = new Event("input", { bubbles: true, cancelable: true });
    }
    ed.dispatchEvent(ev);
  }

  function clickSendButton() {
    if (isBusyNow()) return false;
    const btn = sendButton();
    if (btn && !btn.disabled) { try { btn.click(); return true; } catch { return false; } }
    return false;
  }

  async function typeAndSend(text, images) {
    const editor = getEditor();
    if (!editor) throw new Error("OpenHands Canvas input box not found");
    // Injection needs an editable node: the loop locks the composer (setInputLock)
    // while it works, so unlock for the write and re-lock afterwards (like the
    // Quill/Lexical providers on Gemini/Kimi).
    const relock = locked || editor.getAttribute("contenteditable") === "false";
    if (relock) editor.setAttribute("contenteditable", "true");
    try {
      try { editor.focus({ preventScroll: true }); } catch { try { editor.focus(); } catch {} }
      setComposerText(text);
      // Attach images LAST, right before the send click - see gemini.js's
      // typeAndSend for why (attaching before retyping the text can sever the
      // site's binding between the pending upload and the message being sent).
      // submitAndGetBase RETRIES this function; only attach if nothing is staged
      // yet, else each retry uploads ANOTHER duplicate copy.
      if (images && images.length && !hasPendingAttachment()) {
        try { await attachImages(images); } catch {}
        // Re-assert the text: a staged upload re-renders the composer card.
        if (composerLines() !== String(text)) setComposerText(text);
      }
      // Wait for React to re-enable the send button (proof it registered the
      // text), re-nudging every ~700ms: a long conversation re-renders the whole
      // list, and one input event can be processed before our node is read.
      let lastNudge = Date.now();
      const enabled = await waitFor(() => {
        const b = sendButton();
        if (b && !b.disabled) return true;
        if (Date.now() - lastNudge > 700) {
          lastNudge = Date.now();
          if (composerLines() !== String(text)) setComposerText(text);
          else { const e2 = getEditor(); if (e2) fireInput(e2); }
        }
        return false;
      }, 8000);
      diag("openhands.send", { enabled, busy: isBusyNow() });
      if (!clickSendButton() && !isBusyNow()) {
        // Enter is the site's own submit path (handleKeyDown -> handleSubmit), so
        // it works even if the button match ever changes.
        const e2 = getEditor();
        if (e2) {
          const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
          e2.dispatchEvent(new KeyboardEvent("keydown", o));
          e2.dispatchEvent(new KeyboardEvent("keyup", o));
        }
      }
    } finally {
      if (relock) {
        const e3 = getEditor();
        if (e3) e3.setAttribute("contenteditable", "false");
      }
    }
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) { try { b.click(); return; } catch {} }
    // Nothing to stop yet (runtime boot): a pending send can still be aborted from
    // its own bubble while the message is "sending".
    const p = q1('[data-testid="chat-message-stop"]');
    if (p) { try { p.click(); } catch {} }
  }

  // ── Composer state / modes ────────────────────────────────────────────────
  // Nothing to force (the agent profile / model picker is the user's choice), but
  // keep the lock glued to the live node and dismiss a dangling slash/mention
  // menu: the injected text can start with a token the site treats as a command
  // (our system prompt never does, but a user's "list_commands" follow-up could).
  function enforceComposer() {
    const ed = getEditor();
    if (locked && ed && ed.getAttribute("contenteditable") !== "false") {
      ed.setAttribute("contenteditable", "false");
    }
    return { ready: !!ed };
  }
  async function ensureComposerReady(reason) {
    diag("mode_ready", { reason, provider: "openhands" });
    return { ready: !!getEditor() };
  }

  // Plan mode only writes a plan document (and the agent cannot run tools), the
  // Automations surfaces send to the WRONG endpoint, and a read-only
  // conversation has no composer at all. Warn before a session starts; the core
  // disables the Start button on a non-empty warning.
  // Plan is DOM-visible two ways, and we accept either: the amber composer
  // border (the #597FF4 class token) and the swapped data-placeholder ("Let's
  // work on a plan" - i18n COMMON$LET_S_WORK_ON_A_PLAN). Since the 2026-11
  // redesign Plan is no longer a launcher pill: it is a per-conversation toggle
  // (composer overflow menu -> Plan, testids "overflow-agent-plan" /
  // "plan-option") or the /plan skill, so it can also flip MID-session - hence
  // inPlanMode() is checked from scanError too, not only at Start.
  function inPlanMode() {
    const card = composerCard();
    const ed = getEditor();
    return (!!card && /597FF4/.test(card.className || "")) ||
           (!!ed && /plan/i.test(ed.getAttribute("data-placeholder") || ""));
  }

  function modeWarning() {
    if (q1(S.launchAutomate)) {
      return "OpenHands Canvas is in “Automate” mode: your message would become an " +
             "automation's prompt instead of a chat. Click “Code” above the input, then Start.";
    }
    if (q1(S.automation)) {
      return "This is the OpenHands Automations composer, not a chat. Start a " +
             "normal conversation at app.all-hands.dev/canvas/ and run Studio Agent there.";
    }
    if (inPlanMode()) {
      return "OpenHands Canvas is in Plan mode, which only writes a plan and never " +
             "runs tools. Switch the composer to Code mode, then Start.";
    }
    return "";
  }

  // A modal (login / manage backends / open-repository / image lightbox) sits
  // over the composer: hide the bar and the cover so neither swallows its clicks.
  function overlayBlocking() {
    for (const d of document.querySelectorAll('[role="dialog"],[role="alertdialog"]')) {
      if (d.closest("#zs-root")) continue;
      if (d.offsetParent === null && getComputedStyle(d).position !== "fixed") continue;
      const ed = getEditor();
      if (ed && d.contains(ed)) continue; // a dialog WRAPPING the composer is the surface itself
      return true;
    }
    return false;
  }
  // Cloud Canvas sits behind Cloudflare on some flows; a challenge iframe would
  // otherwise make the loop type into a wall.
  function captchaPresent() {
    return !!document.querySelector(
      'iframe[title*="Cloudflare" i],iframe[src*="challenges.cloudflare.com"],#cf-challenge,.cf-turnstile'
    );
  }

  // ── Error / limit detection (site chrome only) ────────────────────────────
  function scanError() {
    try {
      for (const el of q(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.anyItem)) continue; // model content, not UI chrome
        const t = (el.innerText || el.textContent || "").trim();
        if (t.length < 6 || t.length > 900) continue;
        if (RE.contextLimit.test(t) || RE.readOnly.test(t) || /failed|error|denied|unauthor|expired|not configured|offline/i.test(t)) {
          return t.slice(0, 240);
        }
      }
    } catch {}
    if (!getEditor()) {
      return chatIsEmpty()
        ? "The OpenHands Canvas composer is not on this page - open a chat at " +
          "https://app.all-hands.dev/canvas/ (a sign-in page or a settings tab has no input box)."
        : "The input box disappeared (session ended or the conversation was closed).";
    }
    // Plan can be toggled mid-session (composer menu or the /plan skill); a turn
    // spent there ends in a planning document, never a Studio command - abort
    // with a clear reason instead of timing out.
    if (inPlanMode()) {
      return "OpenHands switched this chat to Plan mode: it will only write a plan " +
             "and never run the Studio commands. Switch the composer back to Code " +
             "(the overflow menu on the input card), then send again.";
    }
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // ── Image attachment (best effort) ────────────────────────────────────────
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `studio_agent_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  // Staged chips live in the composer card's UploadedFiles row. A ready image chip
  // renders <img src="blob:…"> (the app makes the object URL from the PROCESSED
  // file), while the same slot shows a spin loader until processing finishes -
  // so counting blob imgs is both "pending" and "ready" in one read. Scoping to
  // the card excludes images already in the history, which would otherwise make
  // the next capture skip its attach (the 2nd-capture bug seen on Kimi).
  const stagedImgs = () => {
    const card = composerCard();
    return card ? [...card.querySelectorAll('img[src^="blob:"]')] : [];
  };
  const hasPendingAttachment = () => stagedImgs().length > 0;
  const attachmentReady = (want) => stagedImgs().length >= (want || 1);

  async function attachImages(images) {
    if (!images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    const fileInput = q1(S.fileInput) || q1('input[type="file"]');
    if (!fileInput) { diag("attach.noFileInput"); return false; }
    diag("attach.setFiles", { count: dt.items.length });
    try { fileInput.files = dt.files; fileInput.dispatchEvent(new Event("change", { bubbles: true })); }
    catch (e) { diag("attach.setFilesThrew", { msg: String((e && e.message) || e) }); return false; }
    const ok = await waitFor(() => attachmentReady(dt.items.length), 30000);
    diag("attach.uploadDone", { ok });
    return ok;
  }
  function clearAttachments() {
    try {
      for (const im of stagedImgs()) {
        const chip = im.closest("div.group") || im.parentElement;
        if (!chip) continue;
        const btns = [...chip.querySelectorAll("button")];
        // The remove control is the aria-labelled "Remove image"; the other button
        // in the chip is the "upload as file" toggle, which must NOT be clicked (it
        // would demote the image to a file link and the model would lose the pixels).
        const rm = btns.find((b) => /remove/i.test(b.getAttribute("aria-label") || "")) || btns[0];
        if (rm) try { rm.click(); } catch {}
      }
    } catch {}
  }

  // /canvas/conversations/<uuid> = a real conversation. The launcher screen has
  // no id yet → "" (transient) so the core never persists it as "started".
  const conversationKey = () => (convPathRe.test(location.pathname) ? location.pathname : "");

  // ── User-send interception ────────────────────────────────────────────────
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const ed = getEditor();
        if (!ed || !ed.contains(e.target)) return;
        if (editorText().trim() === "") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return; // existing conversation → not ours to gate
          handlers.onBlockedAttempt(); // nudge only; never block plain chat
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        if (!e.isTrusted) return; // user-intent spy: our own programmatic .click() calls must not read as user actions
        const t = e && e.target;
        if (!t || !t.closest) return;
        // The site's own stop = a deliberate manual stop.
        const stop = t.closest(S.stopBtn);
        if (stop) { handlers.onNativeStop(); return; }
        const ed = getEditor();
        if (!ed) return;
        const btn = t.closest(S.sendBtn);
        if (!btn) return;
        if (btn.disabled) return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt(); // nudge only; never block plain chat
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool-block location for camouflage ────────────────────────────────────
  // Each fenced block is an atomic `div.relative` (CopyableContentWrapper) whose
  // first child is the absolute copy button and whose remaining child is the code
  // body; React re-creates that subtree on every streamed token and again at the
  // markdown settle, so like Gemini/GLM we ALSO mark the turn root with
  // .zs-cmd-mask and let overlay.css re-hide recreated blocks with zero flash.
  // The article keeps its identity across those re-renders (it is the row's own
  // child, keyed by data-row-key), which is what makes the mask stick.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item /*, chip */) {
    if (!item) return null;
    let hidAny = null;
    // 1. Fenced code blocks carrying a command (skip ones inside the reasoning).
    // The SAME `[data-testid="copy-to-clipboard"]` control is also the bubble's
    // hover "Copy" button, whose nearest `div.relative` ancestor is the ARTICLE
    // itself - hiding that would hide the whole reply along with its chip. So a
    // candidate wrapper must (a) not be the turn root and (b) actually contain a
    // code body.
    for (const cc of item.querySelectorAll(S.copyCodeBtn)) {
      if (cc.closest(S.thinking)) continue;
      const wrap = cc.closest(S.codeWrap);
      // closest() can walk OUT of the turn (a copy button with no code wrapper of
      // its own) up to the chat panel's own div.relative - hiding that blanked the
      // whole conversation and the composer. Only a wrapper INSIDE the turn counts.
      if (!wrap || wrap === item || !item.contains(wrap) || wrap.closest(".zs-chip")) continue;
      if (!wrap.querySelector("pre, code")) continue;
      if (CMD_SHAPE.test(wrap.textContent || "")) {
        wrap.classList.add("zs-tool-hide");
        item.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: wrap.parentElement, ref: wrap };
      }
    }
    // 2. Stray BARE command text: OpenHands writes its own <p> lines, so a model
    // that skips the fence (###LUA### as prose, or inline {"command": …}) would
    // flash raw. Catch a short top-level block that is command-shaped and has no
    // code wrapper of its own.
    [...item.children].forEach((el) => {
      if (el.classList.contains("zs-chip") || el.classList.contains("zs-tool-hide") ||
          el.closest(S.thinking) || el.querySelector(S.copyCodeBtn)) return;
      const t = el.textContent || "";
      if (t.length < 600 && CMD_SHAPE.test(t)) {
        el.classList.add("zs-tool-hide");
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });
    return hidAny;
  }

  // Canvas pitfall the generic prompt cannot know about: this agent HAS real
  // tools of its own (Bash, file editor, task tracker), and they look like a
  // tempting way to "run" something - they run in the sandbox, never in Studio.
  const PROMPT_EXTRA =
    "- HOW THIS PAGE WORKS: OpenHands renders your reply as Markdown, and its own tools (Bash, file editor, task tracker / planner) run inside the sandboxed runtime - " +
    "writing a Studio Agent command with one of those tools, or saving it to a file, executes NOTHING for the user. A Studio Agent command only runs when the command text is in the " +
    "MESSAGE you send back here, inside a fenced code block, exactly as the instructions show. Never wrap it in a tool call, a JSON payload, a plan document or a Markdown table, " +
    "and never put it only in your reasoning - this extension reads only the visible reply text. " +
    "- Do not open a plan/todo list or ask for approval to run a Studio Agent command: write the command and this extension runs it, then returns the result to you in the next message.";

  return {
    id: "openhands",
    displayName: "OpenHands",
    // The Canvas composer accepts any file and embeds images as base64 in the
    // message (use-chat-attachment-upload -> processImages -> MessageEvent image
    // content blocks), so screen_capture is exposed here (main.js BLOCKED_TOOLS
    // gate). Whether the model actually SEES the pixels depends on the LLM the
    // user configured in Canvas - a non-vision model gets the file, not the
    // image. Verify with provider-test-checklist step 9 (incl. two captures in a
    // row) and flip to false if a live read fails.
    supportsVision: true,
    timings,
    // Reasoning-area selector, exported so the CORE's raw-command-visible probes
    // exclude it: Canvas renders the model's thinking inside the turn
    // (collapsible-thinking / live-thinking) and quotes the command JSON there,
    // which the camouflage never hides - without this the core would read it as
    // "raw block still visible" forever and flap the chip done→run→done.
    thinkingSel: S.thinking,
    // React re-renders the article's children on every streamed token, wiping any
    // chip placed inside them - anchor chips at the turn (article) level.
    chipAtItemLevel: true,
    // Canvas writes its narration, then the tool call at the END of the turn, so
    // trail the chip after the reply text instead of pinning it first. The
    // article's own trailing children are the (absolute) timestamp, so no
    // chipTrailRef is needed - "last child" already reads correctly.
    chipAppend: true,
    // Rows carry data-row-key, so the watcher can refuse to finalise before this
    // send's reply exists even though the list virtualizes past 150 rows.
    reliableCounts: true,
    // Bubbles have copy / "Branch from here" / reactions but NO regenerate.
    hasRegenerate: false,
    init({ diag: d } = {}) { if (d) diag = d; },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey: itemIdOf, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    coverTarget, coverMaxH,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, genDebug, replyUnsettled,
    enforceComposer, ensureComposerReady, modeWarning, captchaPresent, overlayBlocking,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
    promptExtra: PROMPT_EXTRA,
  };
})();
