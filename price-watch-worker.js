// Отслеживание цен на товары + уведомления в Telegram (Cloudflare Worker).
//
// Раз в сутки (по расписанию Cron Trigger) Worker открывает каждую ссылку на
// товар из списка, находит на странице цену и, если она стала ниже прошлой,
// присылает сообщение в Telegram. Список товаров ведётся на простой странице
// самого воркера (добавить/удалить ссылку, проверить сейчас). Всё работает на
// бесплатном тарифе Cloudflare и не расходует лимит Claude.
//
// Как развернуть (без установки чего-либо на компьютер):
//
// A. Telegram-бот
//    1. В Telegram откройте @BotFather → /newbot → придумайте имя. BotFather
//       пришлёт токен вида 123456789:AA...  — сохраните его.
//    2. Откройте своего нового бота и нажмите «Start» (или напишите ему
//       любое сообщение) — иначе бот не сможет вам писать.
//
//    Уже есть бот, который занят другой задачей (например, распознаёт счета
//    в своей группе)? Можно использовать его: Worker только ОТПРАВЛЯЕТ
//    сообщения и не читает входящие, поэтому другой задаче он не мешает.
//    а) Токен возьмите у @BotFather: /mybots → ваш бот → "API Token".
//    б) Создайте отдельную группу для цен (например «Цены») и добавьте в неё
//       бота как участника (права администратора не нужны).
//    в) Узнайте номер (chat_id) этой группы, например: временно добавьте в
//       группу бота @RawDataBot — он пришлёт сообщение, где в "chat" → "id"
//       указан номер вида -1001234567890; после этого удалите @RawDataBot.
//       Этот номер нужен для секрета TELEGRAM_CHAT_ID на шаге 7.
//
// B. Хранилище (KV)
//    3. На https://dash.cloudflare.com откройте "Storage & Databases" →
//       "KV" → "Create" (Create namespace), имя любое, например price-watch.
//
// C. Worker
//    4. "Workers & Pages" → "Create" → "Create Worker", имя например
//       price-watch → "Deploy".
//    5. "Edit code", удалите пример, вставьте этот файл целиком → "Deploy".
//    6. Во вкладке воркера "Bindings" → "Add binding" → "KV namespace":
//       Variable name: PRICES, namespace — созданный на шаге 3.
//    7. "Settings" → "Variables and Secrets" → "Add", тип "Secret":
//         TELEGRAM_BOT_TOKEN — токен бота;
//         TELEGRAM_CHAT_ID   — номер группы (только если используете бота,
//                              который уже занят другой задачей; для нового
//                              бота можно не задавать — см. шаг 10);
//         ADMIN_TOKEN        — придумайте длинный пароль (он защищает
//                              страницу управления от посторонних).
//    8. "Settings" → "Trigger Events" (Triggers) → "Add" → "Cron Triggers":
//       например `0 6 * * *` — каждый день в 06:00 UTC (09:00 по Киеву летом).
//       Время указывается в UTC.
//
// D. Запуск
//    9. Откройте https://<адрес-воркера>/?token=<ваш ADMIN_TOKEN> — это
//       страница управления. Сохраните её в закладки на телефоне.
//   10. Нажмите «Подключить Telegram» — Worker найдёт ваш чат с ботом и
//       пришлёт тестовое сообщение. Если задан TELEGRAM_CHAT_ID, кнопка
//       называется «Отправить тест в Telegram» и просто шлёт тестовое
//       сообщение в эту группу (входящие сообщения бота не читаются).
//   11. Вставьте ссылку на товар и нажмите «Добавить» — Worker сразу
//       попробует прочитать цену и покажет результат (или причину ошибки).
//
// Ограничения: некоторые магазины защищаются от ботов и не отдают страницу
// серверу (ошибка HTTP 403/429) — такие ссылки проверять не получится. Если
// магазин поменяет вёрстку и цена перестанет находиться, Worker один раз
// сообщит об этом в Telegram (а не каждый день).

const MAX_ITEMS = 40; // бесплатный тариф: до 50 внешних запросов за один запуск
const MAX_HISTORY = 90;

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ru,uk;q=0.9,en;q=0.8,es;q=0.7",
};

// ---------- Разбор цены со страницы ----------

