import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
// @ts-expect-error 纯 ESM 脚本，没有类型声明
import { whaleAssetsPlugin } from '../../scripts/whale-assets-plugin.mjs'

export default defineConfig({
  plugins: [
    vue(),
    whaleAssetsPlugin(resolve(__dirname, '../../assets/whale'), resolve(__dirname, 'dist'))
  ],
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
