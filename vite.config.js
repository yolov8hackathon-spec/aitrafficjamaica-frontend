import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

const root = path.resolve(process.cwd(), 'public')

export default defineConfig({
  root,
  publicDir: false,   // no nested public/ inside public/
  server: {
    port: 3000,
    proxy: {
      // Forward all /api calls to production — keeps local dev working with real data
      '/api': {
        target: 'https://aitrafficja.com',
        changeOrigin: true,
        secure: true,
      },
      // Vercel Analytics script — not served locally, return empty to suppress 404
      '/_vercel/insights': {
        target: 'https://aitrafficja.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
  build: {
    outDir: path.resolve(process.cwd(), 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_debugger: true,
        pure_funcs: ['console.debug'],
        passes: 2,
      },
      mangle: {
        toplevel: true,   // safe now that all JS uses ES modules
        eval: false,
      },
      format: {
        comments: false,
      },
    },
    rollupOptions: {
      input: {
        main:    path.resolve(root, 'index.html'),
        admin:   path.resolve(root, 'admin.html'),
        account: path.resolve(root, 'account.html'),
      },
      output: {
        // Entry files: fixed names at dist root (no hash, no assets/ prefix).
        // Cached index.html references /main.js which always exists → no stale 404s.
        entryFileNames: '[name].js',
        // Shared chunks: keep content hashes under assets/ for immutable CDN caching.
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        // Split large vendor libs into their own chunks so each is smaller.
        // Smaller chunks = faster Cloudflare edge cache warm-up on new deploys.
        manualChunks(id) {
          if (id.includes('node_modules/hls.js'))   return 'vendor-hls';
          if (id.includes('node_modules/pixi.js'))  return 'vendor-pixi';
        },
      },
    },
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 2000,
  },
})