// "59,99" / "1.299,00" / "1,299.00" / "59.99" / 59.99 → число.
export function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let s = value.replace(/[^\d.,]/g, "");
  if (!/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    s = s.split(thousands).join("").replace(decimal, ".");
  } else if (lastComma !== -1) {
    const tail = s.length - lastComma - 1;
    s = tail > 0 && tail <= 2 && s.indexOf(",") === lastComma ? s.replace(",", ".") : s.split(",").join("");
  } else if (lastDot !== -1) {
    const tail = s.length - lastDot - 1;
    if (!(tail > 0 && tail <= 2 && s.indexOf(".") === lastDot)) s = s.split(".").join("");
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function metaContent(html, attr, name) {
  const re = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*>`, "i");
  const tag = html.match(re);
  if (!tag) return null;
  const content = tag[0].match(/content=["']([^"']*)["']/i);
  return content ? decodeEntities(content[1]).trim() : null;
}

function* walk(node) {
  if (Array.isArray(node)) {
    for (const x of node) yield* walk(x);
  } else if (node && typeof node === "object") {
    yield node;
    for (const v of Object.values(node)) yield* walk(v);
  }
}

function isProduct(node) {
  const t = node["@type"];
  return t === "Product" || (Array.isArray(t) && t.includes("Product"));
}

function offerPrice(offers) {
  const list = Array.isArray(offers) ? offers : [offers];
  const prices = [];
  let currency = null;
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const p = parseNumber(o.price ?? o.lowPrice ?? o.priceSpecification?.price);
    if (p != null) prices.push(p);
    currency = currency || o.priceCurrency || o.priceSpecification?.priceCurrency || null;
  }
  return prices.length ? { price: Math.min(...prices), currency } : null;
}

// Возвращает { price, currency, name, method } или { price: null, name }.
export function extractPrice(html) {
  const title = metaContent(html, "property", "og:title") || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
  const fallbackName = title ? decodeEntities(title).trim() : null;

  // 1. Структурированные данные schema.org (JSON-LD) — есть у большинства магазинов.
  const ldBlocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, raw] of ldBlocks) {
    let data;
    try {
      data = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    for (const node of walk(data)) {
      if (!isProduct(node) || !node.offers) continue;
      const found = offerPrice(node.offers);
      if (found) return { ...found, name: node.name || fallbackName, method: "JSON-LD" };
    }
  }

  // 2. Мета-теги Open Graph / Facebook.
  for (const name of ["product:sale_price:amount", "product:price:amount", "og:price:amount"]) {
    const price = parseNumber(metaContent(html, "property", name));
    if (price != null) {
      const currency =
        metaContent(html, "property", name.replace("amount", "currency")) ||
        metaContent(html, "property", "product:price:currency");
      return { price, currency, name: fallbackName, method: `meta ${name}` };
    }
  }

  // 3. Микроразметка itemprop="price".
  const itemprop = html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/content=["']([^"']+)["'][^>]*itemprop=["']price["']/i);
  if (itemprop) {
    const price = parseNumber(itemprop[1]);
    if (price != null) {
      const cur = html.match(/itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)["']/i);
      return { price, currency: cur ? cur[1] : null, name: fallbackName, method: "itemprop" };
    }
  }

  // 4. Цена во встроенных данных страницы (H&M / & Other Stories и др.):
  //    сначала цена со скидкой, потом обычная.
  for (const key of ["redPrice", "salePrice", "currentPrice", "finalPrice", "whitePrice"]) {
    const m = html.match(new RegExp(`"${key}"\\s*:\\s*(?:\\{[^}]*?"(?:price|value|amount)"\\s*:\\s*)?"?([0-9][0-9.,]*)`));
    const price = m ? parseNumber(m[1]) : null;
    if (price != null) return { price, currency: null, name: fallbackName, method: `data ${key}` };
  }

  return { price: null, currency: null, name: fallbackName, method: null };
}

async function fetchPrice(url) {
  let response;
  try {
    response = await fetch(url, { headers: FETCH_HEADERS, redirect: "follow" });
  } catch (e) {
    return { error: `не удалось открыть страницу (${e.message})` };
  }
  if (!response.ok) {
    const hint = [403, 429, 503].includes(response.status) ? " — похоже, магазин блокирует автоматические запросы" : "";
    return { error: `магазин ответил HTTP ${response.status}${hint}` };
  }
  const html = await response.text();
  const result = extractPrice(html);
  if (result.price == null) return { ...result, error: "страница открылась, но цену на ней найти не удалось" };
  return result;
}

// ---------- Хранилище ----------

async function loadItems(env) {
  return (await env.PRICES.get("items", "json")) || [];
}

