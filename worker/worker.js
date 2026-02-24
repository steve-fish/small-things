/* ============================= */
/* ===== 🔐 硬编码配置 ========= */
/* ============================= */

const B2_APPLICATION_KEY_ID = "";
const B2_APPLICATION_KEY = "";
const B2_ENDPOINT = "s3.us-east-005.backblazeb2.com";
const BUCKET_NAME = "";
const REGION = "us-east-005";

const encoder = new TextEncoder();

/* ============================= */
/* ===== 缓存与防刷配置 ========= */
/* ============================= */

// 回源文件缓存（Cloudflare Edge）
const EDGE_CACHE_TTL_SECONDS = 300;
// 浏览器侧缓存
const BROWSER_CACHE_TTL_SECONDS = 60;
// 文件列表缓存 TTL（Edge Cache）
const FILE_LIST_CACHE_TTL_SECONDS = 30;

// 基础防刷（按 IP 窗口计数）
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_PER_WINDOW = 120;
const RATE_LIMIT_RANDOM_MAX_PER_WINDOW = 20;
const RATE_LIMIT_MAX_TRACKED_IPS = 5000;

// 查询参数透传控制
const STRIP_QUERY_PARAMS_ON_PROXY = false;
const REMOVE_QUERY_PARAMS_ON_RANDOM_REDIRECT = true;

// Worker 专用：KV 文件列表缓存开关（需要绑定 env.FILE_LIST_KV）
const USE_KV_FILE_LIST_CACHE = false;
const KV_FILE_LIST_KEY_PREFIX = "b2:list:";
const KV_FILE_LIST_STORAGE_TTL_SECONDS = 86400;

const INTERNAL_CACHE_ORIGIN = "https://worker-cache.internal";
const NO_STORE_CACHE_CONTROL = "no-store, max-age=0";
const MAX_B2_LIST_PAGES = 1000;

// =============================================
// AWS V4 Client
// =============================================

class AwsClient {
  constructor({ accessKeyId, secretAccessKey, service, region }) {
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.service = service;
    this.region = region;
  }

  async sign(url, method = "GET") {
    const signer = new AwsV4Signer({
      url,
      method,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      service: this.service,
      region: this.region
    });

    return await signer.sign();
  }
}

class AwsV4Signer {
  constructor({ url, method, accessKeyId, secretAccessKey, service, region }) {
    this.url = new URL(url);
    this.method = method;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.service = service;
    this.region = region;

    this.datetime = new Date()
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, "");
    this.date = this.datetime.slice(0, 8);

