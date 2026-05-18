import { defineConfig, type Plugin } from 'vite'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const configPath = process.env.CLAWATAR_CONFIG || 'clawatar.config.json'

// Read config for port/bind host
let vitePort = 3000
let viteHost = process.env.CLAWATAR_VITE_HOST || '127.0.0.1'
try {
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  vitePort = config.server?.vitePort || 3000
  viteHost = process.env.CLAWATAR_VITE_HOST || config.server?.viteHost || '127.0.0.1'
} catch {}

// Serve clawatar.config.json from project root
function serveConfig(): Plugin {
  return {
    name: 'serve-config',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/clawatar.config.json') {
          const p = resolve(configPath)
          if (existsSync(p)) {
            res.setHeader('Content-Type', 'application/json')
            res.end(readFileSync(p, 'utf-8'))
            return
          }
        }
        next()
      })
    }
  }
}

export default defineConfig({
  server: {
    host: viteHost,
    port: vitePort,
  },
  preview: {
    host: viteHost,
    port: vitePort,
  },
  base: './',
  build: {
    target: 'ES2020',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        embed: resolve(__dirname, 'embed.html'),
        preview: resolve(__dirname, 'preview.html'),
        bgonly: resolve(__dirname, 'bgonly.html'),
      },
    },
  },
  plugins: [serveConfig()],
})
