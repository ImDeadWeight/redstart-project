import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
	plugins: [react()],
	base: './',
	server: {
		port: 5173,
		// Phase 6 §6.2 retired IPC — the dev server now needs to reach the real
		// admin listener over HTTP the same way a browser tab or the packaged
		// build's window does, or hot-reload dev work would be talking to
		// nothing. `changeOrigin` matters here: the admin listener answers only
		// its own Host header shape, not Vite's.
		proxy: {
			'/admin': { target: 'http://127.0.0.1:19083', changeOrigin: true },
		},
	},
	build: {
		outDir: 'dist',
		rollupOptions: {
			input: {
				main: resolve(__dirname, 'index.html'),
			},
		},
	},
})
