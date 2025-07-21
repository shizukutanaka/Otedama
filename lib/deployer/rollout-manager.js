/*
 * RolloutManager
 * Progressive delivery & canary release utilities for Otedama.
 *
 * Features:
 *  - Health-check gated rollout (pre/post)
 *  - Progressive traffic shifting (1%,10%,50%,100%)
 *  - Automatic rollback on health degradation
 *  - Prometheus metrics and Slack notifications
 *
 * Usage (simplified):
 *  const manager = new RolloutManager({
 *    service: 'otedama',
 *    newImage: 'otedama/otedama:0.8.1',
 *    k8sNamespace: 'default'
 *  });
 *  await manager.startCanary();
 */

import { exec as _exec } from 'node:child_process';
import { promisify } from 'node:util';
import fetch from 'node-fetch';

const exec = promisify(_exec);

export default class RolloutManager {
  constructor(options) {
    const defaults = {
      steps: [1, 10, 50, 100],
      pauseSeconds: 120,
      slackWebhook: process.env.SLACK_WEBHOOK_URL || '',
      healthEndpoint: `http://localhost:${process.env.API_PORT || 8080}/api/health`,
      prometheusPushGateway: process.env.PUSHGATEWAY_URL || '',
    };
    this.opts = { ...defaults, ...options };
    if (!this.opts.service || !this.opts.newImage) {
      throw new Error('service and newImage are required');
    }
  }

  async startCanary() {
    await this._notify(`🚀 Starting canary rollout for ${this.opts.service} -> ${this.opts.newImage}`);
    for (const pct of this.opts.steps) {
      await this._setTraffic(pct);
      await this._notify(`⏳ Shifted ${pct}% traffic. Waiting ${this.opts.pauseSeconds}s for health check…`);
      await this._sleep(this.opts.pauseSeconds * 1000);
      const healthy = await this._healthCheck();
      if (!healthy) {
        await this._notify(`❌ Health check failed at ${pct}%. Initiating rollback.`);
        await this.rollback();
        throw new Error('Canary rollout aborted due to failed health check');
      }
      await this._notify(`✅ ${pct}% traffic healthy.`);
    }
    await this._notify('🎉 Canary rollout completed successfully!');
  }

  async rollback() {
    // simplistic rollback: point image back to previous (assumes tag latest)
    await exec(`kubectl rollout undo deployment/${this.opts.service} -n ${this.opts.k8sNamespace || 'default'}`);
    await this._pushMetric('rollback_total', 1);
  }

  /** Private helpers */
  async _setTraffic(percent) {
    // Assumes use of Istio or Linkerd percent routing via label revision
    const rev = percent === 100 ? 'stable' : 'canary';
    await exec(`kubectl patch virtualservice ${this.opts.service}-vs -n ${this.opts.k8sNamespace || 'default'} --type merge -p '{"spec":{"http":[{"route":[{"destination":{"host":"${this.opts.service}","subset":"stable"},"weight":${100 - percent}},{"destination":{"host":"${this.opts.service}","subset":"canary"},"weight":${percent}}]}]}}'`);
    await this._pushMetric('traffic_percent', percent);
  }

  async _healthCheck() {
    try {
      const res = await fetch(this.opts.healthEndpoint, { timeout: 5000 });
      const data = await res.json();
      return data.status === 'ok';
    } catch {
      return false;
    }
  }

  async _notify(text) {
    console.log(text);
    if (this.opts.slackWebhook) {
      await fetch(this.opts.slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    }
  }

  async _pushMetric(name, value) {
    if (!this.opts.prometheusPushGateway) return;
    await fetch(`${this.opts.prometheusPushGateway}/metrics/job/otedama_rollout`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: `${name} ${value}\n`,
    });
  }

  _sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }
}
