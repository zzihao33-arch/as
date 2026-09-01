import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const stagingApiBaseUrl = process.env.VERCEL_GIT_COMMIT_REF === 'staging'
  && !process.env.VITE_CMHUB_API_BASE_URL
  ? 'https://api-test.cmhubtool.com'
  : undefined

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: stagingApiBaseUrl
    ? { 'import.meta.env.VITE_CMHUB_API_BASE_URL': JSON.stringify(stagingApiBaseUrl) }
    : undefined,
})