async function saveItems(env, items) {
  await env.PRICES.put("items", JSON.stringify(items));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function formatPrice(price, currency) {
  if (price == null) return "—";
  const s = price.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${s} ${currency}` : s;
}

// ---------- Telegram ----------

async function telegram(env, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return response.json();
}

async function notify(env, text) {
  const chatId = env.TELEGRAM_CHAT_ID || (await env.PRICES.get("tg_chat"));
  if (!chatId || !env.TELEGRAM_BOT_TOKEN) return false;
  const result = await telegram(env, "sendMessage", { chat_id: chatId, text });
  return Boolean(result.ok);
}

// ---------- Проверка ----------

// Проверяет один товар, обновляет его запись и возвращает текст уведомления
// (или null, если сообщать не о чем).
async function checkItem(item) {
  const result = await fetchPrice(item.url);
  item.lastChecked = new Date().toISOString();
  if (!item.name && result.name) item.name = result.name;
  if (result.currency) item.currency = result.currency;
  const label = item.name || item.url;

  if (result.error) {
    const wasFailing = Boolean(item.lastError);
    item.lastError = result.error;
    return wasFailing ? null : `⚠️ Не удалось проверить цену: ${label}\n${result.error}\n${item.url}`;
  }

  const previous = item.lastPrice;
  item.lastError = null;
  item.method = result.method;
  item.lastPrice = result.price;
  item.lowestPrice = item.lowestPrice == null ? result.price : Math.min(item.lowestPrice, result.price);
  const history = item.history || (item.history = []);
  if (history.length && history[history.length - 1].d === today()) history.pop();
  history.push({ d: today(), p: result.price });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  if (previous != null && result.price < previous) {
    const diff = Math.round((1 - result.price / previous) * 100);
    return (
      `📉 Цена снизилась: ${label}\n` +
      `${formatPrice(previous, item.currency)} → ${formatPrice(result.price, item.currency)} (−${diff}%)\n` +
      item.url
    );
  }
  return null;
}

async function checkAll(env) {
  const items = await loadItems(env);
  const messages = [];
  for (const item of items) {
    const message = await checkItem(item);
    if (message) messages.push(message);
  }
  await saveItems(env, items);
  for (const message of messages) await notify(env, message);
  return messages;
}

// ---------- Страница управления ----------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderPage(items, { token, message, telegramLinked, fixedChat }) {
  const t = escapeHtml(token);
  const rows = items
    .map((item) => {
      const status = item.lastError
        ? `<span class="err">⚠️ ${escapeHtml(item.lastError)}</span>`
        : item.lastChecked
          ? `проверено ${escapeHtml(item.lastChecked.slice(0, 16).replace("T", " "))} UTC`
          : "ещё не проверялось";
      return `<li>
        <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.name || item.url)}</a>
        <div class="price">${escapeHtml(formatPrice(item.lastPrice, item.currency))}
          <small>минимум: ${escapeHtml(formatPrice(item.lowestPrice, item.currency))}</small></div>
        <div class="meta">${status}</div>
        <form method="post" action="/delete?token=${t}"><input type="hidden" name="id" value="${escapeHtml(item.id)}">
          <button class="link" onclick="return confirm('Удалить из списка?')">Удалить</button></form>
      </li>`;
    })
    .join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Отслеживание цен</title>
<style>
  :root { --bg:#f6f6f4; --card:#fff; --fg:#1d1d1b; --muted:#6b6b66; --accent:#2f6fed; --err:#c0392b; --line:#e3e3de; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#222220; --fg:#ececea; --muted:#9a9a94; --accent:#7aa2ff; --err:#ff7b6b; --line:#34342f; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.45 system-ui, sans-serif; }
  main { max-width:640px; margin:0 auto; padding:16px; }
  h1 { font-size:1.4rem; margin:.2rem 0 1rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; margin-bottom:14px; }
  ul { list-style:none; padding:0; margin:0; }
  li { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin-bottom:10px; }
  li a { color:var(--fg); font-weight:600; word-break:break-word; }
  .price { font-size:1.25rem; margin-top:4px; } .price small { font-size:.85rem; color:var(--muted); margin-left:8px; }
  .meta { color:var(--muted); font-size:.85rem; } .err { color:var(--err); }
  input[type=url] { width:100%; box-sizing:border-box; padding:10px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg); font:inherit; }
  button { font:inherit; padding:9px 14px; border-radius:8px; border:0; background:var(--accent); color:#fff; cursor:pointer; margin-top:8px; }
  button.secondary { background:transparent; color:var(--accent); border:1px solid var(--accent); }
  button.link { background:none; color:var(--muted); padding:0; font-size:.85rem; }
  .row { display:flex; gap:8px; flex-wrap:wrap; } .msg { white-space:pre-wrap; }
</style></head><body><main>
<h1>Отслеживание цен</h1>
${message ? `<div class="card msg">${escapeHtml(message)}</div>` : ""}
<div class="card">
  <form method="post" action="/add?token=${t}">
    <input type="url" name="url" placeholder="Ссылка на товар" required>
    <button>Добавить</button>
  </form>
</div>
<ul>${rows || '<li class="meta">Список пуст — добавьте первую ссылку.</li>'}</ul>
<div class="row">
  <form method="post" action="/check?token=${t}"><button class="secondary">Проверить все сейчас</button></form>
  <form method="post" action="/telegram?token=${t}"><button class="secondary">${fixedChat ? "Отправить тест в Telegram" : telegramLinked ? "Переподключить Telegram" : "Подключить Telegram"}</button></form>
</div>
</main></body></html>`;
}

