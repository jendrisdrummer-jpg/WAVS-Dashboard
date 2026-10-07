// First-run setup wizard for a new organization: name & colour, gear, Planning Center, done.
import { start, store, esc, api, toast, icon } from './common.js';
import { deviceForm, enhanceForm, readForm, runTest } from './forms.js';

await start({ page: 'welcome' });
if (store.config.setupComplete && !new URLSearchParams(location.search).has('again')) location.replace('/');

const s = await api('GET', '/api/settings');
const draft = {
  org: { ...s.org },
  receivers: [...s.mics.receivers],
  switchers: [...s.switchers],
  propresenter: [...s.propresenter],
  planningCenter: s.planningCenter,
};
const STEPS = ['Your organization', 'Your gear', 'Planning Center', 'All set'];
const COLORS = ['#3b82f6', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#d97706', '#16a34a', '#0891b2', '#475569'];
const card = document.getElementById('card');
let step = 0;

function drawSteps() {
  document.getElementById('steps').innerHTML = STEPS.map((t, i) => `<li class="${i < step ? 'done' : i === step ? 'cur' : ''}"><span>${i < step ? icon('check') : i + 1}</span>${t}</li>`).join('');
}

const nav = (back = true, next = 'Next') => `<div class="wiz-nav">${back ? '<button class="btn" type="button" data-back>Back</button>' : '<span></span>'}<button class="btn primary big" type="submit">${next}</button></div>`;

function stepOrg() {
  card.innerHTML = `<form class="form">
    <h1>Welcome to your production dashboard</h1>
    <p class="muted">Let's set it up for your team. It takes about two minutes, and you can change everything later in Settings.</p>
    <p class="muted small">Moving from another computer? <a href="/settings#move">Import its backup</a> instead.</p>
    <label class="f"><span>Organization name</span><input type="text" name="name" required maxlength="60" value="${esc(draft.org.name)}" placeholder="e.g. Grace Church or Acme Productions"></label>
    <div class="f"><span>Colour</span><div class="swatches">${COLORS.map((c) => `<button type="button" class="swatch-btn ${c === draft.org.theme.accent ? 'on' : ''}" style="background:${c}" data-c="${c}" aria-label="${c}"></button>`).join('')}</div></div>
    <label class="f"><span>Usual service or event name (optional)</span><input type="text" name="serviceName" maxlength="80" value="${esc(draft.org.serviceName || '')}" placeholder="Sunday 9:00"></label>
    ${nav(false)}</form>`;
  const form = card.querySelector('form');
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    draft.org.theme = { ...draft.org.theme, accent: b.dataset.c };
    document.documentElement.style.setProperty('--accent', b.dataset.c);
    form.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('on', x === b));
  });
  form.onsubmit = (e) => {
    e.preventDefault();
    draft.org.name = form.elements.name.value.trim();
    draft.org.serviceName = form.elements.serviceName.value.trim();
    go(1);
  };
}

