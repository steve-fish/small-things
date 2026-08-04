const DEFAULTS = Object.freeze({
  AUTH_TOKEN: "zakozako",
  DEFAULT_DST_URL: "https://linux.do/",
  DEBUG_MODE: false,
  MAX_REDIRECTS: 5,

  // 允许注入 Cloudflare Access Service Token 的域名。
  // 示例：app.example.com,*.internal.example.com
  CF_ACCESS_HOSTS: "",

  // 使用 Service Binding 时，对应的目标主机名。
  UPSTREAM_SERVICE_HOST: "",
});

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/*
 * 只删除 Cloudflare 自动注入的边缘网络请求头。
 *
 * 不再使用 /^cf-/ 全部删除，因为：
 *
 * CF-Access-Client-Id
 * CF-Access-Client-Secret
 * CF-Access-Token
 *
 * 都可能是正常认证信息。
 */
const CLOUDFLARE_EDGE_HEADERS = new Set([
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-ew-via",
  "cf-worker",
  "cdn-loop",
  "true-client-ip",
  "x-forwarded-for",
  "content-length",
]);

const REDIRECT_STATUSES = new Set([
  301,
  302,
  303,
  307,
  308,
]);

const NO_BODY_METHODS = new Set([
  "GET",
  "HEAD",
]);

const ALLOWED_PROTOCOLS = new Set([
  "http:",
  "https:",
  "ws:",
  "wss:",
]);

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value == null) {
    return fallback;
  }

  return String(value).toLowerCase() === "true";
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(
    String(value ?? ""),
    10,
  );

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(
    max,
    Math.max(min, parsed),
  );
}

function getConfig(env = {}) {
  return {
    AUTH_TOKEN: String(
      env.AUTH_TOKEN ||
      DEFAULTS.AUTH_TOKEN,
    ),

    DEFAULT_DST_URL: String(
      env.DEFAULT_DST_URL ||
      DEFAULTS.DEFAULT_DST_URL,
    ),

    DEBUG_MODE: parseBoolean(
      env.DEBUG_MODE,
      DEFAULTS.DEBUG_MODE,
    ),

    MAX_REDIRECTS: parseInteger(
      env.MAX_REDIRECTS,
      DEFAULTS.MAX_REDIRECTS,
      0,
      10,
    ),

    CF_ACCESS_HOSTS: String(
      env.CF_ACCESS_HOSTS ||
      DEFAULTS.CF_ACCESS_HOSTS,
    ),

    CF_ACCESS_CLIENT_ID:
      env.CF_ACCESS_CLIENT_ID
        ? String(env.CF_ACCESS_CLIENT_ID)
        : "",

    CF_ACCESS_CLIENT_SECRET:
      env.CF_ACCESS_CLIENT_SECRET
        ? String(env.CF_ACCESS_CLIENT_SECRET)
        : "",

    UPSTREAM_SERVICE_HOST: String(
      env.UPSTREAM_SERVICE_HOST ||
      DEFAULTS.UPSTREAM_SERVICE_HOST,
    ).toLowerCase(),
  };
}

