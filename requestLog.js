'use strict';

// One log line per request to a route, written when the response is finished:
//   [trigger] client=8 POST buckets=1 -> 202 in 34 ms
// It exists to answer "did the request arrive at all?". A failure between the browser and the
// gateway (a dropped connection, a proxy error) leaves no other trace, and a request that arrives
// but is rejected (401, 403, 400) would otherwise leave none either. No tokens or bodies are logged.

function requestLog(label, { log = console.log, now = Date.now } = {}) {
  return function requestLogMiddleware(req, res, next) {
    const startedAt = now();
    res.on('finish', () => {
      const buckets = Array.isArray(req.body?.bucketKeys) ? ` buckets=${req.body.bucketKeys.length}` : '';
      log(`[${label}] client=${req.params?.clientId ?? '?'} ${req.method}${buckets} -> ${res.statusCode} in ${now() - startedAt} ms`);
    });
    // A connection closed before a response was sent never emits 'finish'.
    res.on('close', () => {
      if (!res.writableFinished) log(`[${label}] client=${req.params?.clientId ?? '?'} ${req.method} -> connection closed before a response was sent`);
    });
    next();
  };
}

module.exports = { requestLog };
