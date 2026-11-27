// Quick Node smoke test for providers/openhands.js (run: node test-openhands.js).
// Not shipped.
//
// Why this exists: the OpenHands Canvas provider is written against a DOM we
// cannot log into and check live (app.all-hands.dev needs a GitHub/GitLab/Bitbucket
// session), so every selector came out of the shipped bundle + the OpenHands
// frontend source. That makes the READING side the risky part - Canvas renders a
// reply as React markdown (paragraphs, <br>, a highlighter <code>, an absolute
// copy button, a hover bar, a "View more" caption, collapsible reasoning), and a
// single collapsed newline or a stray chrome label glued onto the fenced block
// makes ZSParse miss the command entirely. It also makes the WRONG hide easy:
// the bubble's own "Copy" button shares `[data-testid="copy-to-clipboard"]` with
// a code block's, so a careless closest("div.relative") hides the whole reply.
//
// The provider is a browser IIFE, so it is evaluated here against a stub DOM with
// a mini selector engine - just enough of `matches`/`closest`/`querySelectorAll`
// semantics for the real selectors to be exercised. No jsdom, no npm install: the
// repo has no dependencies and this test keeps it that way.
const fs = require("fs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, checks = 0;
// DOM stubs are cyclic, so never JSON.stringify one blindly.
const show = (v) => {
  if (v && typeof v === "object") {
    if (v.nodeType === 1) return "<" + v.tagName.toLowerCase() + " " + (v.getAttribute("data-testid") || v.className || "") + ">";
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return JSON.stringify(v);
};
function ok(cond, label, extra) {
  checks++;
  if (cond) { console.log("  ok   " + label); return; }
  fails++;
  console.log("  FAIL " + label + (extra === undefined ? "" : "  → " + show(extra)));
}
function eq(actual, expected, label) {
  ok(actual === expected, label, actual === expected ? undefined : { expected: show(expected), actual: show(actual) });
}

// ── mini selector engine ─────────────────────────────────────────────────────
// Supports the subset the provider actually uses: comma lists; descendant and
// ">" combinators; compound selectors made of a tag name, .class, [attr],
// [attr="v"], [attr^="v"], [attr*="v"].
function splitTop(str, sepRe) {
  const out = []; let cur = "", depth = 0;
  for (const ch of str) {
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (depth === 0 && sepRe.test(ch)) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
function parseCompound(c) {
  const res = { tag: null, classes: [], attrs: [], id: null };
  let s = c;
  const tag = s.match(/^[a-zA-Z][\w-]*/);
  if (tag) { res.tag = tag[0].toUpperCase(); s = s.slice(tag[0].length); }
  const re = /#([\w-]+)|\.([\w-]+)|\[(\w[\w-]*)(\^=|\$=|\*=|=)?("?)([^"\]]*)\5?\]/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) res.id = m[1];
    else if (m[2]) res.classes.push(m[2]);
    else res.attrs.push({ name: m[3], op: m[4] || "", val: m[6] || "" });
  }
  return res;
}
function matchCompound(node, comp) {
  if (node.nodeType !== 1) return false;
  // A compound we could not parse would match EVERYTHING and quietly make the
  // whole test vacuous - fail loudly instead (the repo's own rule for the stub).
  if (!comp.tag && !comp.id && !comp.classes.length && !comp.attrs.length) {
    throw new Error("stub selector engine cannot parse this selector");
  }
  if (comp.id && node.id !== comp.id) return false;
  if (comp.tag && node.tagName !== comp.tag) return false;
  for (const c of comp.classes) if (!node.classList.contains(c)) return false;
  for (const a of comp.attrs) {
    const v = node.getAttribute(a.name);
    if (v === null) return false;
    if (a.op === "") continue; // presence check only
    if (a.op === "=" && v !== a.val) return false;
    if (a.op === "^=" && !v.startsWith(a.val)) return false;
    if (a.op === "$=" && !v.endsWith(a.val)) return false;
    if (a.op === "*=" && !v.includes(a.val)) return false;
  }
  return true;
}
function matches(node, sel) {
  if (!sel) return false;
  return splitTop(sel, /,/).some((seq) => {
    const parts = [];
    let cur = "", depth = 0;
    for (let i = 0; i < seq.length; i++) {
      const ch = seq[i];
      if (ch === "[" || ch === "(") depth++;
      if (ch === "]" || ch === ")") depth--;
      if (depth === 0 && (ch === " " || ch === ">")) {
        if (cur) { parts.push({ sel: cur }); cur = ""; }
        if (ch === ">") parts.push({ child: true });
        continue;
      }
      cur += ch;
    }
    if (cur) parts.push({ sel: cur });
    const compounds = parts.filter((p) => p.sel).map((p) => parseCompound(p.sel));
    const lastChild = parts.length > 1 && parts[parts.length - 2].child;
    let idx = compounds.length - 1, n = node;
    if (!matchCompound(n, compounds[idx])) return false;
    idx--;
    n = n.parentElement;
    while (idx >= 0) {
      if (lastChild && idx === compounds.length - 2) {
        if (!n || !matchCompound(n, compounds[idx])) return false;
        idx--; n = n.parentElement; continue;
      }
      while (n && !matchCompound(n, compounds[idx])) n = n.parentElement;
      if (!n) return false;
      idx--; n = n.parentElement;
    }
    return true;
  });
}

// ── stub DOM ─────────────────────────────────────────────────────────────────
const registry = []; // every element, for document-level queries
function txt(v) {
  const n = { nodeType: 3, nodeValue: v, childNodes: [], tagName: "", parentElement: null };
  return n;
}
function el(tag, opts, children) {
  const o = opts || {};
  const attrs = Object.assign({}, o.attrs);
  if (o.class) attrs.class = o.class;
  if (o.testid) attrs["data-testid"] = o.testid;
  if (o.rowKey) attrs["data-row-key"] = o.rowKey;
  if (o.src) attrs.src = o.src;
  if (o.aria) attrs["aria-label"] = o.aria;
  if (o.disabled) attrs.disabled = "";
  const cls = new Set(splitTop(o.class || "", /\s+/).filter(Boolean));
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: [],
    parentElement: null,
    get children() { return node.childNodes.filter((c) => c.nodeType === 1); },
    get className() { return [...cls].join(" "); },
    set className(v) { cls.clear(); splitTop(String(v), /\s+/).forEach((c) => cls.add(c)); attrs.class = String(v); },
    classList: {
      contains: (c) => cls.has(c),
      add: (...cs) => { cs.forEach((c) => cls.add(c)); attrs.class = [...cls].join(" "); },
      remove: (...cs) => { cs.forEach((c) => cls.delete(c)); attrs.class = [...cls].join(" "); },
      toggle: (c, on) => {
        const want = on === undefined ? !cls.has(c) : !!on;
        if (want) cls.add(c); else cls.delete(c);
        attrs.class = [...cls].join(" ");
        return want;
      },
    },
    dataset: {},
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    setAttribute: (n, v) => {
      attrs[n] = String(v);
      if (n === "class") { cls.clear(); splitTop(String(v), /\s+/).forEach((c) => cls.add(c)); }
    },
    removeAttribute: (n) => { delete attrs[n]; },
    matches: (s) => matches(node, s),
    contains: (other) => { let n = other; while (n) { if (n === node) return true; n = n.parentElement; } return false; },
    closest: (s) => { let n = node; while (n) { if (n.matches && n.matches(s)) return n; n = n.parentElement; } return null; },
    querySelector: (s) => descendants(node).find((n) => matches(n, s)) || null,
    querySelectorAll: (s) => descendants(node).filter((n) => matches(n, s)),
    removeChild: (c) => {
      const i = node.childNodes.indexOf(c);
      if (i >= 0) node.childNodes.splice(i, 1);
      c.parentElement = null;
      return c;
    },
    focus: () => { node.focused = true; },
    click: () => { node.clicks = (node.clicks || 0) + 1; if (node.onclick) node.onclick({ target: node }); },
    dispatchEvent: (ev) => {
      ev.target = ev.target || node;
      let n = node, dispatched = ev;
      while (n) {
        dispatched.currentTarget = n;
        const list = n.listeners && n.listeners[ev.type];
        if (list) for (const f of list) f(dispatched);
        if (ev.type === "click" && n === node && node.onclick) node.onclick(dispatched);
        if (!ev.bubbles) break;
        n = n.parentElement;
      }
      return true;
    },
    addEventListener: (t, f) => { (node.listeners = node.listeners || {})[t] = (node.listeners[t] || []).concat(f); },
    getBoundingClientRect: () => ({ top: 100, left: 100, width: 600, height: 120, right: 700, bottom: 220 }),
    replaceChildren: (...kids) => {
      node.childNodes.forEach((c) => { c.parentElement = null; });
      node.childNodes = [];
      for (const k of kids) {
        const list = k && k.__fragment ? k.childNodes : [k];
        for (const c of list) { c.parentElement = node; node.childNodes.push(c); }
      }
    },
    get textContent() {
      return node.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join("");
    },
    get innerText() { return renderText(node, false); },
    set textContent(v) { node.childNodes = [txt(String(v))]; node.childNodes[0].parentElement = node; },
    get offsetParent() { return o.hidden ? null : { nodeName: "BODY" }; },
  };
  if (o.id) node.id = o.id;
  // dataset mirrors the data-* attributes in a real DOM (the provider reads the
  // row key through `element.dataset.rowKey`), so keep the two in sync here.
  node.dataset = o.dataset ? Object.assign({}, o.dataset) : {};
  if (o.rowKey) node.dataset.rowKey = o.rowKey;
  for (const k of Object.keys(attrs)) {
    const m = /^data-([\w-]+)$/.exec(k);
    if (!m) continue;
    const camel = m[1].replace(/-(\w)/g, (_, c) => c.toUpperCase());
    if (!(camel in node.dataset)) node.dataset[camel] = attrs[k];
  }
  for (const c of children || []) {
    const child = typeof c === "string" ? txt(c) : c;
    child.parentElement = node;
    node.childNodes.push(child);
  }
  registry.push(node);
  return node;
}
function frag(children) {
  const f = { __fragment: true, childNodes: [], appendChild: (c) => { f.childNodes.push(c); return c; } };
  return f;
}
function descendants(root) {
  const out = [];
  (function walk(n) { for (const c of n.childNodes) { if (c.nodeType === 1) out.push(c); walk(c); } })(root);
  return out;
}
// Browser-ish innerText: <br> is a line break, block boundaries are line breaks,
// and text-node whitespace COLLAPSES outside <pre>/<code> (the composer sets
// [white-space-collapse:inherit], so a bare "\n" text node would render as a
// single space - which is exactly why the provider injects <br> elements).
function renderText(node, inPre) {
  let out = "";
  const walk = (n, pre) => {
    if (n.nodeType === 3) { out += pre ? n.nodeValue : n.nodeValue.replace(/\s+/g, " "); return; }
    if (n.nodeType !== 1) return;
    if (n.tagName === "BR") { out += "\n"; return; }
    const block = !pre && /^(P|DIV|LI|BLOCKQUOTE|PRE|TR|H[1-6]|UL|OL|ARTICLE)$/.test(n.tagName);
    const nowPre = pre || n.tagName === "PRE" || n.tagName === "CODE";
    if (block && out && !out.endsWith("\n")) out += "\n";
    for (const c of n.childNodes) walk(c, nowPre);
    if (block && out && !out.endsWith("\n")) out += "\n";
  };
  walk(node, inPre);
  // The innerText spec returns the flushed AND trimmed string, so a trailing
  // block boundary does NOT add a newline for the element itself.
  return out.replace(/^[\s\u00a0]+/, "").replace(/[\s\u00a0]+$/, "");
}

// ── the Canvas page model we exercise ───────────────────────────────────────
// Mirrors chat-message.tsx / chat-input-field.tsx / chat-input-actions.tsx:
//   row wrapper (data-row-key) > article[data-testid=agent-message]
//     ├ div.absolute (hover bar: copy button)      <- chrome, must be skipped
//     ├ div (message body) > p, div.relative (code wrapper: copy button + pre)
//     ├ div[data-testid=collapsible-thinking]        <- reasoning, must be skipped
//     └ div[data-testid=message-timestamp]           <- chrome, must be skipped
function codeBlock(jsonText) {
  const copy = el("button", { testid: "copy-to-clipboard", class: "button-base" });
  const pre = el("pre", { class: "bg-surface-raised" }, [el("code", { class: "language-json" }, [jsonText])]);
  const abs = el("div", { class: "absolute top-2 right-2 z-10" }, [copy]);
  return el("div", { class: "relative" }, [abs, pre]);
}
function agentRow(rowKey, { reply, thinking, hideBar = false } = {}) {
  const bar = el("div", { class: "absolute -top-2.5 -right-2.5 z-10" }, [
    el("button", { testid: "copy-to-clipboard", class: "button-base", aria: "Copy message" }, ["Copy"]),
  ]);
  const bodyKids = [el("p", { class: "leading-6" }, [reply.text0 || ""])];
  if (reply.code) bodyKids.push(codeBlock(reply.code));
  if (reply.text1) bodyKids.push(el("p", { class: "leading-6" }, [reply.text1]));
  const body = el("div", { class: "min-w-0 text-sm leading-6" }, bodyKids);
  const think = thinking
    ? el("div", { testid: "collapsible-thinking", class: "my-1 w-full" }, [
        el("button", { testid: "collapsible-thinking-toggle" }, ["Thinking"]),
        el("div", { testid: "collapsible-thinking-content" }, [thinking]),
      ])
    : null;
  const art = el("article", {
    testid: "agent-message",
    class: "rounded-xl relative w-fit max-w-full flex flex-col",
  }, [hideBar ? null : bar, body, think, el("div", { testid: "message-timestamp" }, ["Just now"])].filter(Boolean));
  return el("div", { class: "contents", rowKey }, [art]);
}
function userRow(rowKey, text, { clamp = false } = {}) {
  const kids = [el("div", { class: "min-w-0" }, [el("p", {}, [text])])];
  if (clamp) kids.push(el("span", { testid: "chat-message-view-more" }, ["View more"]));
  const art = el("article", {
    testid: "user-message",
    class: "rounded-xl relative w-fit max-w-full flex flex-col bg-tertiary",
  }, kids);
  return el("div", { class: "contents", rowKey }, [art]);
}
function composer({ plan = false, sending = false, spinner = false, stop = false, gate = false } = {}) {
  const editor = el("div", {
    testid: "chat-input",
    class: "chat-input bg-transparent whitespace-pre-wrap",
    attrs: { contenteditable: "true", "data-placeholder": "What do you want to build?", role: "textbox" },
  });
  editor.listeners = {};
  const send = el("button", { testid: "submit-button", class: "rounded-full", disabled: true }, [
    el("svg", { attrs: { "data-icon": "arrow-up" } }),
  ]);
  if (sending) send.childNodes.push(el("span", { testid: "submit-button-pending-icon", class: "animate-spin" }));
  const stopBtn = stop ? el("button", { testid: "stop-button", class: "cursor-pointer" }, [el("svg", {})]) : null;
  const spin = spinner ? el("div", { testid: "agent-loading-spinner" }, [el("span", { class: "animate-spin" })]) : null;
  const gateBtn = gate ? el("button", { testid: "action-confirm-button" }, ["Yes, proceed"]) : null;
  const actions = el("div", { class: "flex items-center gap-2" }, [gateBtn, spin, stopBtn, send].filter(Boolean));
  // The app's own wiring, simulated exactly as chat-input-field.tsx works: the
  // onInput handler re-derives canSubmit from innerText, and submitting reads
  // innerText then clears the box. Both reads go through the stub's innerText,
  // which collapses text-node whitespace like a browser - so a provider that
  // injected raw "\n" text instead of <br> WOULD fail the round-trip below.
  editor.addEventListener("input", () => {
    const t = editor.innerText;
    send.removeAttribute("disabled");
    if (!t || !t.trim()) send.setAttribute("disabled", "");
  });
  send.onclick = () => {
    if (send.getAttribute("disabled") !== null) return; // still disabled → no-op
    onSend(editor.innerText);
    editor.replaceChildren();
    fire("input"); // the app clears the composer, then React re-syncs
  };
  function fire(type) {
    const ev = new global.Event(type, { bubbles: true, cancelable: true });
    ev.target = editor;
    editor.dispatchEvent(ev);
  }
  // UploadedFiles row + the always-mounted hidden input (hidden-file-input.tsx).
  // handleFileInputChange -> processImages converts each image LOCALLY, then the
  // chip renders; the stub models that with a short async hop.
  const attachRow = el("div", { class: "flex w-full flex-col gap-2 pb-4" });
  let chipSeq = 0;
  const fileInput = el("input", {
    testid: "upload-image-input", class: "hidden",
    attrs: { type: "file", multiple: "", accept: "*/*" },
  });
  fileInput.files = [];
  fileInput.listeners = {};
  fileInput.addEventListener("change", () => {
    for (const f of [...(fileInput.files || [])]) {
      setTimeout(() => {
        const chip = el("div", { class: "group relative" }, [
          el("img", { src: "blob:oh-" + ++chipSeq + "-" + f.name }),
        ]);
        const rm = el("button", { class: "z-10", aria: "Remove image" });
        rm.onclick = () => chip.parentElement && chip.parentElement.removeChild(chip);
        chip.childNodes.push(rm); rm.parentElement = chip;
        attachRow.childNodes.push(chip); chip.parentElement = attachRow;
        const ev = new global.Event("input", { bubbles: true, cancelable: true });
        ev.target = editor; editor.dispatchEvent(ev);
      }, 30);
    }
  });
  const card = el("div", {
    class: "bg-surface flex flex-col rounded-composer w-full" + (plan ? " border border-[#597FF4]" : ""),
  }, [fileInput, attachRow, el("div", { class: "relative w-full" }, [el("div", { class: "flex flex-row" }, [editor])]), actions]);
  const box = el("div", { testid: "interactive-chat-box" }, [el("div", { class: "relative w-full" }, [card])]);
  return { card, editor, send, box };
}

// The page under test: root > main column (rows) + composer.
function makePage(opts) {
  const o = opts || {};
  registry.length = 0;
  const rows = el("div", { testid: "chat-scroll-container", class: "flex flex-col" }, o.rows || []);
  const comp = composer(o);
  const automation = o.automation
    ? el("div", { testid: "automation-setup-toolbar" }, [el("div", { testid: "home-chat-launcher" }, [composer().editor])])
    : null;
  const banner = o.banner ? el("div", { testid: o.bannerId || "error-message-banner" }, [o.banner]) : null;
  const zsRoot = el("div", { id: "zs-root", dataset: { zsRoot: "1" } }, [el("div", { id: "zs-bar" })]);
  zsRoot.childNodes.forEach((c) => { c.parentElement = zsRoot; });
  const body = el("body", {}, [rows, banner, o.noComposer ? null : comp.box, automation, zsRoot].filter(Boolean));
  global.document = {
    nodeType: 9, tagName: "", childNodes: [body], parentElement: null,
    body,
    documentElement: el("html", {}),
    querySelectorAll: (s) => descendants(body).concat([body]).filter((n) => matches(n, s)),
    querySelector: (s) => global.document.querySelectorAll(s)[0] || null,
    createElement: (t) => el(t, {}),
    createTextNode: (v) => {
      const n = txt(String(v));
      return n;
    },
    createDocumentFragment: (kids) => frag(kids || []),
    listeners: {},
    addEventListener: (t, f) => {
      const d = global.document;
      (d.listeners[t] = d.listeners[t] || []).push(f);
    },
    dispatchEvent: (ev) => {
      const d = global.document;
      (d.listeners[ev.type] || []).forEach((f) => f(ev));
      return true;
    },
  };
  global.document.body.parentElement = global.document;
  global.__canvas = Object.assign(comp, { rows, body, automation });
  return global.__canvas;
}
global.getComputedStyle = () => ({ position: "static" });
global.InputEvent = class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } };
global.Event = class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } };
global.KeyboardEvent = class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } };
class StubFileList {
  constructor(files) { this._f = files; this.length = files.length; files.forEach((f, i) => { this[i] = f; }); }
  item(i) { return this._f[i] || null; }
  [Symbol.iterator]() { return this._f[Symbol.iterator](); }
}
global.DataTransfer = class {
  constructor() {
    this._files = [];
    // Real DataTransfer: `items` and `files` are two views of ONE list, so an
    // add() is visible through both. The provider relies on that (it checks
    // items.length, then assigns .files), so the stub must couple them.
    const self = this;
    this.items = {
      get length() { return self._files.length; },
      add: (f) => { self._files.push(f); },
    };
  }
  get files() { return new StubFileList(this._files); }
};
global.File = class { constructor(parts, name, opts) { this.name = name; this.type = (opts && opts.type) || ""; this._parts = parts; } };
global.atob = (s) => Buffer.from(s, "base64").toString("binary");

