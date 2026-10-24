/**
 * Mock telephony: a simulated Android gateway that speaks the real phone
 * protocol (pair → heartbeat → lease → confirm → events). Used by the automated
 * tests and the 6,000-recipient load test, so nothing costs airtime.
 *
 * Outcomes are drawn from a seeded PRNG, so a run is reproducible.
 */
export type Call = (method: 'GET' | 'POST', path: string, body?: unknown, token?: string) => Promise<{ status: number; body: any }>;

export interface SimPolicy {
  /** Probability a part fails with a transient radio error (RESULT_ERROR_GENERIC_FAILURE = 1). */
  transientFailure: number;
  /** Probability a message is rejected permanently (RESULT_NETWORK_REJECT = 10). */
  permanentFailure: number;
  /** Probability the app "dies" after handing the SMS to Android and reports SUBMIT_UNKNOWN. */
  unknown: number;
  /** Probability the network returns a delivery report for a submitted part. */
  deliveryReport: number;
  /** Probability a returned delivery report is a failure (TP-Status 0x41). */
  deliveryFailure: number;
  /** Probability each event batch is sent twice (tests idempotency). */
  duplicateEvents: number;
  /** Simulated Android parts per message; 0 = use the server's estimate. */
  forceParts: number;
}

export const DEFAULT_POLICY: SimPolicy = {
  transientFailure: 0.02,
  permanentFailure: 0.005,
  unknown: 0.002,
  deliveryReport: 0.9,
  deliveryFailure: 0.01,
  duplicateEvents: 0.05,
  forceParts: 0,
};

export function prng(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimStats {
  leased: number;
  confirmed: number;
  refused: number;
  submitted: number;
  failed: number;
  unknown: number;
  deliveryReports: number;
  eventsSent: number;
  idleReasons: Record<string, number>;
  refusedReasons: Record<string, number>;
}

export class GatewaySimulator {
  token?: string;
  gatewayId?: string;
  readonly stats: SimStats = { leased: 0, confirmed: 0, refused: 0, submitted: 0, failed: 0, unknown: 0, deliveryReports: 0, eventsSent: 0, idleReasons: {}, refusedReasons: {} };
  private rand: () => number;
  private evSeq = 0;
  /** Delivery reports held back to be sent later (simulates network delay). */
  pendingDeliveries: any[] = [];

  constructor(private call: Call, public policy: SimPolicy = DEFAULT_POLICY, seed = 42, public name = 'sim') {
    this.rand = prng(seed);
  }

  private ev(e: Record<string, unknown>) {
    return { id: `${this.name}-${++this.evSeq}`, at: new Date().toISOString(), ...e };
  }

  async pair(code: string) {
    const r = await this.call('POST', '/api/v1/gateway/pair', { code, device_model: 'Simulator', android_version: '15', app_version: 'sim-1' });
    if (r.status !== 201) throw new Error(`pair failed ${r.status} ${JSON.stringify(r.body)}`);
    this.token = r.body.token;
    this.gatewayId = r.body.config.gateway_id;
    await this.call('POST', '/api/v1/gateway/sim', { subscription_id: 1, slot_index: 0, display_name: 'SIM 1', carrier_name: 'Simulated' }, this.token);
    return r.body;
  }

  async heartbeat(extra: Record<string, unknown> = {}) {
    return this.call('POST', '/api/v1/gateway/heartbeat', { battery_pct: 80, is_charging: true, signal_level: 3, network_type: 'LTE', sim_state: 'READY', service_running: true, ...extra }, this.token);
  }

  async sendEvents(events: any[]) {
    if (!events.length) return [];
    const out: any[] = [];
    for (let i = 0; i < events.length; i += 200) {
      const chunk = events.slice(i, i + 200);
      const r = await this.call('POST', '/api/v1/gateway/events', { events: chunk }, this.token);
      if (r.status !== 200) throw new Error(`events failed ${r.status} ${JSON.stringify(r.body)}`);
      this.stats.eventsSent += chunk.length;
      out.push(...r.body.acks);
      if (this.rand() < this.policy.duplicateEvents) await this.call('POST', '/api/v1/gateway/events', { events: chunk }, this.token);
    }
    return out;
  }

  /** Lease one batch and process it completely. Returns number of jobs leased. */
  async runOnce(opts: { max?: number; crashAfterConfirm?: boolean; holdDeliveries?: boolean } = {}): Promise<number> {
    const r = await this.call('POST', '/api/v1/gateway/lease', { max: opts.max ?? 50 }, this.token);
    if (r.status !== 200) throw new Error(`lease failed ${r.status} ${JSON.stringify(r.body)}`);
    const jobs = r.body.jobs as any[];
    if (!jobs.length) {
      const reason = r.body.idle_reason ?? 'NONE';
      this.stats.idleReasons[reason] = (this.stats.idleReasons[reason] ?? 0) + 1;
      return 0;
    }
    this.stats.leased += jobs.length;
    const events: any[] = [];
    for (const job of jobs) {
      const c = await this.call('POST', `/api/v1/gateway/attempts/${job.attempt_id}/confirm`, undefined, this.token);
      if (c.body.decision !== 'SEND') {
        this.stats.refused++;
        const why = c.body.reason ?? `HTTP_${c.status}`;
        this.stats.refusedReasons[why] = (this.stats.refusedReasons[why] ?? 0) + 1;
        continue;
      }
      this.stats.confirmed++;
      if (opts.crashAfterConfirm) continue; // phone died after confirmation: no report at all
      const parts = this.policy.forceParts || job.segments;
      const roll = this.rand();
      if (roll < this.policy.unknown) {
        events.push(this.ev({ type: 'SUBMIT_UNKNOWN', attempt_id: job.attempt_id, app_code: 'PROCESS_KILLED' }));
        this.stats.unknown++;
        continue;
      }
      const permanent = roll < this.policy.unknown + this.policy.permanentFailure;
      const transient = !permanent && roll < this.policy.unknown + this.policy.permanentFailure + this.policy.transientFailure;
      for (let p = 0; p < parts; p++) {
        const fail = (permanent || transient) && p === parts - 1;
        events.push(this.ev({ type: 'PART_SENT', attempt_id: job.attempt_id, part_index: p, parts_total: parts, result_code: fail ? (permanent ? 10 : 1) : -1 }));
      }
      if (permanent || transient) {
        this.stats.failed++;
        continue;
      }
      this.stats.submitted++;
      for (let p = 0; p < parts; p++) {
        if (this.rand() < this.policy.deliveryReport) {
          const failed = this.rand() < this.policy.deliveryFailure;
          const d = this.ev({ type: 'DELIVERY', attempt_id: job.attempt_id, part_index: p, tp_status: failed ? 0x41 : 0x00 });
          this.stats.deliveryReports++;
          if (opts.holdDeliveries) this.pendingDeliveries.push(d);
          else events.push(d);
        }
      }
    }
    await this.sendEvents(events);
    return jobs.length;
  }

  async flushDeliveries() {
    const d = this.pendingDeliveries;
    this.pendingDeliveries = [];
    return this.sendEvents(d);
  }

  /** Keep leasing until the server has nothing more to give. */
  async drain(maxRounds = 10_000, max = 50): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.runOnce({ max });
      if (!n) break;
      total += n;
    }
    return total;
  }
}
