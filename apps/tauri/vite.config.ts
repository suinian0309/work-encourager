import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import type { Plugin, ViteDevServer } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * Cubism Core 必须是经典脚本（被 Vite 打包成模块后 var 不会挂到 window），
 * 所以从 npm 依赖里原样拷到产物根目录，而不是把 217KB 的第三方二进制提交进仓库。
 */
function live2dCorePlugin(outDir: string): Plugin {
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
      server.middlewares.use('/live2dcubismcore.js', (_req, res, next) => {
        try {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
          res.end(readFileSync(findCore()))
        } catch {
          next()
        }
      })
    }
  }
}

export default defineConfig({
  plugins: [vue(), live2dCorePlugin(resolve(__dirname, 'dist'))],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, '../../packages/shared')
    }
  },
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        float: resolve(__dirname, 'float.html'),
        pet: resolve(__dirname, 'pet.html')
      }
    }
  },
  clearScreen: false
})
