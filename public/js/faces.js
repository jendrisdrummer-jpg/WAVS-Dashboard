// Finding faces in people's photos, so every card shape keeps the face in frame.
//
// Runs in the browser on the Setup page (whoever adds photos), once per photo: new photos are
// measured as soon as they're uploaded, and older photos the first time Setup is opened. The
// face finder (SSD MobileNet, via face-api) and its model are served by the dashboard computer,
// so nothing leaves it and no internet is needed. The result is saved with the person
// (see GreenroomStore.setFace); common.js uses it to place the photo in each shape.
import { api, toast } from './common.js';

let loading = null;
function faceApi() {
  loading ||= (async () => {
    const faceapi = await import('/vendor/face-api.esm.js');
    // The graphics card when there is one (fast); otherwise plain JavaScript (a few seconds a photo).
    if (!(await faceapi.tf.setBackend('webgl').catch(() => false))) await faceapi.tf.setBackend('cpu');
    await faceapi.tf.ready();
    await faceapi.nets.ssdMobilenetv1.loadFromUri('/vendor/face-models');
    return faceapi;
  })().catch((e) => { loading = null; throw e; });
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

  let faces = await look(W, H);
  // Full-length photos: the face is small, so look again at the top half, enlarged.
  if (!faces.length && H > W * 0.9) faces = await look(W, H * 0.55);
  if (!faces.length) return { none: true, ar: W / H };
  const best = faces.sort((a, b) => b.w * b.h * b.score - a.w * a.h * a.score)[0];
  return { x: (best.x + best.w / 2) / W, y: (best.y + best.h / 2) / H, s: Math.min(1, best.h / H), ar: W / H };
}

const tried = new Set(); // person:photo already measured this visit (or failed)
let busy = false;

/** Measure every photo that hasn't been yet (new uploads and photos added before this existed). */
export async function scanFaces(people) {
  if (busy) return;
  const todo = people.filter((p) => p.photo && p.face?.photo !== p.photo && !tried.has(`${p.id}:${p.photo}`));
  if (!todo.length) return;
  busy = true;
  let done = 0;
  let note = null;
  if (todo.length > 2) note = setTimeout(() => toast(`Finding faces in ${todo.length} photos…`), 400);
  try {
    for (const p of todo) {
      tried.add(`${p.id}:${p.photo}`);
      try {
        const face = await findFace(`/uploads/${encodeURIComponent(p.photo)}`);
        await api('PUT', `/api/people/${p.id}/face`, { photo: p.photo, face });
        done++;
      } catch (e) {
        console.warn(`[faces] ${p.name}: ${e.message}`);
        if (/face-api|Failed to fetch dynamically|model/i.test(e.message)) break; // the finder itself didn't load
      }
    }
  } finally {
    clearTimeout(note);
    busy = false;
  }
  if (todo.length > 2 && done) toast(`Checked ${done} photo${done === 1 ? '' : 's'}: they now crop around each face.`);
  // Photos added meanwhile are picked up on the next update (saving a face sends one).
}
