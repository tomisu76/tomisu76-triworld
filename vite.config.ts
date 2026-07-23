import { defineConfig, type Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'path';

const cesiumSource = 'node_modules/cesium/Build/Cesium';
const cesiumBaseUrl = 'cesiumStatic';

function vercelApiDevPlugin(): Plugin {
  return {
    name: 'vercel-api-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname;
        const filePath = path.resolve(`.${pathname}.js`);

        try {
          const query = Object.fromEntries(url.searchParams.entries());
          const fakeReq = {
            method: req.method,
            query,
            headers: req.headers,
            url: req.url,
          };

          const fakeRes = {
            statusCode: 200,
            headers: {} as Record<string, string>,
            status(code: number) {
              this.statusCode = code;
              return this;
            },
            setHeader(name: string, value: string) {
              this.headers[name.toLowerCase()] = value;
              res.setHeader(name, value);
              return this;
            },
            json(data: any) {
              this.setHeader('Content-Type', 'application/json');
              res.statusCode = this.statusCode;
              res.end(JSON.stringify(data));
            },
            send(data: any) {
              res.statusCode = this.statusCode;
              res.end(data);
            },
          };

          const apiModule = await server.ssrLoadModule(filePath);
          await apiModule.default(fakeReq, fakeRes);
        } catch (err) {
          console.error(`API Handler Error (${pathname}):`, err);
          res.statusCode = 502;
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    },
  };
}

export default defineConfig({
  define: {
    CESIUM_BASE_URL: JSON.stringify(cesiumBaseUrl),
  },
  plugins: [
    vercelApiDevPlugin(),
    viteStaticCopy({
      targets: [
        { src: `${cesiumSource}/ThirdParty`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Workers`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Assets`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Widgets`, dest: cesiumBaseUrl },
      ],
    }),
  ],
});

