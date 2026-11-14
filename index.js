/**
 * Image creator — one model-facing tool that turns a text prompt into a real
 * image file.
 *
 * The visual design is delegated to `claude_delegate` (Claude Fable 5.2 at high
 * effort by default): the child returns one self-contained HTML or SVG
 * document, and this plugin renders it locally — Chrome headless for HTML,
 * librsvg (or ImageMagick) for SVG — into the requested PNG, JPEG, WebP or SVG
 * file. Model choice, effort, credentials and CLI location stay owned by the
 * claude-delegate plugin; rendering tools stay a host concern.
 *
 * `readOnly` keeps the child in plan mode: it answers with markup and cannot
 * edit the workspace. The plugin itself writes the image and validates it
 * (magic bytes and pixel size) before returning the path.
 *
 * @module @dsh-burn-plugins/dsh-image-creator
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { executable, extractDesign, findChrome, OUTPUT_FORMATS, renderDesign } from './render.js'

/** Cordis plugin name. */
export const name = 'image-creator'
/** Host services this plugin contributes to. */
export const inject = ['tools', 'systemPrompt']

/** The tool that performs the actual Claude Code run. */
const DELEGATE_TOOL = 'claude_delegate'
/** Fallback order for the prompt section beside the built-in write sections. */
const TOOL_WRITE_ORDER = 1200
/** Pixel bounds for one image. */
const MIN_DIMENSION = 16
const MAX_DIMENSION = 4096
/** Longest prompt forwarded to the designer. */
const MAX_PROMPT = 6000
/** Result-line labels for the output formats. */
const FORMAT_LABELS = { png: 'PNG', jpg: 'JPEG', webp: 'WebP', svg: 'SVG' }

export const Config = z.object({
  /** Model alias handed to claude_delegate; Fable 5.2 is the CLI's `fable` alias. */
  model: z.string().default('fable'),
  /** Reasoning effort handed to claude_delegate. */
  effort: z.string().default('high'),
  /** Run the Claude Code child in plan mode (read-only; it cannot edit files). */
  readOnly: z.boolean().default(true),
  /** Default output width in pixels when the call omits `width`. */
  width: z.number().min(MIN_DIMENSION).max(MAX_DIMENSION).default(1024),
  /** Default output height in pixels when the call omits `height`. */
  height: z.number().min(MIN_DIMENSION).max(MAX_DIMENSION).default(1024),
  /** Directory (relative to the session working directory) for calls without `path`. */
  directory: z.string().default('created-images'),
  /** Explicit Chrome/Chromium executable; empty means search the common locations. */
  chromePath: z.string().default(''),
  /** Deny other image-generation tools so images always go through create_image. */
  blockGenerators: z.boolean().default(true)
})

/** Human label for the configured model alias. @param {string} model @returns {string} */
function modelLabel(model) {
  switch (model) {
    case 'fable':
      return 'Claude Fable 5.2'
    case 'opus':
      return 'Claude Opus'
    case 'sonnet':
      return 'Claude Sonnet'
    case 'haiku':
      return 'Claude Haiku'
    default:
      return `Claude (${model})`
  }
}

/**
 * The session's working directory, falling back to the Host process directory
 * outside an Agent or when the service is absent.
 * @param {any} ctx
 * @param {any} exec
 * @returns {Promise<string>}
 */
async function sessionDirectory(ctx, exec) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory !== undefined && exec.agent !== undefined) {
    try {
      return await workingDirectory.ensure(exec.agent, exec.signal)
    } catch {
      // Cancellation or an unavailable directory: fall back below.
    }
  }
  return process.cwd()
}

/** @param {number} bytes @returns {string} */
function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** @param {string} text @returns {string} */
function slug(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/** Local `YYYYMMDD-HHmmss` stamp for default file names. @returns {string} */
function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  ].join('-')
}

/**
 * Resolve the requested pixel dimension.
 * @param {unknown} requested
 * @param {number} fallback
 * @param {string} label
 * @returns {number}
 */
