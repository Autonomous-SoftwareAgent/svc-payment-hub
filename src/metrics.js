'use strict';
// spec: PHUB-S-013
// Số đo theo định dạng văn bản Prometheus (PHUB-D-013). Không thư viện ngoài.
// Counter và histogram tích lũy trong bộ nhớ; gauge tính lúc đọc (hàm trả về giá trị hiện tại).

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labelText = (labels) => {
  const keys = Object.keys(labels || {}).sort();
  return keys.length ? `{${keys.map((k) => `${k}="${esc(labels[k])}"`).join(',')}}` : '';
};

class Metrics {
  constructor() {
    this.defs = new Map(); // name -> {type, help}
    this.counters = new Map(); // name -> Map(labelText -> number)
    this.hists = new Map(); // name -> Map(labelText -> {buckets:[], sum, count, labels})
    this.gauges = new Map(); // name -> fn() -> number | [{labels, value}]
  }

  define(name, type, help) { this.defs.set(name, { type, help }); return name; }

  inc(name, labels = {}, v = 1) {
    let m = this.counters.get(name);
    if (!m) { m = new Map(); this.counters.set(name, m); }
    const k = labelText(labels);
    m.set(k, (m.get(k) || 0) + v);
  }

  observe(name, labels, seconds) {
    let m = this.hists.get(name);
    if (!m) { m = new Map(); this.hists.set(name, m); }
    const k = labelText(labels);
    let h = m.get(k);
    if (!h) { h = { labels: labels || {}, buckets: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 }; m.set(k, h); }
    h.count += 1;
    h.sum += seconds;
    for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]) h.buckets[i] += 1;
  }

  gauge(name, help, fn) { this.define(name, 'gauge', help); this.gauges.set(name, fn); }

  render() {
    const out = [];
    const head = (name) => { const d = this.defs.get(name); if (d) { out.push(`# HELP ${name} ${d.help}`); out.push(`# TYPE ${name} ${d.type}`); } };
    for (const [name, m] of this.counters) { head(name); for (const [k, v] of m) out.push(`${name}${k} ${v}`); }
    for (const [name, m] of this.hists) {
      head(name);
      for (const h of m.values()) {
        BUCKETS.forEach((le, i) => out.push(`${name}_bucket${labelText({ ...h.labels, le })} ${h.buckets[i]}`));
        out.push(`${name}_bucket${labelText({ ...h.labels, le: '+Inf' })} ${h.count}`);
        out.push(`${name}_sum${labelText(h.labels)} ${h.sum}`);
        out.push(`${name}_count${labelText(h.labels)} ${h.count}`);
      }
    }
    for (const [name, fn] of this.gauges) {
      head(name);
      let v;
      try { v = fn(); } catch { continue; }
      if (Array.isArray(v)) for (const x of v) out.push(`${name}${labelText(x.labels)} ${x.value}`);
      else out.push(`${name} ${v}`);
    }
    return out.join('\n') + '\n';
  }
}

module.exports = { Metrics, BUCKETS };
