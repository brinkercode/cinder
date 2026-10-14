import js from "@eslint/js";
import globals from "globals";
import banned from "./scripts/banned-packages.json" with { type: "json" };

export default [
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.wrangler/**", "seed/repos/**"] }, // seed/repos/*: separate projects
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.serviceworker, ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z]" }],
      "no-restricted-imports": ["error", {
        patterns: [...banned.map((name) => ({ group: [name, `${name}/*`], message: "Banned: see CONTRIBUTING.md, Frontend rules" })),
          { group: ["@/components/ui/*"], message: "No shadcn-style kits (CONTRIBUTING.md, Frontend rules)" }],
      }],
    },
  },
];
