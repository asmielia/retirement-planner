import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'

const commitCount = execSync('git rev-list --count HEAD').toString().trim();

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(commitCount),
  },
  test: {
    globals: true,
    environment: 'node',
  },
})
