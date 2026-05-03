import type { Express, NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { NextRequest } from '@/lib/http/next-server';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type HttpMethod = typeof HTTP_METHODS[number];

type RouteModule = Partial<Record<HttpMethod, RouteHandler>>;
type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> }
) => Response | Promise<Response>;

type RouteEntry = {
  file: string;
  path: string;
  dynamicSegments: number;
  wildcardSegments: number;
  staticSegments: number;
  segmentCount: number;
};

export async function mountNextStyleApiRoutes(app: Express): Promise<void> {
  const apiDir = fileURLToPath(new URL('../app/api/', import.meta.url));
  const entries = await findRouteEntries(apiDir);

  for (const entry of entries) {
    const routeModule = await import(pathToFileURL(entry.file).href) as RouteModule;
    for (const method of HTTP_METHODS) {
      const handler = routeModule[method] ?? (method === 'HEAD' ? routeModule.GET : undefined);
      if (!handler) continue;

      const wrapped = wrapHandler(handler);
      app[method.toLowerCase() as Lowercase<HttpMethod>](entry.path, wrapped);

      const barePath = entry.path.replace(/^\/api(?=\/|$)/, '') || '/';
      if (barePath !== entry.path) {
        app[method.toLowerCase() as Lowercase<HttpMethod>](barePath, wrapped);
      }
    }
  }

  console.log(`[agora-backend] Mounted ${entries.length} API route files`);
}

const wrapHandler = (handler: RouteHandler) => {
  return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    try {
      const request = createWebRequest(req);
      const response = await handler(request, {
        params: Promise.resolve(req.params as Record<string, string>)
      });
      await sendWebResponse(response, req, res);
    } catch (error) {
      if (isAbortError(error) || res.headersSent) return;
      next(error);
    }
  };
};

const createWebRequest = (req: ExpressRequest): NextRequest => {
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const protocol = forwardedHeader(req, 'x-forwarded-proto') ?? req.protocol ?? 'http';
  const host = req.get('host') ?? 'localhost';
  const url = new URL(req.originalUrl || req.url, `${protocol}://${host}`);
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  }

  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers,
    signal: controller.signal
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req as unknown as BodyInit;
    init.duplex = 'half';
  }

  const request = new Request(url, init) as NextRequest;
  Object.defineProperty(request, 'nextUrl', {
    value: url,
    enumerable: false,
    configurable: false
  });
  return request;
};

const sendWebResponse = async (
  response: Response,
  req: ExpressRequest,
  res: ExpressResponse
): Promise<void> => {
  res.status(response.status);
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (req.method === 'HEAD' || !response.body) {
    res.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const nodeStream = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.on('error', reject);
    res.on('error', reject);
    res.on('finish', resolve);
    nodeStream.pipe(res);
  });
};

const findRouteEntries = async (apiDir: string): Promise<RouteEntry[]> => {
  const files = await findRouteFiles(apiDir);
  return files
    .map((file) => routeEntryForFile(apiDir, file))
    .sort((a, b) => {
      if (a.wildcardSegments !== b.wildcardSegments) return a.wildcardSegments - b.wildcardSegments;
      if (a.dynamicSegments !== b.dynamicSegments) return a.dynamicSegments - b.dynamicSegments;
      if (a.staticSegments !== b.staticSegments) return b.staticSegments - a.staticSegments;
      return b.segmentCount - a.segmentCount;
    });
};

const findRouteFiles = async (dir: string): Promise<string[]> => {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...await findRouteFiles(entryPath));
    } else if (entry.isFile() && (entry.name === 'route.js' || entry.name === 'route.ts')) {
      result.push(entryPath);
    }
  }
  return result;
};

const routeEntryForFile = (apiDir: string, file: string): RouteEntry => {
  const relativeDir = path.dirname(path.relative(apiDir, file));
  const rawSegments = relativeDir === '.' ? [] : relativeDir.split(path.sep);
  let dynamicSegments = 0;
  let wildcardSegments = 0;
  let staticSegments = 0;

  const segments = rawSegments.map((segment) => {
    const catchAll = segment.match(/^\[\.\.\.([A-Za-z0-9_ -]+)\]$/);
    if (catchAll?.[1]) {
      wildcardSegments += 1;
      return `:${sanitizeParamName(catchAll[1])}(*)`;
    }

    const dynamic = segment.match(/^\[([A-Za-z0-9_ -]+)\]$/);
    if (dynamic?.[1]) {
      dynamicSegments += 1;
      return `:${sanitizeParamName(dynamic[1])}`;
    }

    staticSegments += 1;
    return segment;
  });

  return {
    file,
    path: `/api/${segments.join('/')}`.replace(/\/$/, ''),
    dynamicSegments,
    wildcardSegments,
    staticSegments,
    segmentCount: segments.length
  };
};

const sanitizeParamName = (value: string): string => value.replace(/[^A-Za-z0-9_]/g, '_');

const forwardedHeader = (req: ExpressRequest, name: string): string | undefined => {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.split(',')[0]?.trim();
};

const isAbortError = (error: unknown): boolean => (
  error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'))
);
