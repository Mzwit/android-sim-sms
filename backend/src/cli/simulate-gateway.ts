/**
 * Run a simulated phone against a real server. No SMS is sent and no airtime is used.
 * Lets you try the dashboard end to end before installing the Android app.
 *
 *   npm run simulate -- --url http://localhost:8443 --code ABCDE-23456 [--interval 1000] [--failures 0.03]
 *
 * Pair it from the dashboard (Phones → Pair a phone) and pass the code shown.
 * The token is saved to .sim-gateway.json so later runs reuse the pairing.
 */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_POLICY, GatewaySimulator, type Call } from '../sim/simulator.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8443' },
    code: { type: 'string' },
    interval: { type: 'string', default: '1500' },
    failures: { type: 'string', default: '0.03' },
    'no-reports': { type: 'boolean', default: false },
    state: { type: 'string', default: '.sim-gateway.json' },
  },
});

const base = values.url!.replace(/\/+$/, '');
const call: Call = async (method, path, body, token) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Gateway ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const failures = Number(values.failures);
const sim = new GatewaySimulator(call, {
  ...DEFAULT_POLICY,
  transientFailure: failures,
  permanentFailure: failures / 6,
  unknown: failures / 15,
  deliveryReport: values['no-reports'] ? 0 : 0.85,
  duplicateEvents: 0,
}, Date.now() % 100000, 'cli-sim');

if (existsSync(values.state!) && !values.code) {
  const s = JSON.parse(readFileSync(values.state!, 'utf8'));
  if (s.url === base) {
    sim.token = s.token;
    sim.gatewayId = s.gatewayId;
  }
}
if (!sim.token) {
  if (!values.code) {
    console.error('First run: pass --code from the dashboard (Phones → Pair a phone).');
    process.exit(2);
  }
  const r = await sim.pair(values.code.replace(/[^A-Za-z0-9]/g, ''));
  writeFileSync(values.state!, JSON.stringify({ url: base, token: sim.token, gatewayId: sim.gatewayId }));
  console.log(`Paired as "${r.config.name}". Token saved to ${values.state}.`);
}

const interval = Math.max(0, Number(values.interval));
let lastHeartbeat = 0;
console.log(`Simulated phone running against ${base} (one message every ${interval} ms). Ctrl+C to stop.`);
for (;;) {
  try {
    if (Date.now() - lastHeartbeat > 30_000) {
      const hb = await sim.heartbeat({ battery_pct: 70 + Math.round(Math.random() * 25), signal_level: 2 + Math.round(Math.random() * 2) });
      if (hb.status === 401) {
        console.error('This simulated phone was unpaired on the dashboard. Delete the state file and pair again.');
        process.exit(1);
      }
      lastHeartbeat = Date.now();
    }
    const n = await sim.runOnce({ max: 1 });
    if (n === 0) {
      await new Promise((r) => setTimeout(r, 5000));
    } else {
      process.stdout.write(`\rsubmitted ${sim.stats.submitted}  failed ${sim.stats.failed}  unknown ${sim.stats.unknown}  refused ${sim.stats.refused}   `);
      await new Promise((r) => setTimeout(r, interval));
    }
  } catch (err) {
    console.error('\n', (err as Error).message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
