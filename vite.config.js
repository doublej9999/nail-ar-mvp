import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  server: { host: '0.0.0.0' },
});