// React-side state the provider must observe: what the composer holds and the
// rows the app appends after a send.
let pendingSends = [];
function onSend(text) { pendingSends.push(text); }

// ── load the provider ───────────────────────────────────────────────────────
const src = fs.readFileSync(require("path").join(__dirname, "providers/openhands.js"), "utf8");
global.location = { pathname: "/canvas/conversations/6f1c2a34-5b6c-4d7e-8f90-aabbccddeeff" };
global.window = { location: global.location, addEventListener: () => {}, HTMLTextAreaElement: undefined };
const P = eval(src + ";ZSProvider");
P.init({ diag: () => {} });

// ── 1. home screen: fresh chat, no turns ────────────────────────────────────
console.log("\nhome /canvas/");
global.location.pathname = "/canvas/";
makePage({});
eq(P.chatIsEmpty(), true, "chatIsEmpty on the launcher screen");
eq(P.isFreshChat(), true, "isFreshChat (composer up, no turns, no id in path)");
eq(P.conversationKey(), "", "conversationKey is transient before the conversation exists");
eq(P.getEditor() && P.getEditor().getAttribute("data-testid"), "chat-input", "getEditor finds the Canvas composer");
eq(P.modeWarning(), "", "no mode warning in Code mode");

// ── 2. a real conversation: reading the agent's reply ──────────────────────
console.log("\nconversation turns");
const fenced = '{\n  "command": "list_commands",\n  "params": {}\n}';
makePage({
  rows: [
    userRow("single-u1", "make a part", {}),
    agentRow("thought-a1", {
      reply: { text0: "I'll read the place first.", code: fenced, text1: "Then I'll build it." },
      thinking: 'Draft: {"command": "inspect_instance"} — not sent yet',
    }),
  ],
});
eq(P.userCount(), 1, "userCount");
eq(P.assistantCount(), 1, "assistantCount");
eq(P.lastAssistantId(), "thought-a1", "lastAssistantId = the row key (survives virtualisation)");
const read = P.readAssistant();
ok(read.present, "readAssistant sees the turn");
ok(read.reply.includes('"command": "list_commands"'), "reply carries the fenced command JSON");
ok(read.reply.includes("I'll read the place first."), "reply keeps its own narration");
ok(!read.reply.includes("inspect_instance"), "reasoning is stripped (a draft command must never run)");
ok(!read.reply.includes("Just now"), "the bubble timestamp is stripped");
ok(!read.reply.includes("Copy message") && !read.reply.includes("Copy"), "the hover copy bar is stripped");
ok(/Then I'll build it\./.test(read.reply), "text after the code block survives");
const codeIdx = read.reply.indexOf("```json");
eq(read.reply.split("\n").some((l) => l.includes('"command"')), true, "the JSON block keeps one key per LINE");
eq(read.reply.split("\n").filter((l) => l.trim() === '"params": {}').length, 1, "no collapsed whitespace inside the block");
ok(codeIdx === -1, "no markdown fence markup leaks (the block itself is what we hide)");
const hasFence = /```/.test(read.reply);
ok(!hasFence, "fences are not rendered into the DOM, so ZSParse sees the raw markers only once", read.reply.slice(0, 80));

// ── 3. camouflage: hide the command block, never the reply ─────────────────
console.log("\ncamouflage");
const item = P.lastAssistant();
const spot = P.findToolBlockSpot(item, null);
const wrappers = item.querySelectorAll("div.relative");
const codeWrap = wrappers.find((w) => w.querySelector("pre"));
ok(!!spot && spot.parent === codeWrap.parentElement && spot.ref === codeWrap, "spot points AT the code wrapper");
ok(codeWrap.classList.contains("zs-tool-hide"), "the command block is hidden");
ok(item.classList.contains("zs-cmd-mask"), "the turn is masked so a recreated block stays hidden");
ok(!item.classList.contains("zs-tool-hide"), "the REPLY ITSELF is not hidden (shared copy-button guard)");
eq(P.findToolBlockSpot(userRow("single-u2", "plain text"), null), null, "a turn with no command block hides nothing");

// ── 4. the send path ────────────────────────────────────────────────────────
console.log("\nsend");
const page = makePage({ rows: [] });
pendingSends = [];
const TEXT = 'result\n```json\n' + fenced + "\n```\nkeep going";
(async () => {
  await P.typeAndSend(TEXT, null);
  eq(pendingSends.length, 1, "the message was submitted once");
  const sent = pendingSends[0];
  eq(sent.split("\n").length, TEXT.split("\n").length, "every LINE of the payload arrives as its own line");
  const jsonSlice = sent.slice(sent.indexOf("{"), sent.lastIndexOf("}") + 1);
  eq(JSON.parse(jsonSlice).command, "list_commands", "the JSON still PARSES after the site normalised the text");
  ok(/\n ?"command": "list_commands",\n/.test(sent), "a key per line survives (that is what <br> buys us)");
  // WHY <br> and not a bare "\n" text node: the composer sets
  // [white-space-collapse:inherit], so a raw newline collapses to a space -
  // every line would be glued into one and the ###LUA### markers / JSON keys
  // would never parse. This asserts the hazard is real in the DOM we target.
  const ed = page.editor;
  ed.replaceChildren(global.document.createTextNode("a\nb\nc"));
  eq(ed.innerText.replace(/\s+/g, " "), "a b c", "raw newline text WOULD collapse (so we never rely on it)");
  ed.replaceChildren();
  await P.typeAndSend("a\nb\nc", null);
  eq(pendingSends[1], "a\nb\nc", "our injection does not collapse");
  eq(P.editorText().trim(), "", "the composer is empty again → the core's 'landed' signal fires");
  ok(page.rows.querySelector('[data-testid="chat-input"]') === null, "sanity: composer is outside the row list");

  // A draft restored by the app must be REPLACED, never appended to.
  pendingSends = [];
  page.editor.replaceChildren(global.document.createTextNode("leftover draft"));
  await P.typeAndSend("second", null);
  eq(pendingSends[0], "second", "a leftover draft is wiped by the injection");

  // ── 5. generation detection ──────────────────────────────────────────────
  console.log("\ngeneration");
  makePage({ rows: [], spinner: true });
  eq(P.isGenerating(), true, "runtime boot (spinner, no reply) still counts as generating");
  eq(P.isBusyNow(), false, "…but does NOT block a send (the queue accepts follow-ups)");
  makePage({ rows: [], stop: true });
  eq(P.isGenerating(), true, "RUNNING → stop button present");
  eq(P.isBusyNow(), true, "…and a send must wait for it");
  eq(P.isHardGenerating(), true, "isHardGenerating mirrors the stop button");
  makePage({ rows: [], gate: true });
  eq(P.findContinueBtn(), null, "the approval gate is NOT exposed as Continue (no silent approvals)");
  eq(P.clickContinueBtn(), false, "…and never clicked");
  ok(P.genDebug().gate === true, "genDebug reports the approval gate for chip.why diagnostics");

  // ── 6. modes & errors ────────────────────────────────────────────────────
  console.log("\nmodes / errors");
  makePage({ rows: [], plan: true });
  ok(/Plan mode/.test(P.modeWarning()), "plan mode warns (it can only write a plan)");
  makePage({ rows: [], automation: true, noComposer: true });
  eq(P.getEditor(), null, "the Automations composer is refused (submitting there CREATES AN AUTOMATION)");
  ok(/Automations composer/.test(P.modeWarning()), "…with an explanation before Start");
  makePage({ rows: [], banner: "HTTP request failed (429): rate limit exceeded" });
  ok(/429|rate limit/i.test(P.scanError() || ""), "a visible error banner is reported");
  makePage({ rows: [], banner: "This conversation exceeded the context limit" });
  ok(/context limit/i.test(P.scanError() || ""), "a context-limit banner is reported");
  makePage({ rows: [] });
  eq(P.scanError(), null, "no error surfaces → null");
  eq(P.isTooLongMsg("the conversation is too long, start a new chat"), true, "isTooLongMsg");
  eq(P.isBusyMsg("OpenHands is busy, try again later"), true, "isBusyMsg");

  // ── 7. virtualised long chat + injected-feedback turn ────────────────────
  console.log("\nlong chat / feedback turns");
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push(userRow("single-u" + i, "step " + i));
    rows.push(agentRow("thought-a" + i, { reply: { text0: "done " + i } }));
  }
  const late = agentRow("single-late", { reply: { text0: "final answer" } });
  rows.push(late);
  makePage({ rows });
  eq(P.assistantCount(), 7, "assistantCount over the whole rendered list");
  eq(P.lastAssistantId(), "single-late", "identity follows the LAST rendered row (virtualisation-safe)");
  const last = P.lastAssistant();
  eq(P.itemKey(last), "single-late", "itemKey exposes the row key for turn dedupe");
  eq(P.itemKey(userRow("single-x", "hi")), "single-x", "itemKey works on any row");
  eq(P.turnHalted(last), false, "Canvas exposes no per-turn halted marker");

  // ── 8. lock / enforcement ─────────────────────────────────────────────────
  console.log("\ncomposer lock");
  const p2 = makePage({ rows: [] });
  P.setInputLock(true);
  eq(p2.editor.getAttribute("contenteditable"), "false", "lock disables the contentEditable (the site's own disabled mechanism)");
  p2.editor.setAttribute("contenteditable", "true"); // React remount restores it
  P.enforceComposer();
  eq(p2.editor.getAttribute("contenteditable"), "false", "enforceComposer re-glues the lock after a re-render");
  P.setInputLock(false);
  eq(p2.editor.getAttribute("contenteditable"), "true", "unlock restores editing");
  await P.typeAndSend("while-locked", null);
  P.setInputLock(true);
  pendingSends = [];
  await P.typeAndSend("during-lock", null); // injection must temporarily re-enable
  eq(pendingSends[0], "during-lock", "we can still inject+send while the user is locked out");
  eq(p2.editor.getAttribute("contenteditable"), "false", "…and the lock is re-applied afterwards");

  // ── 9. send hooks ────────────────────────────────────────────────────────
  console.log("\nsend hooks");
  const p3 = makePage({ rows: [userRow("single-u9", "hello")] });
  let calls = [];
  const handlers = {
    isBlocked: () => false,
    isStarted: () => true,
    onBlockedAttempt: () => calls.push("nudge"),
    onUserMessage: (base) => calls.push("user:" + base),
    onNativeStop: () => calls.push("stop"),
  };
  P.installSendHooks(handlers);
  p3.editor.dispatchEvent(Object.assign(new global.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }), { target: p3.editor }));
  eq(calls.join(","), "", "Enter with an empty composer is not a user message");
  p3.editor.replaceChildren(global.document.createTextNode("typed by the user"));
  p3.editor.dispatchEvent(Object.assign(new global.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }), { target: p3.editor }));
  eq(calls.join(","), "user:0", "Enter with text = a user turn we should watch (0 assistant turns yet)");
  calls = [];
  const stopBtn = p3.box.querySelector('[data-testid="stop-button"]');
  eq(stopBtn, null, "no stop button while idle");
  const p4 = makePage({ rows: [], stop: true });
  P.installSendHooks(handlers);
  p4.send.parentElement.querySelector('[data-testid="stop-button"]').dispatchEvent(new global.Event("click", { bubbles: true, cancelable: true }));
  eq(calls.join(","), "stop", "the site's own stop click is treated as a manual stop");

  // ── 10. attachments (the screen_capture path) ─────────────────────────────
  console.log("\nattachments");
  const p5 = makePage({ rows: [] });
  eq(P.hasPendingAttachment === undefined, true, "hasPendingAttachment stays internal (not part of the interface)");
  const png = { data: Buffer.from([0x89, 1, 2, 3]).toString("base64"), mimeType: "image/png" };
  eq(await P.attachImages([png]), true, "attachImages waits for the chip to render");
  const chipImg = p5.card.querySelector('img[src^="blob:"]');
  ok(!!chipImg, "the staged chip is a blob: image inside the composer card");
  eq(await P.attachImages([]), false, "no images → nothing to attach");
  P.clearAttachments();
  await sleep(60);
  eq(p5.card.querySelector('img[src^="blob:"]'), null, "clearAttachments clicks the chip's Remove control");

  // ── 11. home Automate pill: the send would create an automation ───────────
  console.log("\nlauncher modes");
  const p6 = makePage({ rows: [] });
  const pill = el("div", { testid: "home-launcher-mode-toggle", class: "inline-flex" }, [
    el("button", { testid: "home-launcher-mode-code", attrs: { role: "radio", "aria-checked": "true" } }, ["Code"]),
    el("button", { testid: "home-launcher-mode-automate", attrs: { role: "radio", "aria-checked": "true" } }, ["Automate"]),
  ]);
  p6.body.childNodes.push(pill); pill.parentElement = p6.body;
  ok(/Automate/.test(P.modeWarning() || ""), "Automate mode warns before Start (the message would not be a chat turn)");
  pill.querySelectorAll("button").forEach((b) => {
    if (b.getAttribute("data-testid") === "home-launcher-mode-automate") b.setAttribute("aria-checked", "false");
  });
  eq(P.modeWarning(), "", "back on Code → the warning clears (reactive: the bar re-renders on every sweep)");

  // ── 12. never mistake Studio Agent's own UI for the site's ──────────────────
  console.log("\nown-UI isolation");
  const p7 = makePage({ rows: [], noComposer: true });
  const mine = el("textarea", { id: "zs-set-text", attrs: { "data-testid": "chat-input" } });
  const zsroot = p7.body.querySelector("#zs-root");
  zsroot.childNodes.push(mine); mine.parentElement = zsroot;
  eq(P.getEditor(), null, "our settings textarea is not treated as the site composer");
  eq(P.isFreshChat(), false, "…so a page without the site's editor is not a startable chat");

  // ── 13. registration sync (manifest / background / core / overlay.css) ─────
  // The four files that must know about a provider are edited independently, so a
  // missing entry is the most likely way this integration can ship broken - and
  // none of it is reachable from the DOM tests above. Read them as text.
  console.log("\nregistration");
  const here = __dirname;
  const read = (rel) => fs.readFileSync(here + "/" + rel, "utf8");
  const man = JSON.parse(read("manifest.json"));
  const cs = man.content_scripts.filter((c) => c.js.includes("providers/openhands.js"));
  eq(cs.length, 1, "manifest has exactly one content_scripts entry for providers/openhands.js");
  eq(cs[0].js.join(","), "core/config.js,core/parser.js,providers/openhands.js,core/main.js",
     "…with the standard four-script load order");
  eq(cs[0].css && cs[0].css[0], "overlay.css", "…and overlay.css (the camouflage re-hide rule)");
  eq(cs[0].run_at, "document_idle", "…at document_idle, like every other provider");
  cs[0].matches.forEach((m) => ok(man.host_permissions.includes(m),
     "host_permissions covers " + m + " (without it the content script never loads)"));
  const bg = read("background.js");
  cs[0].matches.forEach((m) => ok(bg.includes('"' + m + '"'), "background.js PROVIDER_URLS lists " + m));
  const main = read("core/main.js");
  const site = /\{ name: "([^"]+)", url: "https:\/\/app\.all-hands\.dev[^"]*" \}/.exec(main);
  ok(!!site, "core/main.js AI_SITES has an OpenHands row (the ⋯ menu's site list)");
  eq(site && site[1], P.displayName, "AI_SITES name matches P.displayName (or the bar never shows 'active')");
  const css = read("overlay.css");
  ok(css.includes("html.zs-site-openhands"), "overlay.css is scoped to this site's root class");
  ok(/html\.zs-site-openhands[^\n]*zs-cmd-mask[^\n]*\{[^}]*display:\s*none/.test(css),
     "…and re-hides a recreated block inside a .zs-cmd-mask turn (what typeAndSend/readAssistant relies on)");
  ok(/item\.classList\.add\("zs-cmd-mask"\)/.test(read("providers/openhands.js")),
     "the provider really does add that class (else the CSS rule is inert and the block flashes)");

  console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " checks FAILED" : "✓ all " + checks + " checks passed"));
  process.exit(fails ? 1 : 0);
})();