function createLogger(enabled) {
  if (!enabled) {
    return () => {};
  }

  return (message, data) => {
    console.log(
      `[cf-proxy] ${message}`,
      data ?? "",
    );
  };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/*
 * 避免普通字符串比较中明显的时间差。
 * 这不是密码哈希，但比直接 === 更适合令牌比较。
 */
function constantTimeEqual(a, b) {
  const encoder = new TextEncoder();

  const left = encoder.encode(String(a));
  const right = encoder.encode(String(b));

  const length = Math.max(
    left.length,
    right.length,
  );

  let diff = left.length ^ right.length;

  for (let i = 0; i < length; i++) {
    diff |=
      (left[i] || 0) ^
      (right[i] || 0);
  }

  return diff === 0;
}

function appendIncomingQuery(
  target,
  incomingSearch,
) {
  if (
    !incomingSearch ||
    incomingSearch === "?"
  ) {
    return;
  }

  const extra = incomingSearch.slice(1);

  target.search = target.search
    ? `${target.search}&${extra}`
    : `?${extra}`;
}

/*
 * 支持：
 *
 * /token/https://example.com/path
 * /token/https%3A%2F%2Fexample.com%2Fpath
 */
function parseDestination(
  requestUrl,
  config,
) {
  const path = requestUrl.pathname;
  const separator = path.indexOf("/", 1);

  if (separator < 0) {
    return {
      authenticated: false,
      target: new URL(
        config.DEFAULT_DST_URL,
      ),
    };
  }

  const suppliedToken = safeDecode(
    path.slice(1, separator),
  );

  if (
    !constantTimeEqual(
      suppliedToken,
      config.AUTH_TOKEN,
    )
  ) {
    return {
      authenticated: false,
      target: new URL(
        config.DEFAULT_DST_URL,
      ),
    };
  }

  let rawTarget =
    path.slice(separator + 1);

  if (!rawTarget) {
    throw new TypeError(
      "Missing destination URL",
    );
  }

  if (
    !/^(?:https?|wss?):\/\//i.test(
      rawTarget,
    )
  ) {
    rawTarget = safeDecode(rawTarget);
  }

  /*
   * 兼容某些客户端将：
   *
   * https://example.com
   *
   * 错误归一化为：
   *
   * https:/example.com
   */
  rawTarget = rawTarget.replace(
    /^(https?|wss?):\/(?!\/)/i,
    "$1://",
  );

  const target = new URL(rawTarget);

  if (
    !ALLOWED_PROTOCOLS.has(
      target.protocol,
    )
  ) {
    throw new TypeError(
      `Unsupported protocol: ${target.protocol}`,
    );
  }

  appendIncomingQuery(
    target,
    requestUrl.search,
  );

  return {
    authenticated: true,
    target,
  };
}

/*
 * fetch() 发起 WebSocket 时仍然使用 HTTP/HTTPS URL，
 * 通过 Upgrade: websocket 请求头进行升级。
 */
function asFetchUrl(target) {
  const url = new URL(target);

  if (url.protocol === "ws:") {
    url.protocol = "http:";
  }

  if (url.protocol === "wss:") {
    url.protocol = "https:";
  }

  return url;
}

function getAccessHosts(config) {
  return new Set(
    config.CF_ACCESS_HOSTS
      .split(",")
      .map((host) =>
        host.trim().toLowerCase(),
      )
      .filter(Boolean),
  );
}

function hostMatches(
  hostname,
  rule,
) {
  if (hostname === rule) {
    return true;
  }

  if (
    rule.startsWith("*.") &&
    hostname.endsWith(
      rule.slice(1),
    )
  ) {
    return true;
  }

  return false;
}

/*
 * 必须明确配置 CF_ACCESS_HOSTS，
 * 防止 Access Secret 被发送给任意目标网站。
 */
function shouldInjectAccess(
  target,
  config,
) {
  if (
    !config.CF_ACCESS_CLIENT_ID ||
    !config.CF_ACCESS_CLIENT_SECRET
  ) {
    return false;
  }

  const hostname =
    target.hostname.toLowerCase();

  for (
    const rule of getAccessHosts(config)
  ) {
    if (
      hostMatches(hostname, rule)
    ) {
      return true;
    }
  }

  return false;
}

function buildHeaders(
  request,
  target,
  config,
  isWebSocket,
) {
  const headers = new Headers();

  for (
    const [name, value]
    of request.headers
  ) {
    const lower =
      name.toLowerCase();

    if (lower === "host") {
      continue;
    }

    if (
      HOP_BY_HOP_HEADERS.has(lower)
    ) {
      continue;
    }

    if (
      CLOUDFLARE_EDGE_HEADERS.has(
        lower,
      )
    ) {
      continue;
    }

    /*
     * CF-Access-* 请求头会被保留。
     */
    headers.append(name, value);
  }

  /*
   * 避免目标站点因为 Origin/Referer
   * 指向代理域名而拒绝请求。
   */
  if (headers.has("origin")) {
    headers.set(
      "origin",
      target.origin,
    );
  }

  if (headers.has("referer")) {
    headers.set(
      "referer",
      target.href,
    );
  }

  /*
   * 为自己管理的 Cloudflare Access
   * 站点注入 Service Token。
   */
  if (
    shouldInjectAccess(
      target,
      config,
    )
  ) {
    headers.set(
      "CF-Access-Client-Id",
      config.CF_ACCESS_CLIENT_ID,
    );

    headers.set(
      "CF-Access-Client-Secret",
      config.CF_ACCESS_CLIENT_SECRET,
    );
  }

  if (isWebSocket) {
    headers.set(
      "Upgrade",
      "websocket",
    );
  }

  /*
   * 防止 global_fetch_strictly_public
   * 导致 Worker 递归调用自身。
   */
  const currentHop =
    Number.parseInt(
      headers.get(
        "x-cf-proxy-hop",
      ) || "0",
      10,
    );

  if (currentHop >= 2) {
    throw new Error(
      "Proxy loop detected",
    );
  }

  headers.set(
    "x-cf-proxy-hop",
    String(currentHop + 1),
  );

  return headers;
}

