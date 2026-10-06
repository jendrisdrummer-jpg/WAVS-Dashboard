/**
 * Planning Center Services (read-only).
 *
 * Auth: a Personal Access Token from https://api.planningcenteronline.com/oauth/applications
 * ("Personal Access Tokens" → application ID + secret), sent as HTTP Basic auth.
 *
 * Endpoints used:
 *   GET /services/v2/service_types
 *   GET /services/v2/service_types/{st}/plans?filter=future|past&order=sort_date
 *   GET /services/v2/service_types/{st}/plans/{plan}            (title, series, dates)
 *   GET /services/v2/service_types/{st}/plans/{plan}/items       (order of service)
 *   GET /services/v2/service_types/{st}/plans/{plan}/plan_times  (service / rehearsal times)
 *   GET /services/v2/service_types/{st}/plans/{plan}/live?include=items,current_item_time
 *       (which item Services LIVE is on, and when it started)
 */
const BASE = 'https://api.planningcenteronline.com/services/v2';

export class PlanningCenter {
  constructor(cfg) {
    this.cfg = { serviceTypes: [], ...cfg };
    this.auth = `Basic ${Buffer.from(`${cfg.appId}:${cfg.secret}`).toString('base64')}`;
  }

  async get(path) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      let res;
      try {
        res = await fetch(BASE + path, { headers: { Authorization: this.auth, Accept: 'application/json' }, signal: ctrl.signal });
      } finally {
        clearTimeout(t);
      }
      if (res.status === 429) {
        // Rate limited (100 requests / 20 s): wait as instructed, then retry.
        await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') || 5) * 1000));
        continue;
      }
      if (res.status === 401) throw new Error('Planning Center rejected the token (check appId / secret)');
      if (!res.ok) throw new Error(`Planning Center ${res.status} on ${path.split('?')[0]}`);
      return res.json();
    }
    throw new Error('Planning Center rate limit');
  }

  async serviceTypes() {
    const r = await this.get('/service_types?per_page=100');
    return r.data.map((d) => ({ id: d.id, name: d.attributes.name }));
  }

  /** Plans from yesterday onward (so a service in progress is still listed), soonest first. */
  async upcomingPlans() {
    const all = await this.serviceTypes();
    const wanted = this.cfg.serviceTypes.length ? all.filter((t) => this.cfg.serviceTypes.map(String).includes(String(t.id))) : all;
    const out = [];
    for (const st of wanted) {
      const [future, past] = await Promise.all([
        this.get(`/service_types/${st.id}/plans?filter=future&order=sort_date&per_page=6`),
        this.get(`/service_types/${st.id}/plans?filter=past&order=-sort_date&per_page=1`),
      ]);
      for (const p of [...past.data, ...future.data]) {
        const sort = new Date(p.attributes.sort_date);
        if (Date.now() - sort > 36 * 3600 * 1000) continue; // older than a day and a half
        out.push({
          id: p.id,
          serviceTypeId: st.id,
          serviceTypeName: st.name,
          title: p.attributes.title || st.name,
          seriesTitle: p.attributes.series_title || null,
          dates: p.attributes.dates,
          sortDate: p.attributes.sort_date,
        });
      }
    }
    return out.sort((a, b) => new Date(a.sortDate) - new Date(b.sortDate));
  }

  async loadPlan(serviceTypeId, planId) {
    const base = `/service_types/${serviceTypeId}/plans/${planId}`;
    const [plan, items, times] = await Promise.all([
      this.get(base),
      this.get(`${base}/items?per_page=200`),
      this.get(`${base}/plan_times?per_page=50`),
    ]);
    return {
      title: plan.data.attributes.title || null,
      seriesTitle: plan.data.attributes.series_title || null,
      dates: plan.data.attributes.dates,
      times: times.data
        .map((t) => ({ id: t.id, name: t.attributes.name, type: t.attributes.time_type, startsAt: t.attributes.starts_at, endsAt: t.attributes.ends_at }))
        .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt)),
      items: items.data
        .sort((a, b) => (a.attributes.sequence ?? 0) - (b.attributes.sequence ?? 0))
        .map((i) => ({
          id: i.id,
          title: i.attributes.title,
          type: i.attributes.item_type, // song | header | media | item
          position: i.attributes.service_position, // pre | during | post
          length: i.attributes.length || 0, // seconds
          key: i.attributes.key_name || null,
          description: i.attributes.description || null,
        })),
    };
  }

  /** Current item according to Services LIVE, or null when nobody is running LIVE. */
  async live(serviceTypeId, planId) {
    const r = await this.get(`/service_types/${serviceTypeId}/plans/${planId}/live?include=items,current_item_time`);
    const timeId = r.data?.relationships?.current_item_time?.data?.id;
    const time = timeId && r.included?.find((x) => x.type === 'ItemTime' && x.id === timeId);
    const itemId = time?.relationships?.item?.data?.id;
    if (!itemId) return null;
    return { itemId, startedAt: time.attributes.live_start_at || null };
  }
}
