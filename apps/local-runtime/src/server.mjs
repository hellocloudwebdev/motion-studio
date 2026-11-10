import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { validateProject, routeScenes, runProjectQA } from '../../../packages/core/src/index.mjs';
const host = '127.0.0.1';
const port = Number(process.env.MOTION_STUDIO_PORT || 47831);
const token = process.env.MOTION_STUDIO_TOKEN;
const maxBody = 2 * 1024 * 1024;

if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('MOTION_STUDIO_PORT must be an integer between 1024 and 65535.');
if (typeof token !== 'string' || Buffer.byteLength(token) < 32) throw new Error('MOTION_STUDIO_TOKEN must be set to a random secret of at least 32 bytes.');

function authorized(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const received = Buffer.from(header.slice(7), 'utf8'), expected = Buffer.from(token, 'utf8');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBody) throw new Error('Request body exceeds 2 MB limit.');
  }
  return JSON.parse(body || '{}');
}
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'motion-studio-local-runtime' });
  if (!authorized(req.headers.authorization)) return send(res, 401, { error: 'Unauthorized' });
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  try {
    const body = await readJson(req);
    if (req.url === '/api/validate') return send(res, 200, validateProject(body.project));
    if (req.url === '/api/route') {
      const validation = validateProject(body.project);
      if (!validation.valid) return send(res, 422, { validation });
      return send(res, 200, routeScenes(body.project, { availableEngines: body.availableEngines }));
    }
    if (req.url === '/api/qa') {
      const validation = validateProject(body.project);
      const routing = routeScenes(body.project, { availableEngines: body.availableEngines });
      return send(res, 200, { validation, routing, qa: runProjectQA(body.project, routing) });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (error) { return send(res, 400, { error: error.message }); }
});
server.listen(port, host, () => console.log('Motion Studio local runtime listening on http://' + host + ':' + port));