function makeRequest(
  url,
  headers,
  method,
  body,
) {
  const init = {
    method,
    headers,
    redirect: "manual",
  };

  if (
    !NO_BODY_METHODS.has(method) &&
    body != null
  ) {
    init.body = body;
  }

  return new Request(
    url,
    init,
  );
}

function stripSensitiveRedirectHeaders(
  headers,
) {
  headers.delete("authorization");
  headers.delete("cookie");

  headers.delete(
    "cf-access-client-id",
  );

  headers.delete(
    "cf-access-client-secret",
  );

  headers.delete(
    "cf-access-token",
  );
}

/*
 * 若配置了 Service Binding，并且目标主机匹配，
 * 优先通过 Service Binding 调用。
 *
 * 这适合自己 Cloudflare 账号下的同 Zone Worker。
 */
async function fetchOnce(
  request,
  target,
  env,
  config,
) {
  if (
    env.UPSTREAM_SERVICE &&
    config.UPSTREAM_SERVICE_HOST &&
    target.hostname.toLowerCase() ===
      config.UPSTREAM_SERVICE_HOST
  ) {
    return env.UPSTREAM_SERVICE.fetch(
      request,
    );
  }

  return fetch(request);
}

async function fetchWithRedirects(
  sourceRequest,
  initialTarget,
  initialHeaders,
  env,
  config,
  log,
) {
  let target =
    new URL(initialTarget);

  let headers =
    new Headers(initialHeaders);

  let method =
    sourceRequest.method.toUpperCase();

  let body =
    NO_BODY_METHODS.has(method)
      ? null
      : sourceRequest.body;

  for (
    let count = 0;
    ;
    count++
  ) {
    const outbound = makeRequest(
      target,
      headers,
      method,
      body,
    );

    const response = await fetchOnce(
      outbound,
      target,
      env,
      config,
    );

    if (
      !REDIRECT_STATUSES.has(
        response.status,
      )
    ) {
      return response;
    }

    if (
      count >= config.MAX_REDIRECTS
    ) {
      return response;
    }

    /*
     * 流式请求体无法可靠地重复读取。
     *
     * 只有重定向会转换成 GET 时，
     * 才继续跟随带请求体的请求。
     */
    const convertsToGet =
      response.status === 303 ||
      (
        (
          response.status === 301 ||
          response.status === 302
        ) &&
        method === "POST"
      );

    if (
      !NO_BODY_METHODS.has(method) &&
      !convertsToGet
    ) {
      return response;
    }

    const location =
      response.headers.get(
        "location",
      );

    if (!location) {
      return response;
    }

    const nextTarget = new URL(
      location,
      target,
    );

    if (
      nextTarget.protocol !== "http:" &&
      nextTarget.protocol !== "https:"
    ) {
      return response;
    }

    const crossedOrigin =
      nextTarget.origin !==
      target.origin;

    /*
     * 跨域跳转时清除敏感认证信息，
     * 防止令牌泄漏给其他域名。
     */
    if (crossedOrigin) {
      stripSensitiveRedirectHeaders(
        headers,
      );
    }

    if (convertsToGet) {
      method = "GET";
      body = null;

      headers.delete(
        "content-length",
      );

      headers.delete(
        "content-type",
      );
    }

    /*
     * 跳转到另一个显式允许的
     * Access 域名时重新注入令牌。
     */
    if (
      shouldInjectAccess(
        nextTarget,
        config,
      )
    ) {
      headers.set(
        "CF-Access-Client-Id",
        config.CF_ACCESS_CLIENT_ID,
      );

      headers.set(
        "CF-Access-Client-Secret",
        config.CF_ACCESS_CLIENT_SECRET,
      );
    }

    if (headers.has("origin")) {
      headers.set(
        "origin",
        nextTarget.origin,
      );
    }

    if (headers.has("referer")) {
      headers.set(
        "referer",
        nextTarget.href,
      );
    }

    log(
      "Following redirect",
      {
        status: response.status,
        from: target.href,
        to: nextTarget.href,
      },
    );

    target = nextTarget;
  }
}

