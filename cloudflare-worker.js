// CORS-relay прокси для Anthropic API.
//
// Браузер не может обращаться к api.anthropic.com напрямую (Anthropic не
// присылает заголовок Access-Control-Allow-Origin, поэтому такие запросы со
// статического сайта блокирует сам браузер). Этот Worker просто пересылает
// запрос от браузера в api.anthropic.com и добавляет к ответу CORS-заголовки.
// Он НИКАК не хранит и не читает ваш API-ключ — ключ, который браузер кладёт
// в заголовок x-api-key, проходит через Worker транзитом к Anthropic и обратно.
//
// Как развернуть (без установки чего-либо на компьютер):
// 1. Зарегистрируйтесь на https://dash.cloudflare.com (бесплатно).
// 2. В меню слева откройте "Workers & Pages" → "Create" → "Create Worker".
// 3. Дайте воркеру любое имя и нажмите "Deploy".
// 4. Откройте "Edit code", удалите весь пример и вставьте содержимое этого
//    файла целиком, затем нажмите "Deploy" ещё раз.
// 5. Скопируйте адрес воркера (вида https://имя.ваш-логин.workers.dev) и
//    вставьте его в приложении в Настройки (значок ⚙) → «Адрес сервера-
//    посредника (прокси)».

const ALLOWED_HEADERS = ["content-type", "x-api-key", "anthropic-version", "anthropic-beta"];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", "),
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1/")) {
      return new Response("Not found", { status: 404, headers: corsHeaders() });
    }

    const forwardHeaders = new Headers();
    for (const name of ALLOWED_HEADERS) {
      const value = request.headers.get(name);
      if (value) forwardHeaders.set(name, value);
    }

    const upstream = await fetch(`https://api.anthropic.com${url.pathname}${url.search}`, {
      method: request.method,
      headers: forwardHeaders,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    });

    const responseHeaders = new Headers(upstream.headers);
    Object.entries(corsHeaders()).forEach(([key, value]) => responseHeaders.set(key, value));

    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  },
};
