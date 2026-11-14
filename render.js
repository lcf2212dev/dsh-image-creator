/**
 * Local rendering for @dsh-burn-plugins/dsh-image-creator.
 *
 * The delegate returns one self-contained document (HTML or SVG); this module
 * turns it into an image file using tools already installed on the host:
 *
 *   HTML -> Chrome headless screenshot at the exact viewport size
 *   SVG  -> rsvg-convert, falling back to ImageMagick
 *   PNG  -> JPEG/WebP through ImageMagick when another format was requested
 *
 * Nothing here touches the network. Every subprocess is bounded by a timeout
 * and killed when the tool call is cancelled, and every failure names the tool
 * that was missing or the command that failed.
 *
 * @module @dsh-burn-plugins/dsh-image-creator/render
 */

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Captured stdout/stderr per stream before the tail is dropped. */
const MAX_CAPTURE_BYTES = 256 * 1024
/** Upper bound for one Chrome screenshot. */
const CHROME_TIMEOUT_MS = 120_000
/** Upper bound for one raster/convert command. */
const RASTER_TIMEOUT_MS = 60_000
/** Formats this plugin can write. */
export const OUTPUT_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg'])
/** Chrome builds to try, in order; the first executable that exists wins. */
const CHROME_CANDIDATES = [
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'msedge'
]

/** Is `file` a regular file? @param {string} file @returns {Promise<boolean>} */
async function isFile(file) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/** Is `file` an executable regular file? @param {string} file @returns {Promise<boolean>} */
async function isExecutable(file) {
  const mode = process.platform === 'win32' ? constants.F_OK : constants.X_OK
  try {
    await access(file, mode)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a command name or path to an executable path.
 * @param {string} command
 * @returns {Promise<string | undefined>}
 */
export async function executable(command) {
  if (command.includes('/') || command.includes('\\')) {
    return (await isExecutable(command)) ? command : undefined
  }
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry !== '')
  for (const entry of entries) {
    const candidate = path.join(entry, command)
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * Find a Chrome-family browser for HTML screenshots.
 * @param {string} configured explicit path, or '' to search
 * @returns {Promise<string | undefined>}
 */
export async function findChrome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    const found = await executable(configured.trim())
    if (found !== undefined) return found
    throw new Error(`create_image: chromePath "${configured}" is not an executable file`)
  }
  for (const candidate of CHROME_CANDIDATES) {
    const found = await executable(candidate)
    if (found !== undefined) return found
  }
  return undefined
}

/** Trim captured output to a readable tail. @param {string} text @returns {string} */
function tail(text) {
  const trimmed = text.trim()
  return trimmed.length <= 1200 ? trimmed : `…${trimmed.slice(-1200)}`
}

/**
 * Run one subprocess to completion.
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut?: boolean, aborted?: boolean, error?: Error }>}
 */
function run(command, args, options) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const append = (current, chunk) => {
      if (current.length >= MAX_CAPTURE_BYTES) return current
      const text = chunk.toString('utf8')
      return current + text.slice(0, MAX_CAPTURE_BYTES - current.length)
    }
    const onAbort = () => {
      child.kill('SIGKILL')
      finish({ code: null, stdout, stderr, aborted: true })
    }
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.on('error', (error) => finish({ code: null, stdout, stderr, error }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: null, stdout, stderr, timedOut: true })
    }, options.timeoutMs)
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Throw a readable error for a failed subprocess.
 * @param {string} label
 * @param {Awaited<ReturnType<typeof run>>} result
 */
function assertRan(label, result) {
  if (result.aborted === true) throw new Error(`create_image: ${label} was cancelled`)
  if (result.timedOut === true) throw new Error(`create_image: ${label} timed out`)
  if (result.error !== undefined) {
    throw new Error(`create_image: ${label} could not start: ${result.error.message}`, { cause: result.error })
  }
  if (result.code !== 0) {
    const detail = tail(result.stderr) || tail(result.stdout)
    throw new Error(`create_image: ${label} failed (exit ${result.code})${detail === '' ? '' : `: ${detail}`}`)
  }
}

/**
 * Read the format and pixel size from an image header.
 * @param {Buffer} buffer
 * @returns {{ format: string, width?: number, height?: number } | undefined}
 */
