// reverse_proxy.ts
import { serve } from "https://deno.land/std@0.194.0/http/server.ts";

const targetUrl = "http://armbian.local:8088"; // Target server address
const port = parseInt("8080");                 // Proxy server port

async function handleHttpRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  url.host = new URL(targetUrl).host;
  url.protocol = new URL(targetUrl).protocol;
  url.pathname = new URL(req.url).pathname; // This line and the next could likely be simplified
  url.search = new URL(req.url).search;      // with:  url = new URL(req.url, targetUrl);

  // WebSocket upgrade handling
  if (req.headers.get("upgrade") === "websocket") {
    return handleWsUpgrade(req, url);
  }

  // Regular HTTP request forwarding
  const targetReq = new Request(url.toString(), {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: "manual", // Prevent automatic redirection
  });

  try {
    const targetRes = await fetch(targetReq);
    return new Response(targetRes.body, {
      status: targetRes.status,
      statusText: targetRes.statusText,
      headers: targetRes.headers,
    });
  } catch (error) {
    console.error("Error fetching from target:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

async function handleWsUpgrade(req: Request, targetUrl: URL): Promise<Response> {
  const { socket: clientWs, response } = Deno.upgradeWebSocket(req);

  let targetWs: WebSocket; // Declare targetWs here

  try {
    targetWs = new WebSocket(targetUrl.toString());

    targetWs.onopen = () => {
      console.log("Target WebSocket connected");
    };

    targetWs.onmessage = (event) => {
      try {
          clientWs.send(event.data);
      } catch (err) {
          console.error("Error sending to client WS:", err);
          // Consider closing both sockets here, to be safe
          closeSockets(clientWs, targetWs);
      }
    };

    targetWs.onclose = (event) => {
      console.log("Target WebSocket closed:", event);
      closeSockets(clientWs, targetWs);
    };

    targetWs.onerror = (event) => {
      console.error("Target WebSocket error:", event);
      closeSockets(clientWs, targetWs); // 1011: Server error
    };

    clientWs.onmessage = (event) => {
      try {
        targetWs.send(event.data);
      } catch (err) {
        console.error("Error sending to target WS:", err);
        closeSockets(clientWs, targetWs);
      }
    };

    clientWs.onclose = (event) => {
      console.log("Client WebSocket closed:", event);
      closeSockets(clientWs, targetWs);
    };

    clientWs.onerror = (event) => {
      console.error("Client WebSocket error:", event);
      closeSockets(clientWs, targetWs);
    };

    return response;
  } catch (err) {
    console.error("Failed to connect to target WebSocket:", err);
     // Important:  If the initial connection fails, clientWs might not be
     // properly initialized. We need to handle this.  A 502 is appropriate here.
    if (clientWs && (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING)) {
          try{
              clientWs.close();
          } catch(closeErr){
              console.error("Error closing clientWs after initial target connection failure", closeErr);
          }
      }
    return new Response("Bad Gateway", { status: 502 });
  }
}

function closeSockets(clientWs: WebSocket, targetWs: WebSocket | undefined) {
  try {
    if (clientWs && (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING)) {
      clientWs.close();
    }
  } catch (err) {
    console.error("Error closing client WebSocket:", err);
  }
  try {
    if (targetWs && (targetWs.readyState === WebSocket.OPEN || targetWs.readyState === WebSocket.CONNECTING)) {
      targetWs.close();
    }
  } catch (err) {
    console.error("Error closing target WebSocket:", err);
  }
}

serve(handleHttpRequest, { port });

console.log(`Reverse proxy running on http://localhost:${port}`);
