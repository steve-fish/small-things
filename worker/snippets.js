/* ============================= */
/* ===== 🔐 硬编码配置 ========= */
/* ============================= */

const B2_APPLICATION_KEY_ID = "";
const B2_APPLICATION_KEY = "";
const B2_ENDPOINT = "s3.us-east-005.backblazeb2.com";
const BUCKET_NAME = "";
const REGION = "us-east-005";

const encoder = new TextEncoder();

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

export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);

      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      // 随机文件接口
      if (url.pathname === "/random") {
        const file = await getRandomFile();
        if (!file) return new Response("No file found", { status: 404 });
        // Cloudflare 需要绝对 URL
        const redirectUrl = new URL(`/${file}`, request.url).toString();
        return Response.redirect(redirectUrl, 302);
      }

      // 代理文件
      let path = url.pathname;
      if (path === "/") path = `/${BUCKET_NAME}/`;
      else path = `/${BUCKET_NAME}${path}`;

      const originUrl = `https://${B2_ENDPOINT}${path}`;
      const signedRequest = await client.sign(originUrl, "GET");

      return await fetch(signedRequest);

    } catch (err) {
      return new Response(
        "Worker crash:\n" + (err?.stack || err),
        { status: 500 }
      );
    }
  }
};

// =============================================
// 获取随机文件（非递归，全桶随机）
// =============================================

async function getRandomFile() {
  const listUrl = `https://${B2_ENDPOINT}/${BUCKET_NAME}?list-type=2`;

  const signed = await client.sign(listUrl, "GET");
  const response = await fetch(signed);

  if (!response.ok) {
    throw new Error("B2 list failed: " + response.status);
  }

  const xml = await response.text();

  const files = [...xml.matchAll(/<Key>(.*?)<\/Key>/g)]
    .map(m => m[1])
    .filter(k => !k.endsWith("/"));

  if (files.length === 0) return null;

  // 过滤掉任意路径段以 . 开头的隐藏文件（如 .openlist）
  const cleanFiles = files.filter(k =>
    !k.split("/").some(part => part.startsWith("."))
  );

  if (cleanFiles.length === 0) return null;

  return cleanFiles[Math.floor(Math.random() * cleanFiles.length)];
}