import { EventEmitter } from 'node:events';
import { Hub } from './hub.js';
import { GreenroomStore } from './store.js';
import { computeAlerts } from './alerts.js';
import { ShureReceiver } from './drivers/shure.js';
import { ProPresenter } from './drivers/propresenter.js';
import { AtemSwitcher, VmixSwitcher } from './drivers/switchers.js';
import { SimReceiver, SimProPresenter, SimSwitcher } from './drivers/simulator.js';
import { PlanningCenter } from './drivers/planningcenter.js';
import { ServiceManager } from './service.js';
import { Board, Dashboards } from './collab.js';
import { defaultDashboards } from './default-dashboards.js';

const RECEIVER_DRIVERS = { shure: ShureReceiver, simulator: SimReceiver };
const PP_DRIVERS = { propresenter: ProPresenter, simulator: SimProPresenter };
const SWITCHER_DRIVERS = { atem: AtemSwitcher, vmix: VmixSwitcher, simulator: SimSwitcher };
export const micIdFor = (rxId, ch) => `${rxId}.${ch}`;

/**
 * Everything that belongs to the active organization: gear connections, people,
 * dashboards, notes, service plan and alerts. Switching organization (or saving gear
 * settings) stops this and starts a new one. Emits 'message' for the browser.
 */
export class Runtime extends EventEmitter {
  constructor({ orgId, dir, settings }) {
    super();
    this.orgId = orgId;
    this.settings = settings;
    this.hub = new Hub();
    this.store = new GreenroomStore(dir);
    this.board = new Board(dir);
    this.dashboards = new Dashboards(dir, defaultDashboards(settings));
    this.service = new ServiceManager({
      dataDir: dir,
      pco: settings.planningCenter ? new PlanningCenter(settings.planningCenter) : null,
      cfg: settings.service,
    });
    this.alerts = [];
    this.buildDevices();
  }

  buildDevices() {
    const s = this.settings;
    this.micSlots = [];
    this.receivers = {};
    for (const rx of s.mics.receivers) {
      const Driver = RECEIVER_DRIVERS[rx.type];
      rx.channels.forEach((slot, i) => {
        this.micSlots.push({
          id: micIdFor(rx.id, i + 1),
          receiverId: rx.id,
          receiverName: rx.name,
          channel: i + 1,
          label: slot.label,
          kind: slot.kind,
          color: slot.color || null,
          hidden: Boolean(slot.hidden),
        });
      });
      this.receivers[rx.id] = new Driver({ ...rx, channels: rx.channels.length }, this.hub, micIdFor);
    }
    this.propresenters = Object.fromEntries(s.propresenter.map((pp) => [pp.id, new PP_DRIVERS[pp.type](pp, this.hub)]));
    this.switchers = Object.fromEntries(s.switchers.map((sw) => [sw.id, new SWITCHER_DRIVERS[sw.type](sw, this.hub)]));
  }

  devices() { return [...Object.values(this.receivers), ...Object.values(this.propresenters), ...Object.values(this.switchers)]; }

  start() {
    const send = (msg) => this.emit('message', msg);
    this.hub.on('update', (u) => send({ type: 'update', ...u }));
    this.hub.on('meters', (meters) => send({ type: 'meters', meters }));
    this.store.on('change', (data) => { send({ type: 'greenroom', greenroom: data }); this.refreshAlerts(); });
    this.service.on('change', (data) => send({ type: 'service', service: data }));
    this.board.on('change', (data) => send({ type: 'board', board: data }));
    this.dashboards.on('change', () => send({ type: 'dashboards', dashboards: this.dashboards.list() }));

    // Auto-track the service: ProPresenter changing presentation moves the plan along.
    // The cued playlist item is the strongest signal; the presentation name covers
    // presentations triggered from the library (outside a playlist).
    const lastPresentation = {};
    const lastPlaylist = {};
    this.hub.on('update', ({ section, id, data }) => {
      if (section !== 'propresenter' || !data) return;
      const pl = data.playlist;
      const plKey = pl ? `${pl.uuid}:${pl.index}:${pl.items.length}` : '';
      if (pl && lastPlaylist[id] !== plKey) {
        lastPlaylist[id] = plKey;
        lastPresentation[id] = data.presentation?.name;
        this.service.onPlaylist(pl);
        return;
      }
      if (!data.presentation?.name || lastPresentation[id] === data.presentation.name) return;
      lastPresentation[id] = data.presentation.name;
      this.service.onPresentation(data.presentation.name);
    });
    // A newly loaded plan picks up wherever ProPresenter already is.
    this.service.on('planLoaded', () => {
      for (const pp of Object.values(this.hub.state.propresenter)) {
        if (!pp.online) continue;
        if (pp.playlist) this.service.onPlaylist(pp.playlist);
        else if (pp.presentation?.name) this.service.onPresentation(pp.presentation.name);
      }
    });

    for (const d of this.devices()) d.start();
    this.service.start().catch((e) => console.error(`[service] ${e.message}`));
    this.alertTimer = setInterval(() => this.refreshAlerts(), 1000);
    this.alertTimer.unref();
  }

  stop() {
    clearInterval(this.alertTimer);
    for (const d of this.devices()) d.stop?.();
    this.service.stop();
    this.hub.stop();
    for (const e of [this.store, this.board, this.dashboards]) e.removeAllListeners();
    this.removeAllListeners();
  }

  refreshAlerts() {
    const next = computeAlerts(this.hub.state, this.store.data, this.micSlots, this.settings);
    if (JSON.stringify(next) !== JSON.stringify(this.alerts)) {
      this.alerts = next;
      this.emit('message', { type: 'alerts', alerts: next });
    }
  }

  snapshot() {
    return {
      type: 'snapshot', state: this.hub.state, slots: this.micSlots, greenroom: this.store.data, alerts: this.alerts,
      service: this.service.state(), board: this.board.data, dashboards: this.dashboards.list(),
    };
  }

  pushName(micId) {
    const slot = this.micSlots.find((m) => m.id === micId);
    const a = this.store.data.assignments[micId];
    const person = a && this.store.person(a.personId);
    const rx = slot && this.receivers[slot.receiverId];
    if (!rx?.setChannelName) return false;
    rx.setChannelName(slot.channel, person ? person.name.split(' ')[0] : slot.label);
    return true;
  }
}
