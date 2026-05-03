export type NextRequest = Request & {
  nextUrl: URL;
};

type RedirectInit = ResponseInit | number;

const jsonHeaders = (headers?: HeadersInit): Headers => {
  const result = new Headers(headers);
  if (!result.has('content-type')) {
    result.set('content-type', 'application/json; charset=utf-8');
  }
  return result;
};

export class NextResponse extends Response {
  static json(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
      ...init,
      headers: jsonHeaders(init.headers)
    });
  }

  static redirect(url: string | URL, init: RedirectInit = 307): Response {
    const status = typeof init === 'number' ? init : init.status ?? 307;
    const headers = new Headers(typeof init === 'number' ? undefined : init.headers);
    headers.set('location', url.toString());
    return new Response(null, { status, headers });
  }
}
