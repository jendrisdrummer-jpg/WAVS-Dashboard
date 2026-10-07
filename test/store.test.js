import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GreenroomStore } from '../server/store.js';

test('people: face positions follow the photo, and a hand-set one is kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-store-'));
  try {
    const st = new GreenroomStore(dir);
    const p = st.addPerson({ name: 'Ana', photo: 'a.jpg' });
    const auto = { x: 0.5, y: 0.2, s: 0.1, ar: 0.75 };

    st.setFace(p.id, { photo: 'old.jpg', face: auto }); // measured a photo that was since replaced
    assert.equal(st.person(p.id).face, undefined);

    st.setFace(p.id, { photo: 'a.jpg', face: auto });
    assert.deepEqual(st.person(p.id).face, { photo: 'a.jpg', ...auto, by: 'auto' });
    st.setFace(p.id, { photo: 'a.jpg', face: { ...auto, v: 2 } }); // keeps which finder measured it
    assert.equal(st.person(p.id).face.v, 2);

    st.setFace(p.id, { photo: 'a.jpg', face: { x: 0.4, y: 0.3, s: 0.2, ar: 0.75 }, manual: true });
    st.setFace(p.id, { photo: 'a.jpg', face: auto }); // an automatic pass doesn't undo a hand-set one
    assert.equal(st.person(p.id).face.by, 'manual');
    assert.equal(st.person(p.id).face.x, 0.4);

    assert.throws(() => st.setFace(p.id, { photo: 'a.jpg', face: { x: 2, y: 0, s: 0.1, ar: 1 }, manual: true }), /out of range/);

    st.setFace(p.id, { photo: 'a.jpg', face: { none: true, ar: 1 }, manual: true });
    assert.deepEqual(st.person(p.id).face, { photo: 'a.jpg', none: true, ar: 1, by: 'manual' });

    st.updatePerson(p.id, { photo: 'b.jpg' }); // new photo: measure again
    assert.equal(st.person(p.id).face, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
