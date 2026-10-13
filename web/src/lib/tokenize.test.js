import { describe, expect, it } from "vitest";
import { langOf, tokenize } from "./tokenize.js";

const classes = (src, path) => src.split("\n").map((l) => tokenize(l, langOf(path)).filter(([c]) => c).map(([c, t]) => `${c} ${t}`));

describe("tokenize", () => {
  it("the tokenizer highlights keywords, strings and comments for JS and Go (snapshot of token classes)", () => {
    expect(classes('export const a = "x // y"; // note\nreturn `t`; /* c */', "src/a.jsx")).toEqual([
      ["c-kw export", "c-kw const", 'c-st "x // y"', "c-cm // note"],
      ["c-kw return", "c-st `t`", "c-cm /* c */"],
    ]);
    expect(classes('func main() {\n\tfmt.Println("hi") // say\n\treturn nil\n}', "cmd/main.go")).toEqual([
      ["c-kw func", "c-fn main", "c-pu (", "c-pu )", "c-pu {"], ["c-pu .", "c-fn Println", "c-pu (", 'c-st "hi"', "c-pu )", "c-cm // say"],
      ["c-kw return", "c-bi nil"], ["c-pu }"],
    ]);
    expect(tokenize("plain text", langOf("notes.txt"))).toEqual([[null, "plain text"]]);
  });

  it("tokenizing a .ts, .py, .cs and .tf sample yields coloured spans", () => {
    expect(classes('export interface A { s: "x" } // n', "src/retry.ts")).toEqual([["c-kw export", "c-kw interface", "c-ty A", 'c-st "x"', "c-cm // n"]]);
    expect(classes("const a = <B />;", "src/app.tsx")).toEqual([["c-kw const", "c-tg B"]]);
    expect(classes('def f(): return "x"  # n', "app.py")).toEqual([["c-kw def", "c-kw return", 'c-st "x"', "c-cm # n"]]);
    expect(classes('public class A { string s = "x"; } // n', "A.cs")).toEqual([["c-kw public", "c-kw class", "c-kw string", 'c-st "x"', "c-cm // n"]]);
    expect(classes('resource "aws_s3_bucket" "b" { # n', "main.tf")).toEqual([["c-ty resource", 'c-ns "aws_s3_bucket"', 'c-ns "b"', "c-cm # n"]]);
  });
});
