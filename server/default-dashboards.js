import crypto from 'node:crypto';

/**
 * Starter dashboards created on first run (one per role). Everything here can be
 * rearranged, resized, removed or duplicated in the browser. This file is only a seed.
 */
export function defaultDashboards(cfg) {
  const sources = cfg.video.sources || [];
  const pgm = sources[0]?.id;
  const mv = sources[1]?.id || pgm;
  const sw = cfg.switchers[0]?.id;
  const pp = cfg.propresenter[0]?.id;
  const w = (type, x, y, wd, h, options = {}) => ({ id: crypto.randomUUID(), type, x, y, w: wd, h, options });

  const board = (name, widgets) => ({ id: crypto.randomUUID(), name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), rows: 12, widgets });

  return [
    board('Service Producer', [
      w('video', 0, 0, 5, 5, { source: pgm, switcher: sw }),
      w('propresenter', 5, 0, 4, 5, { pp }),
      w('current-item', 9, 0, 3, 3),
      w('switcher', 9, 3, 3, 2, { switcher: sw }),
      w('plan', 9, 5, 3, 7),
      w('video', 0, 5, 5, 4, { source: mv }),
      w('alerts', 5, 5, 4, 2),
      w('notes', 5, 7, 4, 2, { name: 'producer', title: 'Producer notes' }),
      w('mics', 0, 9, 9, 3, { layout: 'strip' }),
    ]),
    board('Video Director', [
      w('video', 0, 0, 6, 6, { source: pgm, switcher: sw }),
      w('video', 6, 0, 6, 6, { source: mv }),
      w('switcher-overview', 0, 6, 5, 6, { switcher: sw }),
      w('tally', 5, 6, 4, 3, { switcher: sw }),
      w('current-item', 9, 6, 3, 3),
      w('propresenter', 5, 9, 4, 3, { pp, showStatus: false }),
      w('alerts', 9, 9, 3, 3),
    ]),
    board('Audio & RF', [
      w('mics', 0, 0, 8, 7, { layout: 'cards' }),
      w('rf-plot', 8, 0, 4, 4),
      w('alerts', 8, 4, 4, 3),
      w('rf-table', 0, 7, 8, 5),
      w('checklist', 8, 7, 4, 5, { name: 'audio', title: 'Audio checklist' }),
    ]),
    board('Green Room TV', [
      w('mics', 0, 0, 8, 12, { layout: 'cards', assignedOnly: true }),
      w('clock', 8, 0, 4, 2),
      w('current-item', 8, 2, 4, 4),
      w('plan', 8, 6, 4, 6, { compact: true }),
    ]),
  ];
}
