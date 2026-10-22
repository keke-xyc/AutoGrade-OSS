// Exercise the actual password controls without a browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function element() {
  return {dataset: {}, attrs: {}, events: {}, children: [],
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name]; },
    addEventListener(name, callback) { (this.events[name] ??= []).push(callback); },
    append(child) { this.children.push(child); }
  };
}
const form = element();
const inputs = ['当前密码', '新密码'].map((label, index) => Object.assign(element(), {
  id: 'password-' + index, type: 'password', form, labels: [{textContent: label}],
  value: 'Long password with spaces!123', selectionStart: 5, selectionEnd: 9,
  before(wrapper) { this.wrapper = wrapper; },
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}));
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/password-visibility.js'), 'utf8'), {
  document: {querySelectorAll: () => inputs, createElement: element}, requestAnimationFrame: callback => callback()
});
const buttons = inputs.map(input => input.wrapper.children[1]);
inputs.forEach((input, index) => {
  assert.equal(input.wrapper.children[0], input, 'keep the original field for labels, validation and autofill');
  assert.equal(input.type, 'password');
  assert.equal(buttons[index].type, 'button', 'the eye must never submit a form');
  assert.equal(buttons[index].getAttribute('aria-controls'), input.id);
  assert.equal(buttons[index].getAttribute('aria-label'), '显示' + input.labels[0].textContent);
  assert.equal(input.spellcheck, false);
  assert.equal(input.getAttribute('autocapitalize'), 'none');
  assert.equal(input.getAttribute('autocorrect'), 'off');
});
let prevented = false;
buttons[0].events.pointerdown[0]({preventDefault() { prevented = true; }});
assert.equal(prevented, true);
buttons[0].events.click[0]();
assert.equal(inputs[0].type, 'text');
assert.equal(inputs[1].type, 'password', 'each eye controls only its own field');
assert.equal(buttons[0].getAttribute('aria-label'), '隐藏当前密码');
assert.equal(buttons[0].dataset.visible, 'true');
assert.equal(inputs[0].value, 'Long password with spaces!123');
assert.deepEqual([inputs[0].selectionStart, inputs[0].selectionEnd], [5, 9]);
buttons[0].events.click[0]();
assert.equal(inputs[0].type, 'password');
for (const event of ['submit', 'reset']) {
  buttons.forEach(button => button.events.click[0]());
  form.events[event].forEach(callback => callback());
  inputs.forEach(input => assert.equal(input.type, 'password', event + ' must restore masking'));
  buttons.forEach(button => assert.equal(button.dataset.visible, 'false'));
}
console.log('Password visibility, independent fields, labels, selection, submit and reset masking: OK');
