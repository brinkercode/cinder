import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLASS_VAR } from "./lib/code-metrics.js";
import { languageOf, SCOPES, textmateTheme, tokens } from "./lib/highlight.js";

// Shiki's grammars run in node with the JavaScript regex engine, so these check the real tokens View, Blame and diffs get.
const SAMPLES = {
  "app.py": "def area(r):\n    return 3.14 * r # m", "src/main.rs": "fn main() { let x = 1; }", "src/A.java": "class A { int x = 1; }",
  "a.kt": "fun f(): Int = 1", "a.swift": "func f() -> Int { return 1 }", "a.c": "int main() { return 0; }", "a.cpp": "int main() { return 0; }",
  "A.cs": "class A { int x = 1; }", "a.rb": "def f\n  1\nend", "a.php": "<?php function f() { return 1; }", "main.go": "package main\nfunc main() { fmt.Println(1) }",
  "a.ts": "const x: number = 1;", "a.tsx": 'const a = <div className="x">hi</div>;', "main.tf": 'variable "name" {\n  type = string\n}',
  "a.yaml": "key: value # c", "a.sql": "SELECT id FROM t WHERE x = 1;", "run.sh": "if [ -f x ]; then echo hi; fi", "a.ps1": "function Get-X { return 1 }",
  "a.lua": "local function f() return 1 end", "A.scala": "object A { def f(): Int = 1 }",
};

describe("code highlighting", () => {
  it("a file in each of 20 common languages (Python, Rust, Java, Kotlin, Swift, C, C++, C#, Ruby, PHP, Go, TS, TSX, HCL, YAML, SQL, Shell, PowerShell, Lua, Scala) gets non-plaintext tokens", async () => {
    for (const [path, src] of Object.entries(SAMPLES)) {
      const classes = new Set((await tokens(path, src)).flat().map(([c]) => c).filter(Boolean));
      expect(classes.size, path).toBeGreaterThan(1);
      expect([...classes].every((c) => CLASS_VAR[c]), path).toBe(true);
    }
    expect(await tokens("notes.unknownext", "plain")).toEqual([[[null, "plain"]]]);
  }, 60000);

  it("Jenkinsfile, CODEOWNERS and .bashrc are detected by name", () => {
    expect(["Jenkinsfile", "CODEOWNERS", ".github/CODEOWNERS", "home/.bashrc", "Dockerfile", "Makefile", "go.mod", ".env.local", "CMakeLists.txt", "src/a.PY"]
      .map(languageOf)).toEqual(["groovy", "codeowners", "codeowners", "shellscript", "docker", "make", "go", "dotenv", "cmake", "python"]);
    expect(languageOf("LICENSE")).toBe(null);
  });

  it("the code theme colours come from tokens.css in light and dark", () => {
    const css = readFileSync(new URL("./styles/app.css", import.meta.url), "utf8");
    const tokensCss = readFileSync(new URL("./styles/tokens.css", import.meta.url), "utf8");
    const light = tokensCss.slice(tokensCss.indexOf(":root"), tokensCss.indexOf(".dark{"));
    for (const [, c] of SCOPES) {
      expect(css, c).toContain(`.${c}{color:var(${CLASS_VAR[c]})}`);
      expect(light, CLASS_VAR[c]).toContain(`${CLASS_VAR[c]}:`);
    }
    // Monaco's theme: each scope's colour is its class's tokens.css variable, read for the current mode.
    const theme = textmateTheme("cinder-dark", "dark", (cls) => `var(${cls ? CLASS_VAR[cls] : "--text"})`);
    expect(theme.settings.slice(1)).toEqual(SCOPES.map(([scope, c]) => ({ scope, settings: { foreground: `var(${CLASS_VAR[c]})` } })));
    // Dark mode redefines the colour tokens or inherits light's, so the same classes hold in both.
    expect(tokensCss.slice(tokensCss.indexOf(".dark{"))).toContain("--link:");
  });
});