function dimension(requested, fallback, label) {
  if (requested === undefined) return fallback
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    throw new Error(`create_image: ${label} must be a number of pixels`)
  }
  const value = Math.round(requested)
  if (value < MIN_DIMENSION || value > MAX_DIMENSION) {
    throw new Error(`create_image: ${label} must be between ${MIN_DIMENSION} and ${MAX_DIMENSION} pixels`)
  }
  return value
}

/**
 * Normalize one format name.
 * @param {string} value
 * @returns {'png' | 'jpg' | 'webp' | 'svg' | undefined}
 */
function normalizeFormat(value) {
  const format = value.trim().toLowerCase()
  if (format === 'jpeg' || format === 'jpg') return 'jpg'
  return OUTPUT_FORMATS.has(format) ? /** @type {'png'|'webp'|'svg'|'jpg'} */ (format) : undefined
}

/**
 * Pick the output format from the explicit parameter, the requested path's
 * extension, or PNG.
 * @param {unknown} requestedFormat
 * @param {unknown} requestedPath
 * @returns {'png' | 'jpg' | 'webp' | 'svg'}
 */
function resolveFormat(requestedFormat, requestedPath) {
  const explicit = typeof requestedFormat === 'string' && requestedFormat.trim() !== ''
    ? normalizeFormat(requestedFormat)
    : undefined
  if (requestedFormat !== undefined && explicit === undefined) {
    throw new Error('create_image: format must be png, jpg, webp or svg')
  }
  const extension = typeof requestedPath === 'string' && requestedPath.trim() !== ''
    ? path.extname(requestedPath).toLowerCase()
    : ''
  const fromPath = extension === '' ? undefined : normalizeFormat(extension.slice(1))
  if (explicit !== undefined && fromPath !== undefined && explicit !== fromPath) {
    throw new Error(`create_image: format "${explicit}" disagrees with the path extension "${extension}"`)
  }
  if (explicit !== undefined) return explicit
  if (fromPath !== undefined) return fromPath
  const unknown = extension === '' ? undefined : extension
  if (unknown !== undefined) {
    throw new Error(`create_image: "${unknown}" is not a supported image extension; use .png, .jpg, .webp or .svg`)
  }
  return 'png'
}

/**
 * Resolve the absolute output path.
 * @param {string} directory session working directory
 * @param {unknown} requested
 * @param {'png' | 'jpg' | 'webp' | 'svg'} format
 * @param {string} prompt
 * @param {string} folder configured fallback directory, relative to the session
 * @returns {string}
 */
function outputPath(directory, requested, format, prompt, folder) {
  if (typeof requested === 'string' && requested.trim() !== '') {
    const absolute = path.isAbsolute(requested) ? requested : path.resolve(directory, requested)
    const extension = path.extname(absolute).toLowerCase()
    if (extension === '') return `${absolute}.${format}`
    return absolute
  }
  const name = `${slug(prompt) || 'image'}-${timestamp()}-${randomUUID().slice(0, 4)}.${format}`
  return path.resolve(directory, folder === '' ? 'created-images' : folder, name)
}

/**
 * The delegated design task: ask for one self-contained document.
 * @param {{ prompt: string, kind: 'html' | 'svg', width: number, height: number, transparent: boolean }} options
 * @returns {string}
 */
