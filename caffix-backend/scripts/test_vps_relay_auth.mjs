import crypto from 'node:crypto';

/**
 * Standalone CAFFIX Ubuntu VPS Refund Relay Authentication Check.
 * Calls ONLY POST /v1/auth-test using the exact HMAC-SHA256 contract from
 * razorpayRefundClient.ts (`computeRefundRelayHmacSignature` / `invokeRefundRelay`).
 * Never calls /v1/refunds, /v1/refunds/reconcile, or any Razorpay endpoint.
 */

function computeRelayHmacSignature(relaySecret, timestampSeconds, rawBody) {
  const message = Buffer.concat([
    Buffer.from(timestampSeconds, 'utf8'),
    Buffer.from('.', 'utf8'),
    Buffer.from(rawBody, 'utf8')
  ]);
  return crypto.createHmac('sha256', relaySecret).update(message).digest('hex');
}

async function main() {
  const rawUrl = (process.env.REFUND_RELAY_URL || '').trim().replace(/\/+$/, '');
  const relaySecret = (process.env.REFUND_RELAY_SECRET || '').trim();

  if (!rawUrl || !relaySecret) {
    console.error(
      'ERROR: Missing required runtime environment variables (REFUND_RELAY_URL and REFUND_RELAY_SECRET must both be set).'
    );
    process.exit(1);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    console.error('ERROR: REFUND_RELAY_URL is not a valid URL.');
    process.exit(1);
  }

  if (parsedUrl.protocol !== 'https:') {
    console.error('ERROR: REFUND_RELAY_URL must use https://.');
    process.exit(1);
  }

  const targetUrl = `${parsedUrl.toString().replace(/\/+$/, '')}/v1/auth-test`;
  const payload = { ping: 'caffix-auth-test' };
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeRelayHmacSignature(relaySecret, timestamp, rawBody);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const startedAt = Date.now();

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Timestamp': timestamp,
        'X-Relay-Signature': signature
      },
      body: rawBody,
      redirect: 'error',
      signal: controller.signal
    });

    const elapsedMs = Date.now() - startedAt;
    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }

    const authenticated = response.ok === true && parsed.authenticated === true;
    const message = String(
      parsed.message || parsed.detail || parsed.status || (response.ok ? 'OK' : 'Authentication failed')
    );

    console.log(
      JSON.stringify(
        {
          http_status: response.status,
          authenticated,
          message,
          elapsed_ms: elapsedMs
        },
        null,
        2
      )
    );
    process.exit(response.ok && authenticated ? 0 : 1);
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    console.error(
      JSON.stringify(
        {
          http_status: null,
          authenticated: false,
          message: err?.name === 'AbortError' ? 'Request timed out' : String(err?.message || 'Request failed'),
          elapsed_ms: elapsedMs
        },
        null,
        2
      )
    );
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}

main();
