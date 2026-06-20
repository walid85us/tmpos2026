import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5000,
      allowedHosts: true,
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: {
        ignored: ['**/.local/**', '**/.git/**', '**/.cache/**', '**/.agents/**', '**/node_modules/**'],
      },
      proxy: {
        '/api/shipping': {
          target: 'http://localhost:5001',
          changeOrigin: true,
        },
        // Phase 1.5 M4 — dev-only same-origin proxy to the isolated identity API
        // (started via `npm run identity:api` on :5002). Lets the Supabase pilot
        // call the UNCHANGED M3 whoami diagnostic without any backend CORS change.
        // The `/__identity` prefix is stripped before forwarding.
        '/__identity': {
          target: 'http://localhost:5002',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/__identity/, ''),
          // Phase 1.6 M16.2 — SAFE, NON-SECRET proxy-boundary breadcrumbs for the
          // isolated identity API. These print on the Vite dev-server console (:5000)
          // and make a future 500 attributable to the proxy/transport boundary vs the
          // identity API handler. They log ONLY a stable marker, the route FAMILY
          // (never the raw URL / query), the upstream label, the method, an upstream
          // status code, and a transport error code (ECONNREFUSED / ECONNRESET /
          // ETIMEDOUT / …). They NEVER log headers, the Authorization header, cookies,
          // the request or response body, a token, query values, or identity fields.
          configure: (proxy) => {
            const MARK = '[vite-proxy:identity-api]';
            const ROUTE_FAMILY = '/__identity/*';
            proxy.on('error', (err, req) => {
              const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
              console.error(
                `${MARK} upstream_error route=${ROUTE_FAMILY} target=identity-api method=${req?.method ?? '?'} code=${code}`,
              );
            });
            proxy.on('proxyRes', (proxyRes, req) => {
              console.log(
                `${MARK} upstream_response route=${ROUTE_FAMILY} target=identity-api method=${req?.method ?? '?'} status=${proxyRes.statusCode ?? '?'}`,
              );
            });
          },
        },
      },
    },
  };
});
