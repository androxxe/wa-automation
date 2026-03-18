import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
const API_TARGET = process.env.VITE_API_URL ?? 'http://localhost:3001';
const proxy = {
    '/api': {
        target: API_TARGET,
        changeOrigin: true,
    },
};
// Middleware: set no-cache on HTML responses only.
// Hashed assets (/assets/*.js, /assets/*.css) keep default caching behaviour.
function noCacheHtml(req, res, next) {
    const url = req.url ?? '';
    if (url === '/' || url.split('?')[0].endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
}
export default defineConfig({
    plugins: [
        react(),
        {
            name: 'no-cache-html',
            configureServer(server) {
                server.middlewares.use(noCacheHtml);
            },
            configurePreviewServer(server) {
                server.middlewares.use(noCacheHtml);
            },
        },
    ],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        port: 5173,
        proxy,
    },
    preview: {
        port: 5173,
        proxy,
    },
});
