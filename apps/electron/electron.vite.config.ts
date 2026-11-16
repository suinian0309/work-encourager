import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
// @ts-expect-error 纯 ESM 脚本，没有类型声明
import { whaleAssetsPlugin } from '../../scripts/whale-assets-plugin.mjs'

const shared = resolve(__dirname, '../../packages/shared')

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
    plugins: [
      vue(),
      whaleAssetsPlugin(resolve(__dirname, '../../assets/whale'), resolve(__dirname, 'out/renderer'))
    ],
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
