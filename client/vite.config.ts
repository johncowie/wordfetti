import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@wordfetti/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': process.env.VITE_API_URL ?? 'http://localhost:3000',
    },
  },
})
