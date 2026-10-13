// The Code page's View and its Monaco editor read these, so a file looks the same in both and Edit shifts nothing.
export const CODE = { fontSize: 12, lineHeight: 20, top: 6, digits: 5, gap: 16, tabSize: 4, strip: 36 }; // strip: a lease strip's .lrow, margin and height
export const codeTheme = () => (document.documentElement.classList.contains("dark") ? "cinder-dark" : "cinder-light");
// Each token class (lib/highlight.js SCOPES, lib/tokenize.js) and its tokens.css colour, so View, Edit and diffs colour a
// token the same in light and dark.
export const CLASS_VAR = { "c-cm": "--text-subtle", "c-st": "--success", "c-kw": "--link", "c-bi": "--info-fill", "c-fn": "--text-strong", "c-ty": "--warning", "c-nm": "--danger",
  "c-ns": "--chart-2", "c-op": "--danger-fill", "c-pu": "--text", "c-tg": "--interactive", "c-at": "--success-fill" };
// Monaco's gutter is `digits` digit widths plus the decorations gap; View's is tokens.css --code-gutter (CSS's ch is that digit width).
export const viewStyle = { fontSize: CODE.fontSize, lineHeight: `${CODE.lineHeight}px`, paddingTop: CODE.top, tabSize: CODE.tabSize };
// Glyph margin and folding would widen Monaco's gutter past the View's. The font is View's token (Monaco resolves the var
// from :root); Edit-only colouring is off so a file colours the same token for token.
export const editorOptions = { fontFamily: "var(--font-mono)", fontSize: CODE.fontSize, lineHeight: CODE.lineHeight, padding: { top: CODE.top }, tabSize: CODE.tabSize,
  lineNumbersMinChars: CODE.digits, lineDecorationsWidth: CODE.gap, glyphMargin: false, folding: false,
  bracketPairColorization: { enabled: false }, matchBrackets: "never", occurrencesHighlight: "off", selectionHighlight: false,
  guides: { indentation: false }, renderLineHighlight: "none" };
