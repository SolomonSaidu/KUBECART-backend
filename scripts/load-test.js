function parseArgs(argv) {
  const options = {
    url: 'http://localhost:3000/api/v1/health',
    concurrency: 20,
    durationSeconds: 10,
    timeoutMs: 5000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const [name, inlineValue] = argv[index].split('=');
    const value = inlineValue ?? argv[index + 1];

    if (name === '--url') options.url = value;
    if (name === '--concurrency') options.concurrency = Number(value);
    if (name === '--duration') options.durationSeconds = Number(value);
    if (name === '--timeout') options.timeoutMs = Number(value);

    if (!inlineValue && value && !value.startsWith('--')) {
      index += 1;
    }
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }

  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0) {
    throw new Error('--duration must be a positive number of seconds');
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error('--timeout must be a positive integer');
  }

  return options;
}

function percentile(sortedLatencies, percentileValue) {
  const index = Math.ceil((percentileValue / 100) * sortedLatencies.length) - 1;
  return sortedLatencies[Math.max(index, 0)];
}

const options = parseArgs(process.argv.slice(2));
const latencies = [];
const statusCounts = {};
let errors = 0;
const endAt = Date.now() + options.durationSeconds * 1000;

async function worker() {
  while (Date.now() < endAt) {
    const startedAt = performance.now();

    try {
      const response = await fetch(options.url, {
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      await response.arrayBuffer();
      statusCounts[response.status] = (statusCounts[response.status] || 0) + 1;

      if (!response.ok) {
        errors += 1;
      }
    } catch {
      errors += 1;
    } finally {
      latencies.push(performance.now() - startedAt);
    }
  }
}

await Promise.all(
  Array.from({ length: options.concurrency }, () => worker())
);

const sorted = [...latencies].sort((left, right) => left - right);
const totalMs = Math.max(
  sorted.reduce((total, latency) => total + latency, 0),
  1
);
const summary = {
  url: options.url,
  concurrency: options.concurrency,
  durationSeconds: options.durationSeconds,
  requests: latencies.length,
  requestsPerSecond: Number(
    (latencies.length / options.durationSeconds).toFixed(2)
  ),
  errors,
  errorRate: Number(((errors / Math.max(latencies.length, 1)) * 100).toFixed(2)),
  statusCounts,
  latencyMs: {
    average: Number((totalMs / Math.max(latencies.length, 1)).toFixed(2)),
    p50: Number(percentile(sorted, 50).toFixed(2)),
    p95: Number(percentile(sorted, 95).toFixed(2)),
    p99: Number(percentile(sorted, 99).toFixed(2)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
  },
};

console.log(JSON.stringify(summary, null, 2));

if (errors > 0) {
  process.exitCode = 1;
}
