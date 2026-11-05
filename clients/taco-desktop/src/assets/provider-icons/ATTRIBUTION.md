# Provider icons

Brand marks for the built-in providers shown in Settings → Model.

## Source

- Package: `@lobehub/icons-static-svg` v1.102.0
- Repository: https://github.com/lobehub/lobe-icons
- License: MIT — © LobeHub

Files were copied verbatim from `icons/<name>.svg` in that package. Each SVG
uses `fill="currentColor"`, so the card stylesheet decides the color and the
icons stay legible in both dark and light mode.

| File | Provider id(s) it serves |
|---|---|
| `anthropic.svg` | `anthropic` |
| `openai.svg` | `openai` |
| `gemini.svg` | `google` |
| `xai.svg` | `xai` |
| `deepseek.svg` | `deepseek` |
| `moonshot.svg` | `moonshotai`, `moonshotai-cn` |
| `zai.svg` | `zai`, `zai-coding-cn` |
| `minimax.svg` | `minimax`, `minimax-cn` |
| `openrouter.svg` | `openrouter` |

## Trademarks

The underlying brand marks are the property of their respective owners. They
are included here to identify the provider a card refers to; the MIT license
covers the icon files, not the trademarks.

## Updating

Re-download the package and copy the named files again:

```bash
npm pack @lobehub/icons-static-svg
tar -xzf lobehub-icons-static-svg-<version>.tgz
cp package/icons/<name>.svg clients/taco-desktop/src/assets/provider-icons/
```

Bump the version above when doing so.