    this.headers = new Headers();
    this.headers.set("host", this.url.host);
    this.headers.set("x-amz-date", this.datetime);
    this.headers.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
  }

  async sign() {
    const canonicalRequest = await this.createCanonicalRequest();
    const stringToSign = await this.createStringToSign(canonicalRequest);
    const signingKey = await this.getSigningKey();
    const signature = await this.hmacHex(signingKey, stringToSign);

    const credentialScope = `${this.date}/${this.region}/${this.service}/aws4_request`;

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=host;x-amz-content-sha256;x-amz-date, ` +
      `Signature=${signature}`;

    this.headers.set("Authorization", authorization);

    return new Request(this.url.toString(), {
      method: this.method,
      headers: this.headers
    });
  }

  async createCanonicalRequest() {
    const pathname = this.url.pathname || "/";

    // 必须排序 query 参数（S3 要求）
    const sortedParams = [...this.url.searchParams.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const canonicalHeaders =
      `host:${this.url.host}\n` +
      `x-amz-content-sha256:UNSIGNED-PAYLOAD\n` +
      `x-amz-date:${this.datetime}\n`;

    return [
      this.method,
      pathname,
      sortedParams,
      canonicalHeaders,
      "host;x-amz-content-sha256;x-amz-date",
      "UNSIGNED-PAYLOAD"
    ].join("\n");
  }

  async createStringToSign(canonicalRequest) {
    const credentialScope = `${this.date}/${this.region}/${this.service}/aws4_request`;

    return [
      "AWS4-HMAC-SHA256",
      this.datetime,
      credentialScope,
      await this.sha256Hex(canonicalRequest)
    ].join("\n");
  }

  async getSigningKey() {
    const kDate = await this.hmac(
      encoder.encode("AWS4" + this.secretAccessKey),
      this.date
    );
    const kRegion = await this.hmac(kDate, this.region);
    const kService = await this.hmac(kRegion, this.service);
    return await this.hmac(kService, "aws4_request");
  }

  async sha256Hex(message) {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(message)
    );
    return [...new Uint8Array(hash)]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async hmac(key, message) {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    return await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      typeof message === "string" ? encoder.encode(message) : message
    );
  }

  async hmacHex(key, message) {
    const sig = await this.hmac(key, message);
    return [...new Uint8Array(sig)]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }
}

// =============================================
// Worker
// =============================================

const client = new AwsClient({
  accessKeyId: B2_APPLICATION_KEY_ID,
  secretAccessKey: B2_APPLICATION_KEY,
  service: "s3",
  region: REGION
});

const rateLimitBuckets = new Map();

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: {
            "Allow": "GET",
            "Cache-Control": NO_STORE_CACHE_CONTROL
          }
        });
      }

      const limited = applyRateLimit(request, url.pathname === "/random");
      if (limited) return limited;

      // 随机文件接口
      if (url.pathname === "/random") {
        const preferredPrefix = getPreferredPrefix(url);
        const file = await getRandomFile(env, ctx, preferredPrefix);
        if (!file) {
          return new Response("No file found", {
            status: 404,
            headers: { "Cache-Control": NO_STORE_CACHE_CONTROL }
          });
        }

        // Cloudflare 需要绝对 URL
        const redirectUrl = buildRandomRedirectUrl(request.url, file);
        return new Response(null, {
          status: 302,
          headers: {
            "Location": redirectUrl,
            "Cache-Control": NO_STORE_CACHE_CONTROL
          }
        });
      }

      // 代理文件
      let path = url.pathname;
      if (path === "/") path = `/${BUCKET_NAME}/`;
      else path = `/${BUCKET_NAME}${path}`;

      const queryString = STRIP_QUERY_PARAMS_ON_PROXY ? "" : url.search;
      const originUrl = `https://${B2_ENDPOINT}${path}${queryString}`;

      const signedRequest = await client.sign(originUrl, "GET");
      const originResponse = await fetch(signedRequest, {
        cf: {
          cacheEverything: true,
          cacheTtlByStatus: {
            "200-299": EDGE_CACHE_TTL_SECONDS,
            "404": Math.min(EDGE_CACHE_TTL_SECONDS, 60),
            "500-599": 0
          }
        }
      });

      return withProxyCacheHeaders(originResponse);

    } catch (err) {
      return new Response(
        "Worker crash:\n" + (err?.stack || err),
        {
          status: 500,
          headers: { "Cache-Control": NO_STORE_CACHE_CONTROL }
        }
      );
    }
  }
};

function applyRateLimit(request, isRandomPath) {
  const now = Date.now();
  cleanupRateLimitBuckets(now);

  const ip = getClientIp(request);
  const windowId = Math.floor(now / (RATE_LIMIT_WINDOW_SECONDS * 1000));

  let bucket = rateLimitBuckets.get(ip);
  if (!bucket || bucket.windowId !== windowId) {
    bucket = {
      windowId,
      total: 0,
      random: 0,
      touchedAt: now
    };
  }

  bucket.total += 1;
  if (isRandomPath) bucket.random += 1;
  bucket.touchedAt = now;

  // 刷新 Map 迭代顺序，便于后续淘汰最旧键
  if (rateLimitBuckets.has(ip)) rateLimitBuckets.delete(ip);
  rateLimitBuckets.set(ip, bucket);

  if (
    bucket.total > RATE_LIMIT_MAX_PER_WINDOW ||
    bucket.random > RATE_LIMIT_RANDOM_MAX_PER_WINDOW
  ) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: {
        "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS),
        "Cache-Control": NO_STORE_CACHE_CONTROL
      }
    });
  }

  return null;
}

function cleanupRateLimitBuckets(now) {
  const staleBefore = now - RATE_LIMIT_WINDOW_SECONDS * 1000 * 2;

  for (const [ip, bucket] of rateLimitBuckets) {
    if (bucket.touchedAt < staleBefore) {
      rateLimitBuckets.delete(ip);
    }
  }

  while (rateLimitBuckets.size > RATE_LIMIT_MAX_TRACKED_IPS) {
    const oldest = rateLimitBuckets.keys().next().value;
    if (!oldest) break;
    rateLimitBuckets.delete(oldest);
  }
}

function getClientIp(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;

  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();

  return "unknown";
}