function stepGear() {
  const groups = [['receiver', 'Wireless receivers', 'receivers'], ['switcher', 'Switcher', 'switchers'], ['propresenter', 'ProPresenter', 'propresenter']];
  card.innerHTML = `<form class="form">
    <h1>Your gear</h1>
    <p class="muted">Add the equipment this organization uses. Use <b>Test</b> to check each one connects. You can skip any of them and add them later on the <b>Gear</b> page.</p>
    <div class="wiz-gear">${groups.map(([kind, title, key]) => `
      <div class="wiz-group"><h3>${title}</h3>
        <div class="wiz-items">${draft[key].map((d, i) => `<div class="chip good">${icon('check')} ${esc(d.name)} <span class="muted">${esc(d.type === 'simulator' ? 'simulated' : d.host || '')}</span>
          <button type="button" class="link" data-rm="${key}" data-i="${i}" aria-label="Remove">${icon('x')}</button></div>`).join('') || '<span class="muted small">None yet</span>'}</div>
        <button type="button" class="btn small" data-add="${kind}" data-key="${key}">${icon('plus')} Add ${title.toLowerCase().replace(/s$/, '')}</button>
      </div>`).join('')}</div>
    <div class="wiz-sim"><button type="button" class="btn" data-sim>Just exploring? Add simulated gear</button></div>
    <div class="wiz-add hidden"><div class="wiz-addfields"></div><div class="test-result" aria-live="polite"></div>
      <div class="row-btns"><button type="button" class="btn" data-test>Test connection</button><button type="button" class="btn primary" data-keep>Add</button><button type="button" class="btn" data-cancel>Cancel</button></div></div>
    ${nav()}</form>`;
  const form = card.querySelector('form');
  const addBox = form.querySelector('.wiz-add');
  const addFields = form.querySelector('.wiz-addfields');
  let adding = null;
  form.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.add) {
      adding = { kind: t.dataset.add, key: t.dataset.key };
      addFields.innerHTML = deviceForm(adding.kind, {}, {});
      enhanceForm(adding.kind, addFields);
      addBox.querySelector('.test-result').textContent = '';
      addBox.classList.remove('hidden');
      addBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (t.hasAttribute('data-test')) runTest(adding.kind, readForm(adding.kind, addFields), addBox.querySelector('.test-result'));
    if (t.hasAttribute('data-keep')) {
      const d = readForm(adding.kind, addFields);
      if (!d.name) return toast('Give it a name', true);
      draft[adding.key].push(d);
      stepGear();
    }
    if (t.hasAttribute('data-cancel')) { addBox.classList.add('hidden'); addFields.innerHTML = ''; }
    if (t.dataset.rm) { draft[t.dataset.rm].splice(Number(t.dataset.i), 1); stepGear(); }
    if (t.hasAttribute('data-sim')) {
      draft.receivers.push({ name: 'Simulated rack', type: 'simulator', channels: [{ label: 'HH 1', kind: 'handheld' }, { label: 'HH 2', kind: 'handheld' }, { label: 'Pastor HS', kind: 'headset' }, { label: 'Lav 1', kind: 'lav' }] });
      draft.switchers.push({ name: 'Simulated ATEM', type: 'simulator' });
      draft.propresenter.push({ name: 'Simulated ProPresenter', type: 'simulator' });
      stepGear();
    }
    if (t.hasAttribute('data-back')) go(0);
  });
  form.onsubmit = (e) => { e.preventDefault(); go(2); };
}

function stepPco() {
  card.innerHTML = `<form class="form">
    <h1>Planning Center (optional)</h1>
    <p class="muted">Connect Planning Center Services to pull your order of service automatically. Using Faith Teams or a printed run sheet? Skip this. You can type or paste plans on the <b>Service &amp; People</b> page.</p>
    <div class="pco-fields">${deviceForm('planningCenter', draft.planningCenter || {})}</div>
    <div class="test-result"></div>
    <div class="row-btns"><button class="btn" type="button" data-test>Test connection</button></div>
    ${nav(true, 'Finish setup')}</form>`;
  const form = card.querySelector('form');
  const fields = form.querySelector('.pco-fields');
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-test]')) runTest('planningCenter', readForm('planningCenter', fields), form.querySelector('.test-result'));
    if (e.target.closest('[data-back]')) go(1);
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const pco = readForm('planningCenter', fields);
    draft.planningCenter = pco.appId && pco.secret ? pco : null;
    await finish();
  };
}

async function finish() {
  store.holdReload = true; // stay on the wizard for the "All set" step
  try {
    await api('PUT', '/api/settings', {
      org: draft.org,
      mics: { receivers: draft.receivers },
      switchers: draft.switchers,
      propresenter: draft.propresenter,
      planningCenter: draft.planningCenter,
      setupComplete: true,
    });
    go(3);
  } catch (err) { toast(err.message, true); }
}

function stepDone() {
  card.innerHTML = `<div class="form wiz-done">
    <h1>${icon('check', 'ic big-check')} ${esc(draft.org.name)} is ready</h1>
    <p class="muted">Next steps:</p>
    <ul class="next-steps">
      <li><b>Gear</b>: check everything shows Connected.</li>
      <li><b>Service &amp; People</b>: add your team with photos and assign mics.</li>
      <li><b>Dashboards</b>: pick a starter dashboard, or press <b>Edit</b> to build your own.</li>
      <li>Run events for another organization too? Use the organization menu at the top left to add or switch.</li>
    </ul>
    <div class="wiz-nav"><span></span><a class="btn primary big" href="/">Go to Home</a></div></div>`;
}

function go(n) {
  step = n;
  drawSteps();
  [stepOrg, stepGear, stepPco, stepDone][n]();
  window.scrollTo(0, 0);
}
go(0);
