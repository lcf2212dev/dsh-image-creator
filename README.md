# dsh-image-creator

Bundle package: `@dsh-burn-plugins/dsh-image-creator`. License: [MIT](LICENSE).

DeepSeek Harness plugin that exposes one model-facing tool, **`create_image`**:
it turns a text prompt into a real image file. The visual design is delegated
to a fresh Claude Code session through the **`claude_delegate`** tool — **Claude
Fable 5.2, effort `high`** by default — which returns one self-contained HTML or
SVG document, and the plugin renders that document locally into PNG, JPEG, WebP
or SVG. The agent gets back the saved path, the final pixel size and a short
design note.

This plugin is a thin adapter. It does not talk to the Claude CLI itself, pin an
SDK, or hold credentials: it calls the `claude_delegate` tool registered by
[`@dsh-burn-plugins/dsh-claude-delegate`](../dsh-claude-delegate), which owns the
CLI command, environment scrubbing, working directory and cancellation.
Rendering is a host concern: Chrome headless for HTML designs, librsvg (or
ImageMagick) for SVG designs, ImageMagick for JPEG/WebP.

Pair it with [`@dsh-burn-plugins/dsh-image-viewer`](../dsh-image-viewer): create
the image, then check the saved file with `view_image` before reporting it.

## How it works

Each `create_image` call:

1. validates `prompt`, resolves the output path (absolute, or relative to the
   session working directory; default
   `<session>/created-images/<slug>-<timestamp>.<format>`) and the canvas size;
2. asks `claude_delegate` for **one** self-contained document: an HTML5 page
   (default) or an SVG document (when `format: svg`, or when no browser is
   installed but a vector rasterizer is). The child runs read-only: it answers
   with markup and cannot edit the workspace;
3. extracts the document from the answer, refusing prose when no markup came
   back;
4. renders it locally:
   - HTML → Chrome/Chromium headless screenshot at the exact viewport size,
   - SVG → `rsvg-convert`, falling back to ImageMagick,
   - JPEG/WebP → ImageMagick conversion of the rendered PNG;
5. verifies the written file (magic bytes and pixel size, resizing with
   ImageMagick only when a rasterizer drifted from the requested canvas);
6. returns `Created image: <path>`, its dimensions, byte size and the designer's
   one-line note.

The plugin also:

- registers a short prompt section stating that images are always created with
  `create_image`, not hand-written SVG/HTML or render commands;
- denies other image-generation tools — `generate_image` and
  `generate_vector_illustration`, including MCP-qualified names — with a message
  that redirects to `create_image` (`blockGenerators`), so images always go
  through this plugin.

## Requirements

- The `@dsh-burn-plugins/dsh-claude-delegate` bundle installed and enabled, with
  the `claude_delegate` tool available and `claude` logged in (subscription).
- One local renderer:
  - **Chrome or Chromium** for HTML designs (the default and best-quality
    path), found automatically in the common locations or set with
    `chromePath`;
  - **librsvg2-bin** (`rsvg-convert`) or **ImageMagick** for SVG designs and for
    JPEG/WebP output.
- **Claude Code 2.1.321 or later** for the `fable` alias to resolve to
  **Fable 5.2**; check with `claude --version`.
- Calls to Fable may bill usage credits depending on the plan; `claude -p` does
  not ask before spending them.

## Installation

The bundle is installed with the Harness plugin manager (`plugin_manager`,
`install_bundle`, target = this directory). It adds the dependency link and the
bundle selection to the profile. A new session sees the tool on its next model
request; this profile's existing sessions pick it up from the live tool
registry.

The plugin ships no machine-specific values: the row config below falls back to
the defaults.

## Configuration (row `image-creator`)

| field | default | meaning |
|---|---|---|
| `model` | `fable` | model alias handed to `claude_delegate` |
| `effort` | `high` | reasoning effort handed to `claude_delegate` |
| `readOnly` | `true` | run the Claude Code child in plan mode (read-only) |
| `width` | `1024` | default output width in pixels (16–4096) |
| `height` | `1024` | default output height in pixels (16–4096) |
| `directory` | `created-images` | directory for calls without `path`, relative to the session working directory |
| `chromePath` | `""` | explicit Chrome/Chromium executable; empty means search the common locations |
| `blockGenerators` | `true` | deny other image-generation tools with a `create_image` redirect |

Override the row from the profile patch instead of editing this repository
(`cordis.patch.yml` in the profile takes precedence over the bundle row):

```yaml
- id: image-creator
  name: "@dsh-burn-plugins/dsh-image-creator"
  config:
    model: fable
    effort: high
    width: 1024
    height: 1024
    directory: created-images
    blockGenerators: true
```

The override `config` replaces the row's config entirely; omitted fields fall
back to the defaults.

## Tool parameters

- `prompt` *(required)* — what the image should show: subject, composition,
  style, colors and any text to place, in the user's language.
- `path` — where to save the image: absolute, or relative to the session working
  directory. Default: `created-images/<slug>-<timestamp>.<format>`. The
  extension sets the format when `format` is omitted.
- `width`, `height` — output pixels, 16–4096. Default: the row settings (1024
  each).
- `format` — `png` (default), `jpg`, `webp` or `svg`.
- `transparent` — leave the canvas transparent (PNG/WebP); JPEG is flattened
  onto white.

Example call and result:

```text
create_image({
  prompt: "Ícone de um foguete laranja decolando de um círculo azul, fundo transparente",
  width: 512,
  height: 512,
  transparent: true,
  path: "assets/rocket.png"
})
```

```text
Created image: /workspace/assets/rocket.png
512×512 PNG, 41.2 KB
Design: A flat orange rocket lifting off inside a blue circle, no background.
```

## Limitations

- **Graphic artwork, not photographs.** The designer draws with HTML/CSS/SVG, so
  the output is flat/vector-style illustration, icons, logos, diagrams, posters,
  banners and mockups. It cannot produce photorealistic photos; that needs an
  image-generation model API.
- One image per call; no image input for editing an existing picture. Describe
  the change with `path` pointing at a new file.
- Blocking: the agent waits for the Claude Code run and the local render
  (typically tens of seconds to a couple of minutes) and can cancel from the UI.
- The design quality follows the delegated model; the delegate does not see the
  Harness conversation, only the prompt.
- HTML rendering needs Chrome/Chromium. Without one the plugin falls back to
  asking for an SVG design, which renders with `rsvg-convert` or ImageMagick.
- The answer language follows the prompt; the plugin adds no translation.

## Troubleshooting

- **`create_image: the claude_delegate tool is not available`** — install and
  enable `@dsh-burn-plugins/dsh-claude-delegate` in the same profile.
- **`create_image: no renderer found`** — install Chrome/Chromium (best) or
  `librsvg2-bin`/ImageMagick; on a non-standard Chrome install, set `chromePath`
  in the row.
- **`create_image: install ImageMagick to write jpg images`** — PNG and SVG need
  no extra tool; install ImageMagick for JPEG/WebP.
- **`create_image: the designer returned no usable HTML document`** — the
  delegated model answered with prose; retry the call, and prefer a concrete,
  visual prompt.