export function sniffImage(buffer) {
  if (buffer.length < 12) return undefined
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    if (buffer.length < 24) return { format: 'png' }
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    const size = jpegSize(buffer)
    return { format: 'jpg', ...(size ?? {}) }
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { format: 'webp' }
  }
  if (/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) {
    return { format: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  return undefined
}

/**
 * Scan JPEG markers for the frame size.
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number } | undefined}
 */
function jpegSize(buffer) {
  let offset = 2
  while (offset + 9 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return undefined
    const length = buffer.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    if (length < 2) return undefined
    offset += 2 + length
  }
  return undefined
}

/** Every fenced code block body in a delegate answer. @param {string} text @returns {string[]} */
function fencedBlocks(text) {
  const blocks = []
  for (const match of text.matchAll(/```([\w-]*)[ \t]*\r?\n([\s\S]*?)```/g)) {
    const body = match[2].trim()
    if (body !== '') blocks.push(body)
  }
  return blocks
}

/**
 * The SVG document inside a candidate string, if any.
 * @param {string} candidate
 * @returns {string | undefined}
 */
function svgSpan(candidate) {
  const open = candidate.search(/<svg\b/i)
  if (open === -1) return undefined
  const close = candidate.toLowerCase().lastIndexOf('</svg>')
  if (close === -1 || close <= open) return undefined
  const markup = candidate.slice(open, close + '</svg>'.length).trim()
  return markup.length > 40 ? markup : undefined
}

/**
 * The HTML document inside a candidate string, if any.
 * @param {string} candidate
 * @returns {string | undefined}
 */
function htmlSpan(candidate) {
  const text = candidate.trim()
  if (!/^</.test(text)) return undefined
  if (/<!doctype\s+html/i.test(text) || /<html[\s>]/i.test(text)) return text
  if (/<(body|head|main|div|section|style)\b/i.test(text)) return text
  return undefined
}

/**
 * Pull one usable document and a one-line design note out of the delegate
 * answer.
 * @param {string} text
 * @param {'html' | 'svg'} preferred
 * @returns {{ kind: 'html' | 'svg', markup: string, note: string } | undefined}
 */
export function extractDesign(text, preferred) {
  const candidates = [...fencedBlocks(text), text]
  const kinds = preferred === 'svg' ? ['svg', 'html'] : ['html', 'svg']
  for (const candidate of candidates) {
    for (const kind of kinds) {
      const markup = kind === 'svg' ? svgSpan(candidate) : htmlSpan(candidate)
      if (markup !== undefined) return { kind, markup, note: designNote(text) }
    }
  }
  return undefined
}

/**
 * The delegate's own one-line description of the design, outside the document.
 * @param {string} text
 * @returns {string}
 */
export function designNote(text) {
  const stripped = text
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '\n')
    .replace(/<!doctype[\s\S]*<\/html>/gi, '\n')
  const line = stripped
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry !== '' && !entry.startsWith('<'))
  return line === undefined ? '' : line.slice(0, 300)
}

/**
 * Wrap or frame a document so the viewport is exactly the requested canvas.
 * @param {string} markup
 * @param {number} width
 * @param {number} height
 * @param {boolean} transparent
 * @returns {string}
 */
export function frameHtml(markup, width, height, transparent) {
  const frame = [
    '<style id="dsh-image-creator-frame">',
    `html,body{margin:0;padding:0;overflow:hidden;width:${width}px;height:${height}px}`,
    transparent ? 'html,body{background:transparent}' : '',
    '</style>'
  ].join('')
  let html = markup.trim()
  if (!/<!doctype\s+html/i.test(html) && !/<html[\s>]/i.test(html)) {
    return `<!doctype html><html><head><meta charset="utf-8">${frame}</head><body>${html}</body></html>`
  }
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${frame}</head>`)
  if (/<html[\s>]/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${frame}</head>`)
  return `<!doctype html><html><head>${frame}</head><body>${html}</body></html>`
}