/*
 * Cloudflare Challenge 不能在另一个代理域名下
 * 正常完成，因此返回明确错误，而不是陷入无限验证。
 */
function challengeResponse(
  upstream,
) {
  return new Response(
    JSON.stringify(
      {
        error:
          "cloudflare_challenge",

        message:
          "The upstream returned a Cloudflare Challenge Page. " +
          "A challenge issued for another domain cannot be completed " +
          "through this proxy. For a site you control, configure a " +
          "Cloudflare Access service token or adjust its WAF policy.",

        upstreamStatus:
          upstream.status,
      },
      null,
      2,
    ),
    {
      status: 403,

      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "no-store",

        "x-proxy-error":
          "cloudflare-challenge",
      },
    },
  );
}

function errorResponse(
  error,
  debug,
) {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  const status =
    error instanceof TypeError
      ? 400
      : 502;

  return new Response(
    debug
      ? `Proxy error: ${message}`
      : "Bad gateway",
    {
      status,

      headers: {
        "content-type":
          "text/plain; charset=utf-8",

        "cache-control":
          "no-store",
      },
    },
  );
}

async function handleRequest(
  request,
  env = {},
) {
  const config =
    getConfig(env);

  const log =
    createLogger(
      config.DEBUG_MODE,
    );

  try {
    const incomingUrl =
      new URL(request.url);

    const {
      authenticated,
      target,
    } = parseDestination(
      incomingUrl,
      config,
    );

    const upgrade =
      request.headers
        .get("upgrade")
        ?.toLowerCase();

    const targetWebSocket =
      target.protocol === "ws:" ||
      target.protocol === "wss:";

    const isWebSocket =
      upgrade === "websocket" ||
      targetWebSocket;

    /*
     * 鉴权失败时不开放 WebSocket。
     */
    if (
      !authenticated &&
      upgrade === "websocket"
    ) {
      return new Response(
        "Not found",
        {
          status: 404,
        },
      );
    }

    if (
      targetWebSocket &&
      upgrade !== "websocket"
    ) {
      return new Response(
        "WebSocket Upgrade required",
        {
          status: 426,

          headers: {
            Upgrade: "websocket",
          },
        },
      );
    }

    const fetchUrl =
      asFetchUrl(target);

    /*
     * 请求重新到达当前 Worker 后阻止继续递归。
     */
    if (
      fetchUrl.origin ===
      incomingUrl.origin
    ) {
      const hop =
        Number.parseInt(
          request.headers.get(
            "x-cf-proxy-hop",
          ) || "0",
          10,
        );

      if (hop >= 1) {
        throw new Error(
          "Refusing recursive request to this Worker",
        );
      }
    }

    const headers =
      buildHeaders(
        request,
        fetchUrl,
        config,
        isWebSocket,
      );

    log(
      "Proxy request",
      {
        method: request.method,
        target: fetchUrl.href,
        websocket: isWebSocket,
      },
    );

    let response;

    if (isWebSocket) {
      const outbound =
        makeRequest(
          fetchUrl,
          headers,
          request.method.toUpperCase(),
          null,
        );

      response =
        await fetchOnce(
          outbound,
          fetchUrl,
          env,
          config,
        );
    } else {
      response =
        await fetchWithRedirects(
          request,
          fetchUrl,
          headers,
          env,
          config,
          log,
        );
    }

    /*
     * Cloudflare 官方提供的挑战响应检测方式。
     */
    if (
      response.headers.get(
        "cf-mitigated",
      ) === "challenge"
    ) {
      return challengeResponse(
        response,
      );
    }

    return response;
  } catch (error) {
    log(
      "Proxy failure",
      error,
    );

    return errorResponse(
      error,
      config.DEBUG_MODE,
    );
  }
}

export default {
  fetch: handleRequest,
};

/*
 * 同时兼容 Cloudflare Pages Functions。
 */
export const onRequest = (
  context,
) => {
  return handleRequest(
    context.request,
    context.env,
  );
};
