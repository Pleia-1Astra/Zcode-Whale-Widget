// 路径与产品标识的唯一来源。数据目录、运行时、端口、IPC 前缀均为本插件专属
// （不与 fox 的 ~/.zcode/whale、也不与 ~/.dsh 交叉）。
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// lib/paths.mjs -> 插件根目录
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DESKTOP_DIR = path.join(PLUGIN_ROOT, 'desktop')
export const ASSETS_DIR = path.join(PLUGIN_ROOT, 'assets')

export const PLUGIN_NAME = 'deepseek-whale-widget'
export const PRODUCT_NAME = 'DeepSeek Whale Widget'
export const IPC_PREFIX = 'deepseek-whale:'

// 本地 HTTP 兼容宿主的默认监听地址。端口固定 3080 是原项目的既有契约
// （/dsh-whale/* 前端代码里全部是站内相对路径，换端口只需要改监听）。
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = Number(process.env.ZCODE_WHALE_PORT) || 3080

// 版本号单一来源：.zcode-plugin/plugin.json。healthz / MCP 握手 / CLI 都读它，
// 避免多处硬编码漂移。
export function pluginVersion() {
  try {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, '.zcode-plugin', 'plugin.json'), 'utf8')
    const v = JSON.parse(raw).version
    if (typeof v === 'string' && v.trim()) return v.trim()
  } catch (err) {}
  return '0.0.0'
}

// ZCode 用户目录（可用 ZCODE_HOME 覆盖，便于测试隔离）。
export const ZCODE_HOME = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')

// 本插件专属数据目录。不写 ~/.dsh（原项目目录）、不写 fox 的 ~/.zcode/whale。
export const DATA_DIR = process.env.DEEPSEEK_WHALE_DATA_DIR || path.join(ZCODE_HOME, 'deepseek-whale-widget')

// Electron 运行时（体积大，只装一次）：~/.zcode/deepseek-whale-widget/desktop-runtime
export const RUNTIME_DIR = path.join(DATA_DIR, 'desktop-runtime')
// 单例/亲缘判定的 marker 目录：electron 可执行体所在的 dist 目录。
export const OVERLAY_MARKER_DIR = path.join(RUNTIME_DIR, 'node_modules', 'electron', 'dist')

export const OVERLAY_INFO_FILE = path.join(DATA_DIR, 'overlay.json')
export const HOST_INFO_FILE = path.join(DATA_DIR, 'host.json')
export const START_LOCK_FILE = path.join(DATA_DIR, 'overlay-start.lock')
export const HOST_LOG_FILE = path.join(DATA_DIR, 'host.log')
export const OVERLAY_LOG_FILE = path.join(DATA_DIR, 'overlay-debug.log')

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  return DATA_DIR
}

export function overlayProfileDir(port = DEFAULT_PORT) {
  return path.join(DATA_DIR, 'overlay-profile-' + String(port))
}

export function localUrl(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  return `http://${host}:${port}`
}