function designTask({ prompt, kind, width, height, transparent }) {
  const canvas = `${width}x${height}`
  const lines = [
    'You are the designer for one image. Another process renders your markup to an image file; it will not edit or reinterpret it, and it cannot see this conversation, so put everything needed in your answer.',
    '',
    `Canvas: exactly ${canvas} pixels. Every element must fit inside it; nothing may be clipped or need scrolling.`,
    `Background: ${transparent ? 'transparent — do not paint a full-canvas background.' : 'painted so the whole canvas is covered.'}`,
    ''
  ]
  if (kind === 'svg') {
    lines.push(
      'Return ONE standalone SVG document this shape:',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">…</svg>`,
      'Rules: SVG 1.1 with presentation attributes (fill, stroke, opacity, transform); no <script>, no external files, no network, no @import, no embedded raster data; system font families only.',
      'Draw with shapes, paths, gradients and text. Flat vector-style artwork is expected — this is not a photographic renderer.'
    )
  } else {
    lines.push(
      'Return ONE complete, self-contained HTML5 document: <!doctype html>, one <style> block in the head, and the artwork in the body.',
      'Rules: no <script>, no external files or URLs, no network, no @import, no remote fonts; system font families only (for example "DejaVu Sans", "Noto Sans", "Liberation Sans", sans-serif).',
      'The body must fill the canvas exactly (html,body{margin:0;width:' + width + 'px;height:' + height + 'px;overflow:hidden}).',
      'Draw with CSS and inline SVG: gradients, shapes, cards, illustration, diagrams. Flat vector-style artwork is expected — this is not a photographic renderer.'
    )
  }
  lines.push(
    '',
    'Quality bar: a finished, balanced composition — clear focal point, intentional palette, consistent spacing, legible text at the output size.',
    'Include text only when the request asks for it, and reproduce it exactly as given. Use the language of the request for any wording you invent.',
    '',
    kind === 'svg'
      ? 'Return the SVG document in one ```svg fenced block, then one short line describing what you drew. Nothing else.'
      : 'Return the HTML document in one ```html fenced block, then one short line describing what you drew. Nothing else.',
    '',
    'Image request:',
    prompt
  )
  return lines.join('\n')
}

/**
 * Flatten a delegate tool result to its text answer.
 * @param {{ content?: Array<{ type: string, text?: string }>, value?: unknown } | undefined} result
 * @returns {string}
 */
