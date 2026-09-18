import { defineConfig } from 'vite';
export default defineConfig({
  build: { rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
  server: {
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:3001', ws: true },
      '/api': { target: 'http://127.0.0.1:3001' },
    },
  },
});
