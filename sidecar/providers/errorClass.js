/* sidecar/providers/errorClass.js — API error classification -> failover actions (derived from the reference harness, L3.S1).

   Today the loop carries a single `err.transient` bit: a 429/5xx retries, everything else is fatal. That
   burns paid attempts on never-succeed failures (402 out-of-credits, 400 malformed) and tells the user
   nothing useful. This pure classifier maps any provider error to a reason + the action it implies.

   classifyApiError(err, { provider, model, approxTokens, contextLimit, numMessages })
     -> { reason, retryable, shouldRotateCredential, shouldFallback, shouldCompress, statusCode, message }

   Reasons: auth · billing · rate_limit · overloaded · server_error · timeout · context_overflow ·
            model_not_found · content_policy_blocked · format_error · unknown.

   Priority pipeline: content/policy -> HTTP status (code+message consulted inside the ambiguous 400 branch)
   -> structured error-code (for errors with no HTTP status) -> message patterns -> transport -> a
   context-overflow RATIO heuristic -> unknown. The ratio (approxTokens > 0.4·contextLimit) only fires when
   contextLimit > 0, so a cold /models catalog (contextLimit === 0) never mis-labels a bare 400 as overflow.

   Pure: inspects only `err` and the context bag — no clock, no rng, no IO. Wiring (producer seam in
   openrouter.js, honest `transient` in loop.js) is L3.S2/S3; this commit ships the classifier + test only. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.errorClass = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // reason -> the recovery it implies. retryable = worth another attempt on the SAME credential/model after
  // backoff; the *should* flags are advisory hints a future failover layer consumes (no consumer yet — L3.S3
  // records them inert). Default-deny posture: only genuinely transient classes are retryable.
  const REASONS = {
    auth:                   { retryable: false, shouldRotateCredential: true,  shouldFallback: false, shouldCompress: false },
    billing:                { retryable: false, shouldRotateCredential: true,  shouldFallback: false, shouldCompress: false },
    rate_limit:             { retryable: true,  shouldRotateCredential: true,  shouldFallback: false, shouldCompress: false },
    /* A SPENT ALLOWANCE, not a busy moment. A ChatGPT-subscription (Codex) weekly quota resets in DAYS, so a
       retry is doomed by construction: retryable:false stops codex.js burning RETRY_DELAYS and loop.js burning
       MAX_STREAM_RETRIES against an exhausted meter. Rotating may help (another credential has its own
       allowance) and so may falling back (a different provider entirely) — unlike `billing`, which is one
       account being out of money and which a fallback would not fix either way. */
    quota_exhausted:        { retryable: false, shouldRotateCredential: true,  shouldFallback: true,  shouldCompress: false },
    overloaded:             { retryable: true,  shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    server_error:           { retryable: true,  shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    timeout:                { retryable: true,  shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    context_overflow:       { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: true  },
    model_not_found:        { retryable: false, shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    content_policy_blocked: { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    format_error:           { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    unknown:                { retryable: true,  shouldRotateCredential: false, shouldFallback: false, shouldCompress: false }
  };

  function extractStatus(err) {
    if (!err) return null;
    const s = err.status || err.statusCode || (err.response && err.response.status);
    if (typeof s === 'number' && s >= 100) return s;
    const m = String(err.message || '').match(/\b(?:http|status)\s+(\d{3})\b/i);
    return m ? Number(m[1]) : null;
  }
  function extractBody(err) {
    if (!err) return null;
    return err.body || err.error || (err.response && (err.response.data || err.response.body)) || null;
  }
  function extractCode(body, err) {
    const e = body && (body.error || body);
    // providerCode: the upstream body's code as openai-compatible.js lifted it (flat xAI bodies carry no `body`)
    const c = (e && e.code) || (err && err.code) || (err && err.providerCode);
    // node transport codes (ECONNRESET…) are numeric-ish strings handled separately; only return API codes here
    return (typeof c === 'string' && !/^E[A-Z]/.test(c)) ? c : (typeof c === 'number' ? null : (c || null));
  }
  function extractMessage(err, body) {
    const e = body && (body.error || body);
    const parts = [];
    if (e && e.message) parts.push(String(e.message));
    if (e && e.metadata && e.metadata.raw) parts.push(String(e.metadata.raw));   // OpenRouter wraps the upstream error here
    if (!parts.length && err && err.message) parts.push(String(err.message));
    return parts.join(' — ') || (err ? String(err) : 'unknown error');
  }
  function transportCode(err) {
    return (err && (err.code || err.errno || (err.cause && err.cause.code))) || '';
  }

  /* WHY THIS EXISTS (2026-07-29). A real user's diagnostics report carried five entries reading exactly
     `fetch failed` — and nothing else. That is undici's ENTIRE message for any failed outbound fetch: the useful
     part (ENOTFOUND / ECONNREFUSED / EAI_AGAIN / UND_ERR_CONNECT_TIMEOUT, plus the hostname) lives on `err.cause`
     and was being dropped on the floor by extractMessage's `err.message` fallback. We could not tell DNS failure
     from a refused connection from a TLS/proxy interception, so we could not tell the user what to fix.

     PURE by contract: reads only the error object (no env, no clock, no I/O) so it stays safe to unit-test and
     safe to call from the loop. Returns '' when there is nothing to add, so callers can append unconditionally. */
  function transportDetail(err) {
    const code = String(transportCode(err) || '').trim();
    const cause = (err && err.cause) || null;
    // undici's DNS failures carry the hostname directly; other causes often name it only in their message.
    let host = (cause && (cause.hostname || cause.host)) || '';
    if (!host && cause && cause.message) {
      const m = String(cause.message).match(/(?:^|\s)([a-z0-9-]+(?:\.[a-z0-9-]+){1,})(?::\d+)?(?:\s|$)/i);
      if (m) host = m[1];
    }
    host = String(host || '').trim();
    if (!code && !host) return '';
    return code && host ? code + ' ' + host : (code || host);
  }
  /* Append the transport detail to a message ONLY when the message is too bare to be actionable. Deliberately
     conservative: a provider that already sent a real error sentence keeps its own words verbatim (we must never
     bury an upstream explanation under plumbing), and we never double-append a code the message already names.
     NOTE the ORDER of the caller in classifyApiError: `reason` is picked from the RAW message BEFORE this runs,
     so enriching the text can never move a verdict. Keep it that way. */
  function annotateTransport(message, err) {
    const msg = String(message == null ? '' : message);
    const detail = transportDetail(err);
    if (!detail) return msg;
    if (msg.toLowerCase().indexOf(detail.toLowerCase()) >= 0) return msg;
    // only bare transport-shaped messages get annotated — undici's "fetch failed" is the case that mattered.
    if (!/^\s*(?:typeerror:\s*)?(?:fetch failed|failed to fetch|terminated|socket hang up|other side closed|premature close|network(?:error| error)?)\s*$/i.test(msg)) return msg;
    return msg + ' (' + detail + ')';
  }

  // H6.1: surface how long the server says to wait, so a rate-limited credential cools for exactly that long
  // (instead of a blind fixed cooldown). PURE — no clock: a RELATIVE hint (Retry-After: 30, "try again in 1.5s")
  // becomes `retryAfterMs`; an ABSOLUTE hint (HTTP-date, X-RateLimit-Reset epoch, "resets at <epoch>") becomes
  // `resetAtMs` and the consumer (with its injected clock) turns it into a delay. Either/both may be null.
  function extractHeaders(err) { return (err && (err.headers || (err.response && err.response.headers))) || null; }
  function headerGet(headers, name) {
    if (!headers) return null;
    const lname = name.toLowerCase();
    if (typeof headers.get === 'function') { const v = headers.get(name); if (v != null) return v; }
    for (const k in headers) { if (String(k).toLowerCase() === lname) return headers[k]; }
    return null;
  }
  function extractRetryAfter(err, body, message) {
    let retryAfterMs = null, resetAtMs = null;
    const headers = extractHeaders(err);
    const e = body && (body.error || body);
    // 1. Retry-After: bare integer = delta-seconds; otherwise an HTTP-date (absolute).
    const ra = headerGet(headers, 'retry-after') || (e && (e.retry_after != null ? e.retry_after : (body && body.retry_after)));
    if (ra != null && String(ra).trim() !== '') {
      const s = String(ra).trim();
      if (/^\d+(\.\d+)?$/.test(s)) retryAfterMs = Math.round(parseFloat(s) * 1000);
      else { const t = Date.parse(s); if (!isNaN(t)) resetAtMs = t; }
    }
    // 2. X-RateLimit-Reset header: epoch seconds or ms (a small delta-seconds value is ambiguous -> skip).
    const xr = headerGet(headers, 'x-ratelimit-reset') || headerGet(headers, 'x-ratelimit-reset-requests') || headerGet(headers, 'x-ratelimit-reset-tokens');
    if (resetAtMs == null && xr != null && /^\d+(\.\d+)?$/.test(String(xr).trim())) {
      const n = parseFloat(xr);
      if (n > 1e12) resetAtMs = Math.round(n);            // already epoch-ms
      else if (n > 1e9) resetAtMs = Math.round(n * 1000); // epoch-seconds
    }
    // 3. message text: "(try again|retry|resets|available) in <n><unit>"
    if (retryAfterMs == null) {
      const m = String(message || '').toLowerCase().match(/(?:try again|retry|resets?|available|wait)\s+(?:in\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)\b/);
      if (m) { const v = parseFloat(m[1]); const u = m[2]; retryAfterMs = /^ms|^milli/.test(u) ? Math.round(v) : /^m/.test(u) ? Math.round(v * 60000) : Math.round(v * 1000); }
    }
    // 4. message text: "resets at <epoch>" (10–13 digit unix time)
    if (resetAtMs == null) {
      const m = String(message || '').toLowerCase().match(/resets?\s+at\s+(\d{10,13})/);
      if (m) { const n = Number(m[1]); resetAtMs = n > 1e12 ? n : n * 1000; }
    }
    return { retryAfterMs, resetAtMs };
  }

  function classify400(low, code, ctx) {
    const c = String(code || '').toLowerCase();
    if (/context_length|context_window|max.*token/.test(c)) return 'context_overflow';
    if (/content_policy|moderation/.test(c)) return 'content_policy_blocked';
    if (/context length|maximum context|context window|too many tokens|reduce the length|maximum.*tokens|payload too large/.test(low)) return 'context_overflow';
    // ratio heuristic ONLY with a known limit — a cold catalog (contextLimit 0) falls to format_error
    if (ctx.contextLimit > 0 && ctx.approxTokens > 0.4 * ctx.contextLimit) return 'context_overflow';
    return 'format_error';
  }

  /* A 429 is not always "wait a few seconds". A ChatGPT-subscription user who has burned their WEEKLY quota
     gets a 429 whose body says exactly that and whose reset is days away — so the honest class is a spent
     allowance, not a rate limit. Status-before-message precedence is deliberate (see the note in pickReason),
     so this is a distinct class WITHIN the 429 rather than a reordering: only a long or absolute reset window,
     or an explicit usage-limit type, qualifies. Gemini answers a PER-MINUTE limit with "Quota exceeded for
     quota metric", and that must stay rate_limit — hence the short-window veto.
     xAI's SuperGrok subscription says it as a 429 {code:'subscription:free-usage-exhausted', error:"You've used
     all the included free usage for model …"} — the same spent allowance, so the same terminal class. */
  const QUOTA_EXHAUSTED_RE = /usage[_ ]?limit(?:[_ ]?(?:has|is)(?:[_ ]?been)?)?[_ ]?reached|hit (?:your|the) (?:usage|weekly|monthly|plan|daily) limit|(?:weekly|monthly|daily) (?:quota|limit)|resets? in \s*\d+\s*(?:day|hour|week)|resets? (?:on|at) \d|quota (?:will )?reset(?:s)? (?:in|on|at)|usage[-_ ]?exhausted|used all (?:of )?(?:the |your )?included (?:free )?usage/;
  const SHORT_WINDOW_RE = /per[- ]?(?:minute|second)|quota metric|rpm|tpm|requests per/;
  function isQuotaExhausted(low) { return QUOTA_EXHAUSTED_RE.test(low) && !SHORT_WINDOW_RE.test(low); }
  // structured codes for the same spent allowance (Codex usage_limit_reached, xAI subscription:free-usage-exhausted)
  const QUOTA_CODE_RE = /usage_limit_reached|quota_exhausted|plan_limit|usage[-_ ]?exhausted/;
  /* An account with no money (or at its spending cap) is BILLING, and no wait fixes it: OpenAI answers
     insufficient_quota with 429, and xAI's API-key surface answers an empty team with 429 "used all available
     credits or reached its monthly spending limit". */
  const TERMINAL_BILLING_RE = /insufficient[_ ]?quota|exceeded your current quota|out of credit|add credits|payment required|spending limit|used all available credits/;

  function pickReason(status, code, low, err, ctx) {
    /* 1. content / policy (most specific intent) — but a TRANSPORT status wins over a text match.
       This ran against the whole message before the status was consulted, so any retryable failure whose
       text merely CONTAINED one of these words was rewritten as a fatal policy block: a 503 naming
       `openai/omni-moderation-latest`, a 429 on a "safety" tier, a 500 from a content_filter component.
       The classifier then reported retryable:false / shouldFallback:false and the loop killed the run
       instead of retrying or failing over — and agent.run.error.transient lied about why. A real policy
       refusal never arrives as 429/5xx; it comes as 400/403/422 or with no status at all. */
    const transportStatus = status === 429 || (status >= 500 && status < 600) || status === 408;
    if (!transportStatus && /content[ _]?policy|moderation|flagged|safety|content_filter/.test(low)) return 'content_policy_blocked';
    // 2. HTTP status
    if (status) {
      if (status === 401 || status === 403) return 'auth';
      if (status === 402) {
        // the same terminal bodies as the 429 below outrank the reset-window read: "spending limit resets at…" is
        // still an empty wallet (Payment Required, so billing reads first), and "used all the included free
        // usage" is a spent allowance, which — unlike billing — another provider can pick up.
        if (TERMINAL_BILLING_RE.test(low)) return 'billing';
        if (isQuotaExhausted(low) || QUOTA_CODE_RE.test(String(code || '').toLowerCase())) return 'quota_exhausted';
        return /(resets? at|retry[- ]?after|rate limit)/.test(low) ? 'rate_limit' : 'billing';
      }
      if (status === 404) return 'model_not_found';
      if (status === 408) return 'timeout';
      /* 426 Upgrade Required: the endpoint refuses this CLIENT (xAI's cli-chat-proxy gates on the Grok-CLI
         version header). format_error is the honest existing class: the request itself is unacceptable, so a
         retry, a rotated credential or a compaction resends the same rejected thing — non-retryable and not
         auth (the sign-in is fine; re-signing in would be a doomed door). */
      if (status === 426) return 'format_error';
      if (status === 429) {
        /* A 429 can carry a TERMINAL body, and neither of these clears by waiting: a spent subscription
           allowance, or an account with no money left — OpenAI answers `insufficient_quota` with 429, not 402,
           so the plain status read burned every retry slot against a wallet that needs topping up. */
        const c429 = String(code || '').toLowerCase();
        if (isQuotaExhausted(low) || QUOTA_CODE_RE.test(c429)) return 'quota_exhausted';
        if (TERMINAL_BILLING_RE.test(low) || /insufficient[_ ]?quota/.test(c429)) return 'billing';
        return 'rate_limit';
      }
      if (status === 500) return 'server_error';
      if (status === 502 || status === 503) return 'overloaded';
      if (status === 504) return 'timeout';
      if (status === 400 || status === 413 || status === 422) return classify400(low, code, ctx);
    }
    // 3. structured error-code (errors that arrive with no HTTP status)
    if (code) {
      const c = String(code).toLowerCase();
      if (/context_length|context_window|max.*token/.test(c)) return 'context_overflow';
      if (QUOTA_CODE_RE.test(c)) return 'quota_exhausted';
      if (/insufficient_quota|insufficient_credit|billing|payment/.test(c)) return 'billing';
      if (/rate_limit/.test(c)) return 'rate_limit';
      if (/model_not_found|unknown_model|no_endpoints/.test(c)) return 'model_not_found';
      if (/content_policy|moderation/.test(c)) return 'content_policy_blocked';
      if (/invalid_api_key|authentication|unauthorized/.test(c)) return 'auth';
    }
    // 4. message patterns
    if (/context length|maximum context|context window|too many tokens|reduce the length|maximum.*tokens/.test(low)) return 'context_overflow';
    if (isQuotaExhausted(low)) return 'quota_exhausted';
    if (/insufficient|not enough credit|out of credit|quota|payment required|add credits|spending limit|used all available credits/.test(low)) return 'billing';
    if (/rate limit|too many requests/.test(low)) return 'rate_limit';
    if (/overloaded|over capacity|temporarily unavailable|try again later/.test(low)) return 'overloaded';
    if (/no endpoints|model not found|not a valid model|unknown model|no allowed providers/.test(low)) return 'model_not_found';
    if (/unauthorized|invalid api key|no auth credentials|authentication/.test(low)) return 'auth';
    if (/timed out|timeout/.test(low)) return 'timeout';
    // 5. transport
    if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED|UND_ERR/i.test(transportCode(err))) return 'timeout';
    // 6. ratio heuristic (only with a known limit)
    if (ctx.contextLimit > 0 && ctx.approxTokens > 0.4 * ctx.contextLimit) return 'context_overflow';
    // 7. unknown — one retry is safe-ish
    return 'unknown';
  }

  function classifyApiError(err, ctx) {
    ctx = ctx || {};
    const status = extractStatus(err);
    const body = extractBody(err);
    const code = extractCode(body, err);
    const message = extractMessage(err, body);
    const reason = pickReason(status, code, String(message).toLowerCase(), err, ctx);
    const f = REASONS[reason] || REASONS.unknown;
    const wait = extractRetryAfter(err, body, message);
    return {
      reason,
      retryable: f.retryable,
      shouldRotateCredential: f.shouldRotateCredential,
      shouldFallback: f.shouldFallback,
      shouldCompress: f.shouldCompress,
      statusCode: status || null,
      retryAfterMs: wait.retryAfterMs,   // H6.1: server-stated delay (relative ms), or null
      resetAtMs: wait.resetAtMs,         // H6.1: server-stated absolute reset (epoch ms), or null
      // `reason` above was already picked from the RAW message, so annotating here cannot move the verdict — it
      // only makes the text a human can act on ("fetch failed" -> "fetch failed (ENOTFOUND api.openai.com)").
      // This is the message the loop emits as agent.run.error, which is what lands in the diagnostics ring.
      message: annotateTransport(message, err)
    };
  }

  return { classifyApiError, REASONS, transportDetail, annotateTransport,
    _internals: { extractStatus, extractCode, extractMessage, classify400, pickReason, extractRetryAfter, transportCode } };
});
