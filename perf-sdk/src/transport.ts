import type { PerfPayload } from "./types";

// Browsers cap the total in-flight sendBeacon body at 64 KB per document.
// A batch over this falls back to fetch, which has no such cap.
const BEACON_LIMIT_BYTES = 60_000;

export interface Transport {
  send(endpoint: string, payload: PerfPayload): boolean;
}

// sendBeacon is the only transport that survives page unload: the browser
// hands the request to the network stack and lets the document die. fetch
// with keepalive is the fallback for oversized batches and for the rare
// browser without sendBeacon.
export const browserTransport: Transport = {
  send(endpoint, payload) {
    const body = JSON.stringify(payload);

    if (typeof navigator.sendBeacon === "function" && body.length < BEACON_LIMIT_BYTES) {
      // text/plain avoids a CORS preflight; the ingest Lambda parses the
      // body itself rather than trusting the content type.
      const blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
      if (navigator.sendBeacon(endpoint, blob)) return true;
      // A false return means the beacon queue is full; fall through to fetch.
    }

    if (typeof fetch !== "function") return false;

    void fetch(endpoint, {
      method: "POST",
      body,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      keepalive: true,
      // Telemetry must never block or fail the page it measures.
      mode: "cors",
      credentials: "omit",
    }).catch(() => undefined);

    return true;
  },
};
