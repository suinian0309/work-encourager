import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin, ViteDevServer } from 'vite'

const shared = resolve(__dirname, '../../packages/shared')

/**
 * Cubism Core 必须是经典脚本（被 Vite 打包成模块后 var 不会挂到 window），
 * 所以从 npm 依赖里原样拷到产物根目录，而不是把 217KB 的第三方二进制提交进仓库。
 */
function live2dCorePlugin(outDir: string, devRoot: string): Plugin {
  const require = createRequire(import.meta.url)
  const findCore = (): string => require.resolve('@hazart-pkg/live2d-core/live2dcubismcore.js')
  return {
    name: 'live2d-core',
    apply: 'build',
    closeBundle() {
      mkdirSync(outDir, { recursive: true })
      copyFileSync(findCore(), resolve(outDir, 'live2dcubismcore.js'))
    },
    configureServer(server: ViteDevServer) {
      // 开发时直接从 node_modules 提供，避免再造一份副本
      server.middlewares.use('/live2dcubismcore.js', (_req, res, next) => {
        try {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
          res.end(readFileSync(findCore()))
        } catch {
          next()
        }
      })
      void devRoot
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': shared
      }
    },
    plugins: [vue(), live2dCorePlugin(resolve(__dirname, 'out/renderer'), resolve(__dirname, 'src/renderer'))],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          float: resolve(__dirname, 'src/renderer/float.html'),
          pet: resolve(__dirname, 'src/renderer/pet.html')
        }
      }
    }
  }
})