function resultText(result) {
  if (result === undefined) return ''
  const text = (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (text !== '') return text
  return typeof result.value === 'string' ? result.value.trim() : ''
}

/**
 * Prefer HTML rendering (Chrome) and fall back to an SVG design when no browser
 * is available but a vector rasterizer is.
 * @param {'png' | 'jpg' | 'webp' | 'svg'} format
 * @param {string} chromePath
 * @returns {Promise<'html' | 'svg'>}
 */
async function chooseKind(format, chromePath) {
  if (format === 'svg') return 'svg'
  const chrome = await findChrome(chromePath).catch(() => undefined)
  if (chrome !== undefined) return 'html'
  const vector = (await executable('rsvg-convert')) ?? (await executable('magick')) ?? (await executable('convert'))
  if (vector !== undefined) return 'svg'
  throw new Error(
    'create_image: no renderer found; install Chrome/Chromium for HTML designs, or librsvg2-bin or ImageMagick for SVG designs'
  )
}

/**
 * Register `create_image`, its prompt guidance, and the generator guard.
 * @param {any} ctx
 * @param {any} config
 */
export function apply(ctx, config) {
  const model = config.model ?? 'fable'
  const effort = config.effort ?? 'high'
  const label = `${modelLabel(model)} · ${effort} effort`

  ctx.tools.register(
    defineTool({
      name: 'create_image',
      description: [
        'Create an image file from a text prompt.',
        'Draws the requested illustration, icon, logo, diagram, poster, banner, background or mockup and saves it as PNG, JPEG, WebP or SVG.',
        'Returns the absolute path, the final pixel size and a one-line note about the design.',
        'Use this for every image the user asks you to create; it produces graphic, vector-style artwork, not photorealistic photos.'
      ].join(' '),
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description:
            'What the image should show: subject, composition, style, colors and any text to place, written in the user\'s language. Be specific enough to draw from.'
        },
        path: {
          type: 'string',
          description:
            'Where to save the image: absolute, or relative to the session working directory. Default: created-images/<slug>-<timestamp>.<format>. The extension sets the format when `format` is omitted.'
        },
        width: {
          type: 'number',
          description: `Output width in pixels, ${MIN_DIMENSION}–${MAX_DIMENSION}. Default: the plugin row setting, 1024.`
        },
        height: {
          type: 'number',
          description: `Output height in pixels, ${MIN_DIMENSION}–${MAX_DIMENSION}. Default: the plugin row setting, 1024.`
        },
        format: {
          type: 'string',
          enum: ['png', 'jpg', 'jpeg', 'webp', 'svg'],
          description:
            'Output format. Default: the path extension when `path` is given, otherwise png. JPEG and WebP are flattened/compressed; SVG keeps the vector document.'
        },
        transparent: {
          type: 'boolean',
          description:
            'Leave the canvas transparent (PNG and WebP). JPEG has no alpha, so it is flattened onto white.'
        }
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }]
      },
      isConcurrencySafe: false,
      presentCall: (args) => ({
        card: 'generic',
        title: `Create image · ${label}`,
        kind: 'write',
        rawInput: typeof args.prompt === 'string' ? args.prompt : ''
      }),
      async execute(args, exec) {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt === '') throw new Error('create_image: prompt must be a non-empty string')
        if (prompt.length > MAX_PROMPT) {
          throw new Error(`create_image: prompt is too long (over ${MAX_PROMPT} characters); describe the image more briefly`)
        }
        const width = dimension(args.width, config.width ?? 1024, 'width')
        const height = dimension(args.height, config.height ?? 1024, 'height')
        const format = resolveFormat(args.format, args.path)
        const directory = await sessionDirectory(ctx, exec)
        const target = outputPath(directory, args.path, format, prompt, config.directory ?? 'created-images')

        if (ctx.tools.get(DELEGATE_TOOL, exec.agent) === undefined) {
          throw new Error(
            `create_image: the ${DELEGATE_TOOL} tool is not available; install and enable the Claude Delegate plugin in this profile`
          )
        }

        const kind = await chooseKind(format, config.chromePath ?? '')
        const task = designTask({ prompt, kind, width, height, transparent: args.transparent === true })
        let batch
        try {
          batch = await ctx.tools.execute({
            calls: [
              {
                type: 'tool-call',
                id: `create_image_${randomUUID()}`,
                name: DELEGATE_TOOL,
                arguments: JSON.stringify({
                  task,
                  model,
                  effort,
                  ...(config.readOnly === false ? {} : { readOnly: true })
                })
              }
            ],
            signal: exec.signal,
            agent: exec.agent
          })
        } catch (error) {
          throw new Error(
            `create_image: the Claude delegate could not run: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          )
        }
        const result = batch.results[0]?.result
        const answer = resultText(result)
        if (result?.isError === true) {
          throw new Error(`create_image: the Claude delegate failed${answer === '' ? '' : `: ${answer}`}`)
        }
        if (answer === '') throw new Error('create_image: the Claude delegate returned no text')

        const design = extractDesign(answer, kind)
        if (design === undefined) {
          const snippet = answer.length > 500 ? `${answer.slice(0, 500)}…` : answer
          throw new Error(
            `create_image: the designer returned no usable ${kind === 'svg' ? 'SVG' : 'HTML'} document: ${snippet}`
          )
        }

        await mkdir(path.dirname(target), { recursive: true })
        const image = await renderDesign({
          design,
          outPath: target,
          width,
          height,
          format,
          transparent: args.transparent === true,
          chromePath: config.chromePath ?? '',
          ...(exec.signal === undefined ? {} : { signal: exec.signal })
        })

        const lines = [
          `Created image: ${target}`,
          `${image.width}×${image.height} ${FORMAT_LABELS[image.format] ?? image.format.toUpperCase()}, ${humanBytes(image.bytes)}`
        ]
        if (design.note !== '') lines.push(`Design: ${design.note}`)
        return lines.join('\n')
      }
    })
  )

  const sectionOrder = ctx.systemPrompt.getSectionOrder?.('TOOL_WRITE') ?? TOOL_WRITE_ORDER
  ctx.systemPrompt.section({
    name: 'tool:create_image',
    order: sectionOrder,
    text: [
      'To create any image, always call create_image instead of writing the SVG, HTML or render command yourself.',
      'When the result matters, check the saved file with view_image before reporting it.'
    ].join(' ')
  })

  if (config.blockGenerators !== false && typeof ctx.tools.guard === 'function') {
    ctx.tools.guard((exec) => {
      if (!/(?:^|__)generate_(?:image|vector_illustration)$/.test(exec.name)) return undefined
      return 'Images in this profile are created by the dsh-image-creator plugin: call create_image instead, which designs the image and writes a PNG, JPEG, WebP or SVG file in the workspace.'
    })
  }
}