function withProxyCacheHeaders(response) {
  const headers = new Headers(response.headers);

  if (response.status >= 200 && response.status < 300) {
    headers.set(
      "Cache-Control",
      `public, max-age=${BROWSER_CACHE_TTL_SECONDS}, stale-while-revalidate=30`
    );
    headers.set(
      "CDN-Cache-Control",
      `public, s-maxage=${EDGE_CACHE_TTL_SECONDS}, stale-while-revalidate=30`
    );
  } else {
    headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function getPreferredPrefix(url) {
  const raw = (url.searchParams.get("prefix") || "").trim();
  if (!raw) return "";

  // 统一为相对 key 前缀，不允许以 / 开头
  return raw.replace(/^\/+/, "");
}

function buildRandomRedirectUrl(requestUrl, file) {
  const redirectUrl = new URL(`/${file}`, requestUrl);

  if (REMOVE_QUERY_PARAMS_ON_RANDOM_REDIRECT) {
    redirectUrl.search = "";
  }

  return redirectUrl.toString();
}

// =============================================
// 获取随机文件（Worker 版）
// =============================================

async function getRandomFile(env, ctx, preferredPrefix = "") {
  const files = await getCachedFileList(env, ctx);
  if (files.length === 0) return null;

  const filtered = preferredPrefix
    ? files.filter(k => k.startsWith(preferredPrefix))
    : files;

  if (filtered.length === 0) return null;

  return filtered[Math.floor(Math.random() * filtered.length)];
}

async function getCachedFileList(env, ctx) {
  if (USE_KV_FILE_LIST_CACHE && env && env.FILE_LIST_KV) {
    return getCachedFileListFromKv(env.FILE_LIST_KV);
  }

  return getCachedFileListFromEdgeCache(ctx);
}

async function getCachedFileListFromEdgeCache(ctx) {
  const cache = caches.default;
  const cacheKey = new Request(
    `${INTERNAL_CACHE_ORIGIN}/b2-list/${encodeURIComponent(BUCKET_NAME)}`,
    { method: "GET" }
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    try {
      const files = await cached.json();
      if (Array.isArray(files)) return files;
    } catch {
      // 缓存损坏时回源
    }
  }

  const files = await fetchFileListFromB2();
  const cacheResponse = new Response(JSON.stringify(files), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${FILE_LIST_CACHE_TTL_SECONDS}, s-maxage=${FILE_LIST_CACHE_TTL_SECONDS}`
    }
  });

  const putPromise = cache.put(cacheKey, cacheResponse.clone());
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(putPromise);
  } else {
    await putPromise;
  }

  return files;
}

async function getCachedFileListFromKv(kvNamespace) {
  const kvKey = `${KV_FILE_LIST_KEY_PREFIX}${BUCKET_NAME}`;

  const cached = await kvNamespace.get(kvKey, { type: "json" });
  if (Array.isArray(cached)) {
    return cached;
  }

  const files = await fetchFileListFromB2();
  await kvNamespace.put(kvKey, JSON.stringify(files), {
    expirationTtl: KV_FILE_LIST_STORAGE_TTL_SECONDS
  });

  return files;
}

async function fetchFileListFromB2() {
  const allFiles = [];
  let continuationToken = "";
  let page = 0;

  while (true) {
    page += 1;
    if (page > MAX_B2_LIST_PAGES) {
      throw new Error("B2 list exceeded MAX_B2_LIST_PAGES");
    }

    const listUrl = new URL(`https://${B2_ENDPOINT}/${BUCKET_NAME}`);
    listUrl.searchParams.set("list-type", "2");
    if (continuationToken) {
      listUrl.searchParams.set("continuation-token", continuationToken);
    }

    const signed = await client.sign(listUrl.toString(), "GET");
    const response = await fetch(signed);

    if (!response.ok) {
      throw new Error("B2 list failed: " + response.status);
    }

    const xml = await response.text();

    const files = [...xml.matchAll(/<Key>(.*?)<\/Key>/g)]
      .map(m => m[1])
      .filter(k => !k.endsWith("/"));
    allFiles.push(...files);

    const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    if (!isTruncated) break;

    const tokenMatch = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/);
    if (!tokenMatch || !tokenMatch[1]) {
      throw new Error("B2 list truncated but no continuation token");
    }

    continuationToken = tokenMatch[1];
  }

  if (allFiles.length === 0) return [];

  // 过滤掉任意路径段以 . 开头的隐藏文件（如 .openlist）
  const cleanFiles = allFiles.filter(k =>
    !k.split("/").some(part => part.startsWith("."))
  );

  return cleanFiles;
}
