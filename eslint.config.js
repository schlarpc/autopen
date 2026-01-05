import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.test.ts", "src/*.test.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow 'never' in template literals (exhaustive switch pattern)
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNever: true },
      ],
    },
  },
  {
    // Relaxed rules for demo code
    files: ["demo/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    ignores: [
      "dist/",
      "demo-dist/",
      "node_modules/",
      "coverage/",
      "*.config.js",
      "*.config.ts",
    ],
  },
);
