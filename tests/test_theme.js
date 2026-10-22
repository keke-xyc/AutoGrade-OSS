// Exercise the actual early theme script without a browser or external requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../static/theme.js'), 'utf8');

function boot(saved = null, dark = false, blocked = false) {
  const events = {}, metas = {'theme-color': {}, 'color-scheme': {}};
  const root = {dataset: {}}, controls = [];
  const media = {matches: dark, addEventListener: (_, fn) => { events.system = fn; }};
  const storage = {
    value: saved,
    getItem() { if (blocked) throw Error('Storage unavailable'); return this.value; },
    setItem(_, value) { if (blocked) throw Error('Storage unavailable'); this.value = value; },
    removeItem() { if (blocked) throw Error('Storage unavailable'); this.value = null; }
  };
  vm.runInNewContext(source, {
    window: {matchMedia: () => media, addEventListener: (name, fn) => { events[name] = fn; }},
    localStorage: storage,
    document: {
      documentElement: root,
      querySelector: selector => metas[selector.match(/name="([^"]+)"/)[1]],
      querySelectorAll: selector => selector.endsWith('[open]') ? controls.filter(control => control.open) : controls,
      addEventListener: (name, fn) => { events[name] = fn; }
    }
  });
  const beforeLoad = root.dataset.theme;
  controls.push(...[0, 1].map(() => {
    const summary = {attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, focus() { this.focused = true; }};
    const icon = {setAttribute(name, value) { this[name] = value; }};
    const buttons = ['system', 'light', 'dark'].map(value => ({
      dataset: {themeChoice: value}, attrs: {},
      setAttribute(name, value) { this.attrs[name] = value; }
    }));
    return {open: false, summary, icon, buttons,
      querySelector: selector => selector === 'summary' ? summary : icon,
      querySelectorAll: () => buttons
    };
  }));
  events.DOMContentLoaded();
  return {root, metas, storage, controls, beforeLoad,
    choose(value) { events.click({target: {closest: selector => selector === '[data-theme-control]' ? controls[0] : controls[0].buttons.find(button => button.dataset.themeChoice === value)}}); },
    outside() { events.click({target: {closest: () => null}}); },
    escape() { events.keydown({key: 'Escape'}); },
    system(dark) { media.matches = dark; events.system(); },
    sync(value, key = 'autograde-theme') { events.storage({key, newValue: value}); }
  };
}

const automatic = boot(null, true);
assert.equal(automatic.beforeLoad, 'dark', 'theme must apply before controls exist');
assert.equal(automatic.controls[1].icon.href, '#theme-system');
automatic.system(false);
assert.equal(automatic.root.dataset.theme, 'light');
automatic.choose('dark');
assert.equal(automatic.root.dataset.theme, 'dark', 'manual dark works on a light system');
assert.equal(automatic.storage.value, 'dark');
assert.equal(automatic.controls[1].icon.href, '#theme-dark', 'login and workspace controls stay in sync');
assert.equal(automatic.controls[1].summary.attrs['aria-label'], '外观主题：深色');
assert.deepEqual(automatic.controls[1].buttons.map(button => button.attrs['aria-pressed']), ['false', 'false', 'true']);
assert.equal(automatic.metas['theme-color'].content, '#131b18');
automatic.system(true);
automatic.choose('light');
assert.equal(automatic.root.dataset.theme, 'light', 'manual light works on a dark system');
automatic.system(false);
automatic.system(true);
assert.equal(automatic.root.dataset.theme, 'light', 'system changes cannot override a manual choice');
assert.equal(boot(automatic.storage.value, true).beforeLoad, 'light', 'saved choice is restored before first paint');
automatic.choose('system');
assert.equal(automatic.root.dataset.theme, 'dark');
assert.equal(automatic.storage.value, null);
automatic.system(false);
assert.equal(automatic.root.dataset.theme, 'light');
assert.equal(automatic.metas['color-scheme'].content, 'light');
automatic.sync('dark');
assert.equal(automatic.controls[1].icon.href, '#theme-dark');
automatic.sync('light', 'unrelated-key');
assert.equal(automatic.root.dataset.theme, 'dark');
automatic.sync(null, null);
assert.equal(automatic.controls[1].icon.href, '#theme-system', 'clearing storage restores the system preference');
automatic.controls[0].open = true;
automatic.choose('dark');
assert.equal(automatic.controls[0].open, false, 'choosing a theme closes the popup');
assert.equal(automatic.controls[0].summary.focused, true, 'focus returns to the icon button');
automatic.controls[0].open = true;
automatic.outside();
assert.equal(automatic.controls[0].open, false, 'outside click dismisses the popup');
automatic.controls[1].open = true;
automatic.escape();
assert.equal(automatic.controls[1].open, false, 'Escape dismisses the popup');
assert.equal(automatic.controls[1].summary.focused, true);
assert.equal(boot('invalid', true).beforeLoad, 'dark');
const unavailable = boot('light', true, true);
assert.equal(unavailable.beforeLoad, 'dark');
unavailable.choose('light');
assert.equal(unavailable.root.dataset.theme, 'light', 'blocked storage must not prevent switching');
console.log('Theme choices, early restoration, system changes, cross-tab sync and blocked storage: OK');
