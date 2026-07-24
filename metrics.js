/**
 * Hand-rolled Prometheus text-exposition-format metrics.
 * No npm dependency (this app is deliberately zero-dependency — see server.js
 * top-of-file comment) so this reimplements just enough of what prom-client
 * would give us, using the SAME metric names / bucket boundaries as this
 * app's sibling services (jamf-prestage-tool, et al.) so their Grafana
 * dashboard panels and PromQL work here unchanged.
 */
'use strict';

// Same bucket boundaries used across this monitoring setup.
const DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10];

// key: JSON.stringify([method, route, status]) -> count
const requestsTotal = new Map();

// key: JSON.stringify([method, route, status]) -> { buckets: number[], sum, count }
// buckets[i] is the cumulative count of observations <= DURATION_BUCKETS[i],
// per Prometheus's "le" bucket semantics.
const requestDuration = new Map();

function labelKey(method, route, status) {
  return JSON.stringify([method, route, String(status)]);
}

// Escapes a label value per the Prometheus text-exposition format:
// backslash, double-quote, and newline must be backslash-escaped.
function escapeLabelValue(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function formatLabels(pairs) {
  return pairs.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',');
}

// Records one completed HTTP request. `route` should always be a static
// label (e.g. "/api/folders/:id"), never a raw interpolated path, to keep
// cardinality bounded.
function recordRequest(method, route, status, durationSeconds) {
  const key = labelKey(method, route, status);

  requestsTotal.set(key, (requestsTotal.get(key) || 0) + 1);

  let hist = requestDuration.get(key);
  if (!hist) {
    hist = { buckets: new Array(DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 };
    requestDuration.set(key, hist);
  }
  for (let i = 0; i < DURATION_BUCKETS.length; i++) {
    if (durationSeconds <= DURATION_BUCKETS[i]) hist.buckets[i]++;
  }
  hist.sum += durationSeconds;
  hist.count++;
}

// Renders the full /metrics response body in Prometheus text-exposition
// format (version 0.0.4). process_resident_memory_bytes and
// process_cpu_seconds_total are sampled fresh here, once per scrape.
function renderMetrics() {
  const lines = [];

  lines.push('# HELP http_requests_total Total number of HTTP requests');
  lines.push('# TYPE http_requests_total counter');
  for (const [key, count] of requestsTotal) {
    const [method, route, status] = JSON.parse(key);
    const labels = formatLabels([['method', method], ['route', route], ['status', status]]);
    lines.push(`http_requests_total{${labels}} ${count}`);
  }

  lines.push('# HELP http_request_duration_seconds Duration of HTTP requests in seconds');
  lines.push('# TYPE http_request_duration_seconds histogram');
  for (const [key, hist] of requestDuration) {
    const [method, route, status] = JSON.parse(key);
    const baseLabels = [['method', method], ['route', route], ['status', status]];
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      const le = formatLabels([...baseLabels, ['le', String(DURATION_BUCKETS[i])]]);
      lines.push(`http_request_duration_seconds_bucket{${le}} ${hist.buckets[i]}`);
    }
    const leInf = formatLabels([...baseLabels, ['le', '+Inf']]);
    lines.push(`http_request_duration_seconds_bucket{${leInf}} ${hist.count}`);
    const plain = formatLabels(baseLabels);
    lines.push(`http_request_duration_seconds_sum{${plain}} ${hist.sum}`);
    lines.push(`http_request_duration_seconds_count{${plain}} ${hist.count}`);
  }

  const cpu = process.cpuUsage(); // microseconds, cumulative since process start
  const cpuSeconds = (cpu.user + cpu.system) / 1e6;
  lines.push('# HELP process_cpu_seconds_total Total user and system CPU time spent in seconds');
  lines.push('# TYPE process_cpu_seconds_total counter');
  lines.push(`process_cpu_seconds_total ${cpuSeconds}`);

  const rss = process.memoryUsage().rss;
  lines.push('# HELP process_resident_memory_bytes Resident memory size in bytes');
  lines.push('# TYPE process_resident_memory_bytes gauge');
  lines.push(`process_resident_memory_bytes ${rss}`);

  return lines.join('\n') + '\n';
}

module.exports = { recordRequest, renderMetrics, DURATION_BUCKETS };