function redirect(token, message) {
  const params = new URLSearchParams({ token });
  if (message) params.set("msg", message);
  return new Response(null, { status: 303, headers: { Location: `/?${params}` } });
}

async function handleRequest(request, env) {
  if (!env.PRICES || !env.ADMIN_TOKEN) {
    return new Response("Воркер не настроен: добавьте KV-привязку PRICES и секрет ADMIN_TOKEN (см. комментарий в начале кода).", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  if (token !== env.ADMIN_TOKEN) return new Response("Forbidden", { status: 403 });

  if (request.method === "GET" && url.pathname === "/") {
    const items = await loadItems(env);
    const telegramLinked = Boolean(await env.PRICES.get("tg_chat"));
    const fixedChat = Boolean(env.TELEGRAM_CHAT_ID);
    const html = renderPage(items, { token, message: url.searchParams.get("msg"), telegramLinked, fixedChat });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const form = await request.formData();

  if (url.pathname === "/add") {
    let link;
    try {
      link = new URL(String(form.get("url") || "").trim());
      if (!/^https?:$/.test(link.protocol)) throw new Error();
    } catch {
      return redirect(token, "Это не похоже на ссылку.");
    }
    const items = await loadItems(env);
    if (items.some((i) => i.url === link.href)) return redirect(token, "Этот товар уже в списке.");
    if (items.length >= MAX_ITEMS) return redirect(token, `В списке уже ${MAX_ITEMS} товаров — это максимум для бесплатного тарифа.`);
    const item = { id: crypto.randomUUID(), url: link.href, name: null, currency: null, lastPrice: null, lowestPrice: null, history: [] };
    await checkItem(item);
    items.push(item);
    await saveItems(env, items);
    const message = item.lastError
      ? `Добавлено, но цену прочитать не удалось: ${item.lastError}`
      : `Добавлено: ${item.name || item.url}\nТекущая цена: ${formatPrice(item.lastPrice, item.currency)} (найдена через ${item.method})`;
    return redirect(token, message);
  }

  if (url.pathname === "/delete") {
    const id = String(form.get("id") || "");
    const items = await loadItems(env);
    await saveItems(env, items.filter((i) => i.id !== id));
    return redirect(token, "Удалено.");
  }

  if (url.pathname === "/check") {
    const messages = await checkAll(env);
    return redirect(token, messages.length ? messages.join("\n\n") : "Проверено. Цены не снизились.");
  }

  if (url.pathname === "/telegram") {
    if (!env.TELEGRAM_BOT_TOKEN) return redirect(token, "Не задан секрет TELEGRAM_BOT_TOKEN.");
    // Группа задана вручную — входящие сообщения бота не трогаем (getUpdates
    // помешал бы другой программе, которая обслуживает этого же бота).
    if (env.TELEGRAM_CHAT_ID) {
      const sent = await notify(env, "✅ Уведомления о снижении цен будут приходить в эту группу.");
      return redirect(token, sent ? "Тестовое сообщение отправлено — проверьте группу." : "Не удалось отправить сообщение. Проверьте TELEGRAM_CHAT_ID и что бот состоит в группе.");
    }
    const updates = await telegram(env, "getUpdates", {});
    if (!updates.ok) return redirect(token, `Telegram ответил ошибкой: ${updates.description || "неизвестно"}. Проверьте токен бота.`);
    const chats = (updates.result || []).map((u) => (u.message || u.my_chat_member || {}).chat).filter(Boolean);
    const chat = chats[chats.length - 1];
    if (!chat) return redirect(token, "Бот пока не видит ваших сообщений. Откройте бота в Telegram, нажмите «Start» или напишите ему что-нибудь, затем нажмите кнопку ещё раз.");
    await env.PRICES.put("tg_chat", String(chat.id));
    const sent = await notify(env, "✅ Бот подключён. Сюда будут приходить уведомления о снижении цен.");
    return redirect(token, sent ? "Telegram подключён — проверьте тестовое сообщение." : "Чат найден, но отправить сообщение не удалось.");
  }

  return new Response("Not found", { status: 404 });
}

export default {
  fetch: handleRequest,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAll(env));
  },
};
