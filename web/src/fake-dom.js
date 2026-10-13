import { vi } from "vitest";

// No DOM library is allowed (deps-allow.txt), so React's client renderer runs on just the DOM calls it makes.
export class El {
  constructor(name, nodeType = 1, ns = "http://www.w3.org/1999/xhtml") {
    Object.assign(this, { nodeName: name.toUpperCase(), tagName: name.toUpperCase(), nodeType, namespaceURI: ns, childNodes: [], parentNode: null,
      attrs: {}, listeners: {}, options: [], innerHTML: "", nodeValue: null, style: { setProperty() {}, removeProperty() {} } });
  }
  get ownerDocument() { return doc; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(t) { this.childNodes = []; if (t) this.appendChild(doc.createTextNode(t)); }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    c.parentNode?.removeChild(c);
    this.childNodes.splice(ref ? this.childNodes.indexOf(ref) : this.childNodes.length, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  querySelector() { return null; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  removeEventListener() {}
  createElement(t) { return new El(t); }
  createElementNS(ns, t) { return new El(t, 1, ns); }
  createTextNode(t) { return Object.assign(new El("#text", 3), { nodeValue: t }); }
}
export const doc = new El("#document", 9);
doc.body = doc.appendChild(new El("body"));
doc.oninput = null; // React reads typing from input events only where "oninput" in document
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("document", doc);
vi.stubGlobal("window", Object.assign(globalThis, { HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {} }));

export const all = (n) => [n, ...n.childNodes.flatMap(all)];
export const click = (el) => {
  const e = { type: "click", target: el, bubbles: true, button: 0, preventDefault() {}, stopPropagation() {} };
  for (let n = el; n; n = n.parentNode) for (const f of n.listeners.click ?? []) f(e);
};
