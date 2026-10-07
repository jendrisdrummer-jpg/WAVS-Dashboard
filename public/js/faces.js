// Finding faces in people's photos, so every card shape keeps the face in frame.
//
// Runs in the browser on the Service & People page (whoever adds photos), once per photo: new
// photos are measured as soon as they're uploaded, and older photos when the page is opened.
// The face finder (SSD MobileNet, via face-api) and its model are served by the dashboard
// computer, so nothing leaves it and no internet is needed. The result is saved with the person
// (see GreenroomStore.setFace); common.js uses it to place the photo in each shape.
import { api, toast } from './common.js';

// Results from an older finder are checked again once (1 = first version: no plain-JS retry).
export const FINDER_VERSION = 2;

let loading = null;
function faceApi() {
  loading ||= (async () => {
    const faceapi = await import('/vendor/face-api.esm.js');
    // The graphics card when there is one (fast); otherwise plain JavaScript (a few seconds a photo).
    if (!(await faceapi.tf.setBackend('webgl').catch(() => false))) await faceapi.tf.setBackend('cpu');
    await faceapi.tf.ready();
    await faceapi.nets.ssdMobilenetv1.loadFromUri('/vendor/face-models');
    return faceapi;
  })().catch((e) => { loading = null; throw Object.assign(new Error(`The face finder didn't start (${e.message})`), { finder: true }); });
  return loading;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't open the photo"));
    img.src = url;
  });
}

/**
 * Where the face is in a photo: { x, y, s, ar } (centre and height as fractions of the photo),
 * or { none: true, ar } when there isn't one. With several faces, the biggest clear one wins.
 */
export async function findFace(url) {
  const faceapi = await faceApi();
  const img = await loadImage(url);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const opts = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.45, maxResults: 10 });

  // Look at part of the photo (scaled to a size the finder likes) and return boxes in photo pixels.
  const look = async (sw, sh) => {
    const k = 900 / Math.max(sw, sh);
    const cv = document.createElement('canvas');
    cv.width = Math.round(sw * k);
    cv.height = Math.round(sh * k);
    cv.getContext('2d').drawImage(img, 0, 0, sw, sh, 0, 0, cv.width, cv.height);
    const found = await faceapi.detectAllFaces(cv, opts);
    return found.map((d) => ({ x: d.box.x / k, y: d.box.y / k, w: d.box.width / k, h: d.box.height / k, score: d.score }));
  };
  const search = async () => {
    let faces = await look(W, H);
    // Full-length photos: the face is small, so look again at the top half, enlarged.
    if (!faces.length && H > W * 0.9) faces = await look(W, H * 0.55);
    return faces;
  };

  let faces = await search();
  // Some browsers' graphics modes (Safari in particular) can quietly find nothing; try again
  // without the graphics card before deciding there's no face.
  if (!faces.length && faceapi.tf.getBackend() !== 'cpu') {
    const was = faceapi.tf.getBackend();
    await faceapi.tf.setBackend('cpu');
    try { faces = await search(); } finally { if (!faces.length) await faceapi.tf.setBackend(was); }
    if (faces.length) console.info('[faces] the graphics card found nothing; using plain JavaScript from now on');
  }
  if (!faces.length) return { none: true, ar: W / H, v: FINDER_VERSION };
  const best = faces.sort((a, b) => b.w * b.h * b.score - a.w * a.h * a.score)[0];
  return { x: (best.x + best.w / 2) / W, y: (best.y + best.h / 2) / H, s: Math.min(1, best.h / H), ar: W / H, v: FINDER_VERSION };
}

/** Does this person's photo still need (re)checking? Hand-set positions never do. */
export function needsFace(p) {
  if (!p.photo) return false;
  const f = p.face;
  if (!f || f.photo !== p.photo) return true;
  return f.by !== 'manual' && (f.v || 1) < FINDER_VERSION;
}

/** Counts for the status line on the People panel. */
export function faceSummary(people) {
  const withPhoto = people.filter((p) => p.photo);
  const ok = (p) => p.face?.photo === p.photo;
  return {
    photos: withPhoto.length,
    found: withPhoto.filter((p) => ok(p) && !p.face.none).length,
    none: withPhoto.filter((p) => ok(p) && p.face.none).map((p) => p.name),
  };
}

export const scan = { busy: false, done: 0, total: 0, error: null };
const tried = new Set(); // person:photo already measured this visit (or failed)

/**
 * Measure every photo that needs it (new uploads, photos added before this existed, results from
 * an older finder). force: check every photo again, except hand-set ones. onChange: redraw status.
 */
export async function scanFaces(people, { force = false, onChange = () => {} } = {}) {
  if (scan.busy) return;
  if (force) tried.clear();
  const todo = people.filter((p) => (force ? p.photo && p.face?.by !== 'manual' : needsFace(p)) && !tried.has(`${p.id}:${p.photo}`));
  if (!todo.length) return;
  Object.assign(scan, { busy: true, done: 0, total: todo.length, error: null });
  onChange();
  try {
    for (const p of todo) {
      tried.add(`${p.id}:${p.photo}`);
      try {
        const face = await findFace(`/uploads/${encodeURIComponent(p.photo)}`);
        await api('PUT', `/api/people/${p.id}/face`, { photo: p.photo, face });
      } catch (e) {
        console.warn(`[faces] ${p.name}: ${e.message}`);
        if (e.finder) { scan.error = e.message; toast(e.message, true); break; }
      }
      scan.done++;
      onChange();
    }
  } finally {
    scan.busy = false;
    onChange();
  }
}
