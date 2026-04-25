import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Set base to the repo name when deploying to GitHub Pages.
// Override with VITE_BASE=/ for previews on a custom domain or root path.
const base = process.env.VITE_BASE ?? '/trefoil-trace-inspector/'

export default defineConfig({
  base,
  plugins: [react()],
})