/** Chrome flags for a deterministic local screenshot. @param {object} options @returns {string[]} */
function chromeArgs({ width, height, pngPath, htmlPath, profileDir, transparent }) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-color-profile=srgb',
    '--force-device-scale-factor=1',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=1500',
    ...(transparent ? ['--default-background-color=00000000'] : []),
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`
  ]
}

/** Write-and-render scratch directory. @returns {Promise<string>} */
async function scratchDirectory() {
  return mkdtemp(path.join(tmpdir(), 'dsh-image-creator-'))
}

/**
 * Render one extracted document to the requested file.
 * @param {object} options
 * @param {{ kind: 'html' | 'svg', markup: string }} options.design
 * @param {string} options.outPath absolute destination
 * @param {number} options.width
 * @param {number} options.height
 * @param {'png' | 'jpg' | 'jpeg' | 'webp' | 'svg'} options.format
 * @param {boolean} [options.transparent]
 * @param {string} [options.chromePath]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ bytes: number, width: number, height: number, format: string }>}
 */
export async function renderDesign(options) {
  const { design, outPath, width, height, format: requested, transparent = false, chromePath = '', signal } = options
  const format = requested === 'jpeg' ? 'jpg' : requested
  let scratch
  try {
    scratch = await scratchDirectory()
    const sourcePath = path.join(scratch, design.kind === 'svg' ? 'source.svg' : 'source.html')

    if (format === 'svg') {
      if (design.kind !== 'svg') {
        throw new Error('create_image: the designer returned HTML, but an SVG file was requested')
      }
      const bytes = Buffer.byteLength(design.markup)
      if (bytes === 0) throw new Error('create_image: the designer returned an empty SVG document')
      await writeFile(outPath, design.markup, 'utf8')
      return { bytes, width, height, format: 'svg' }
    }

    const pngPath = path.join(scratch, 'render.png')
    /** @type {Awaited<ReturnType<typeof run>> | undefined} */
    let rendererRun
    if (design.kind === 'svg') {
      await writeFile(sourcePath, design.markup, 'utf8')
      const rsvg = await executable('rsvg-convert')
      if (rsvg !== undefined) {
        rendererRun = await run(rsvg, ['-w', String(width), '-h', String(height), '-o', pngPath, sourcePath], {
          timeoutMs: RASTER_TIMEOUT_MS,
          ...(signal === undefined ? {} : { signal })
        })
        assertRan('svg rendering (rsvg-convert)', rendererRun)
      } else {
        const magick = (await executable('magick')) ?? (await executable('convert'))
        if (magick === undefined) {
          throw new Error('create_image: install librsvg2-bin (rsvg-convert) or ImageMagick to render SVG designs')
        }
        rendererRun = await run(
          magick,
          ['-background', 'none', '-density', '192', sourcePath, '-resize', `${width}x${height}!`, pngPath],
          { timeoutMs: RASTER_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) }
        )
        assertRan('svg rendering (ImageMagick)', rendererRun)
      }
    } else {
      const chrome = await findChrome(chromePath)
      if (chrome === undefined) {
        throw new Error(
          'create_image: no Chrome/Chromium found for HTML rendering; install one or set chromePath in the plugin row'
        )
      }
      const html = frameHtml(design.markup, width, height, transparent)
      await writeFile(sourcePath, html, 'utf8')
      const profileDir = path.join(scratch, 'chrome-profile')
      rendererRun = await run(
        chrome,
        chromeArgs({ width, height, pngPath, htmlPath: sourcePath, profileDir, transparent }),
        { timeoutMs: CHROME_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) }
      )
      assertRan('HTML rendering (Chrome headless)', rendererRun)
    }

    if (!(await isFile(pngPath))) {
      const detail = rendererRun === undefined ? '' : tail(rendererRun.stderr) || tail(rendererRun.stdout)
      throw new Error(`create_image: the renderer wrote no image file${detail === '' ? '' : `: ${detail}`}`)
    }
    await enforceCanvas(pngPath, width, height)
    const png = await readFile(pngPath)
    const info = sniffImage(png)
    if (info === undefined || info.format !== 'png') throw new Error('create_image: the renderer did not write a PNG')

    if (format === 'png') {
      await writeFile(outPath, png)
    } else {
      await convertFormat(pngPath, outPath, format, signal)
    }

    const written = await readFile(outPath)
    const outInfo = sniffImage(written)
    if (outInfo === undefined) throw new Error(`create_image: the written file is not a recognized ${format} image`)
    return {
      bytes: written.length,
      width: outInfo.width ?? info.width ?? width,
      height: outInfo.height ?? info.height ?? height,
      format
    }
  } finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Force a PNG to the exact requested pixel size when a rasterizer produced
 * something else, using ImageMagick when available.
 * @param {string} pngPath
 * @param {number} width
 * @param {number} height
 */
async function enforceCanvas(pngPath, width, height) {
  const before = sniffImage(await readFile(pngPath))
  if (before?.width === width && before?.height === height) return
  const magick = (await executable('magick')) ?? (await executable('convert'))
  if (magick === undefined) {
    throw new Error(
      `create_image: the renderer produced ${before?.width ?? '?'}x${before?.height ?? '?'} but ${width}x${height} was requested`
    )
  }
  const result = await run(magick, [pngPath, '-resize', `${width}x${height}!`, pngPath], { timeoutMs: RASTER_TIMEOUT_MS })
  assertRan('canvas resize (ImageMagick)', result)
}

/**
 * Convert the rendered PNG into JPEG or WebP.
 * @param {string} pngPath
 * @param {string} outPath
 * @param {'jpg' | 'webp'} format
 * @param {AbortSignal | undefined} signal
 */
async function convertFormat(pngPath, outPath, format, signal) {
  const magick = (await executable('magick')) ?? (await executable('convert'))
  if (magick === undefined) {
    throw new Error(`create_image: install ImageMagick to write ${format} images; PNG and SVG need no extra tool`)
  }
  const args =
    format === 'jpg'
      ? [pngPath, '-background', 'white', '-flatten', '-quality', '92', outPath]
      : [pngPath, '-quality', '92', outPath]
  const result = await run(magick, args, { timeoutMs: RASTER_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) })
  assertRan(`${format} conversion (ImageMagick)`, result)
}
