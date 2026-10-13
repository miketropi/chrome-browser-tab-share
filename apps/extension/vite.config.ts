import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const serviceOrigin = process.env.SERVICE_ORIGIN ?? 'http://localhost:3000';
const origin = new URL(serviceOrigin);

const ICONS = { 16: 'icon-16.png', 48: 'icon-48.png', 128: 'icon-128.png' };

function manifest(): Plugin {
  return {
    name: 'manifest',
    generateBundle() {
      const local = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1';
      const connect = [serviceOrigin, serviceOrigin.replace(/^http/, 'ws')];
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(
          {
            manifest_version: 3,
            name: 'Tab Share',
            version: '1.0.0',
            minimum_chrome_version: '125',
            incognito: 'not_allowed',
            permissions: ['activeTab', 'tabCapture', 'offscreen', 'debugger', 'storage', 'notifications'],
            icons: ICONS,
            host_permissions: [`${origin.origin}/*`],
            action: { default_popup: 'popup.html', default_icon: ICONS },
            background: { service_worker: 'background.js', type: 'module' },
            content_security_policy: {
              extension_pages: `script-src 'self'; object-src 'none'; connect-src 'self' ${connect.join(' ')}`
            }
          },
          null,
          2
        )
      });
      if (local) this.warn('Building development extension with localhost service access');
    }
  };
}

export default defineConfig({
  plugins: [react(), manifest()],
  define: { __SERVICE_ORIGIN__: JSON.stringify(serviceOrigin) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'popup.html'),
        host: resolve(import.meta.dirname, 'host.html'),
        offscreen: resolve(import.meta.dirname, 'offscreen.html'),
        background: resolve(import.meta.dirname, 'src/background.ts')
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
});
