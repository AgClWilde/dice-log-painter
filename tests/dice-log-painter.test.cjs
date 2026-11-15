'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function loadPlugin() {
  const notices = [];
  const errors = [];
  const modals = [];
  class TFile {
    constructor(filePath) {
      this.path = filePath;
      this.name = filePath.split('/').at(-1);
      this.extension = this.name.split('.').at(-1);
    }
  }
  class TFolder {
    constructor(folderPath, children = []) {
      this.path = folderPath;
      this.children = children;
    }
  }
  class Modal {
    constructor() {
      this.contentEl = { empty() {} };
    }
    open() { modals.push(this); }
    close() { this.onClose(); }
  }
  const context = {
    module: { exports: {} },
    console: { error: (...args) => errors.push(args) },
    require(name) {
      assert.equal(name, 'obsidian');
      return {
        Plugin: class {}, TFile, TFolder, Modal,
        Notice: class { constructor(message) { notices.push(message); } },
        FuzzySuggestModal: class {},
        normalizePath: (value) => value.replace(/\/{2,}/g, '/'),
      };
    },
  };
  vm.runInNewContext(source, context, { filename: 'dice-log-painter/main.js' });
  return { Plugin: context.module.exports, ...context.module.exports.__test,
    notices, errors, modals, TFile, TFolder };
}

function fixtureVault(api, entries) {
  const files = new Map();
  const bodies = new Map();
  const root = new api.TFolder('');
  files.set('', root);
  for (const [filePath, body] of Object.entries(entries)) {
    const folderPath = filePath.split('/').slice(0, -1).join('/');
    let folder = files.get(folderPath);
    if (!folder) {
      folder = new api.TFolder(folderPath);
      files.set(folderPath, folder);
      root.children.push(folder);
    }
    const file = new api.TFile(filePath);
    file.parent = folder;
    files.set(filePath, file);
    bodies.set(filePath, body);
    folder.children.push(file);
  }
  return {
    files, bodies,
    getAbstractFileByPath: (filePath) => files.get(filePath),
    read: async (file) => bodies.get(file.path),
    create: async (filePath, body) => {
      assert.ok(!files.has(filePath), 'create must not overwrite');
      const file = new api.TFile(filePath);
      files.set(filePath, file);
      bodies.set(filePath, body);
      return file;
    },
    modify: async (file, body) => { bodies.set(file.path, body); },
  };
}

// All messages, IDs, names and paths below are synthetic test fixtures.
test('headers accept numeric and platform-prefixed IDs, dates and CRLF', () => {
  const api = loadPlugin();
  const blocks = api.parseBlocks([
    'ignored preamble', '演员甲(10001) 2026/01/02 03:04:05', '第一句', '',
    '演员乙(QQ:10002) 2026-01-02 03:04:06', '第二句', '',
    '演员丙(Discord:fixture-c) 03:04:07', '第三句', '',
  ].join('\r\n'));
  assert.deepEqual(JSON.parse(JSON.stringify(blocks)), [
    { name: '演员甲', body: ['第一句'] }, { name: '演员乙', body: ['第二句'] },
    { name: '演员丙', body: ['第三句'] },
  ]);
  assert.ok(!JSON.stringify(blocks).includes('10001'));
});

test('out-of-character and command messages are removed after CQ cleanup', () => {
  const api = loadPlugin();
  const removed = ['（场外）', '(aside)', '（未闭合', '(unfinished', '.roll', '。命令', '/help',
    '[CQ:reply,id=fixture]（场外）', '@fixture （场外）', '[图片]'];
  for (const body of removed) {
    assert.equal(api.renderBody([{ name: '演员甲', body: [body] }], {}), '', body);
  }
  assert.match(api.renderBody([{ name: '演员甲', body: ['（低声）继续前进。'] }], {}), /继续前进/);
  assert.match(api.renderBody([{ name: '演员甲', body: ['正文（旁注）仍在。'] }], {}), /旁注/);
});

test('colors use dice, KP, manual, then stable generated precedence', () => {
  const api = loadPlugin();
  const render = (name, body, map = {}) => api.renderBody([{ name, body: [body] }], map);
  assert.match(render('KP', 'D100=31', { KP: { name: '主持人', color: '#aabbcc' } }), /color:#888888/);
  assert.match(render('KP', '正文', { KP: { name: '主持人', color: '#aabbcc' } }), /color:#000000/);
  assert.match(render('演员甲', '正文', { 演员甲: { name: '角色甲', color: '#abc' } }), /color:#abc/);
  const color = api.hashColor('角色甲');
  assert.match(render('演员甲', '正文', { 演员甲: { name: '角色甲', color: '' } }), new RegExp(color));
  assert.match(render('演员乙', '正文', { 演员乙: { name: '角色甲', color: '' } }), new RegExp(color));
});

test('adjacent messages merge only when final name and color match', () => {
  const api = loadPlugin();
  const body = api.renderBody([
    { name: '演员甲', body: ['第一句'] }, { name: '演员甲', body: ['第二句'] },
    { name: '演员甲', body: ['D100=31'] }, { name: '演员甲', body: ['第三句'] },
  ], {});
  assert.equal((body.match(/<span /g) || []).length, 3);
  assert.match(body, /第一句<br><br>第二句/);
});

test('HTML and Markdown link syntax in log text stay inert', () => {
  const api = loadPlugin();
  const body = api.renderBody([{ name: '<script>fixture</script>', body: [
    '<img src="https://example.invalid/image"> & ![image](https://example.invalid/image)',
  ] }], {});
  assert.ok(!body.includes('<script>'));
  assert.ok(!body.includes('<img'));
  assert.ok(!body.includes('![image]'));
  assert.match(body, /&lt;img/);
  assert.match(body, /&amp;/);
});

test('invalid mapping colors cannot inject HTML or CSS', () => {
  const api = loadPlugin();
  for (const color of ['red', '#1234', '#12345678', '#fff" onclick="fixture', 'url(https://example.invalid)']) {
    assert.equal(api.validColor(color), false);
    const body = api.renderBody([{ name: '演员甲', body: ['正文'] }], { 演员甲: { name: '', color } });
    assert.ok(!body.includes(color), color);
    assert.match(body, new RegExp(api.hashColor('演员甲')));
  }
});

test('mapping handles prototype-like keys as ordinary speaker names', () => {
  const api = loadPlugin();
  const map = api.parseMapping('| 昵称 | 名字 | 颜色 |\n|---|---|---|\n| __proto__ | 角色甲 | #123456 |\n| toString | 角色乙 | |');
  assert.equal(Object.getPrototypeOf(map), null);
  assert.equal(map.__proto__.name, '角色甲');
  assert.equal(map.toString.name, '角色乙');
  assert.match(api.renderBody([{ name: '__proto__', body: ['正文'] }], map), /角色甲/);
  assert.match(api.renderBody([{ name: 'constructor', body: ['正文'] }], {}), /constructor：正文/);
});

test('generated table cells round-trip pipes, backslashes, markup and entities', () => {
  const api = loadPlugin();
  for (const nick of ['演员|甲', '演员\\甲', '<b>演员</b>', '*演员*_[甲]', '&amp; &#124;', '`角色`~']) {
    const map = api.parseMapping(`| ${api.encodeCell(nick)} | ${api.encodeCell(nick)} | #abc |`);
    assert.equal(map[nick].name, nick);
    assert.equal(map[nick].color, '#abc');
  }
  const map = api.parseMapping('| 演员\\|甲 | 角色\\|甲 | #AABBCC |');
  assert.equal(map['演员|甲'].name, '角色|甲');
});

test('Markdown records only an escaped source filename and generates a usable mapping', async () => {
  const api = loadPlugin();
  const filePath = 'private-fixture-folder/a"b.txt';
  const vault = fixtureVault(api, { [filePath]: '演员|甲(QQ:10001) 00:00:00\n正文\n' });
  const plugin = new api.Plugin();
  plugin.app = { vault };
  const md = await plugin.buildMarkdown(vault.files.get(filePath));
  assert.ok(!md.includes('private-fixture-folder'));
  assert.equal(JSON.parse(md.split('\n')[1].slice('source: '.length)), 'a"b.txt');
  assert.ok(!md.includes('10001'));
  const mapping = api.parseMapping(vault.bodies.get('private-fixture-folder/染色映射.md'));
  assert.ok(Object.hasOwn(mapping, '演员|甲'));
});

test('unrecognized text does not create mapping or output files', async () => {
  const api = loadPlugin();
  const vault = fixtureVault(api, { 'fixture.txt': 'plain fixture text' });
  const plugin = new api.Plugin();
  plugin.app = { vault };
  assert.equal(await plugin.buildMarkdown(vault.files.get('fixture.txt')), null);
  assert.equal(vault.bodies.size, 1);
});

test('existing Markdown requires confirmation and cancellation preserves content', async () => {
  const api = loadPlugin();
  const vault = fixtureVault(api, { 'fixture.txt': '演员甲(10001) 00:00:00\n正文', 'fixture.md': 'keep me' });
  const plugin = new api.Plugin();
  plugin.app = { vault, workspace: { getLeaf() { throw new Error('must not open on cancel'); } } };
  await plugin.renderFile(vault.files.get('fixture.txt'));
  assert.equal(vault.bodies.get('fixture.md'), 'keep me');
  api.modals[0].respond(false);
  await new Promise(setImmediate);
  assert.equal(vault.bodies.get('fixture.md'), 'keep me');
});

test('confirmed asynchronous write errors become notices without an unhandled rejection', async () => {
  const api = loadPlugin();
  const vault = fixtureVault(api, { 'fixture.txt': '演员甲(10001) 00:00:00\n正文', 'fixture.md': 'keep me' });
  vault.modify = async () => { throw new Error('fixture write error'); };
  const plugin = new api.Plugin();
  plugin.app = { vault };
  await plugin.renderFile(vault.files.get('fixture.txt'));
  api.modals[0].respond(true);
  api.modals[0].respond(true);
  await new Promise(setImmediate);
  assert.equal(api.errors.length, 1);
  assert.ok(api.notices.some((notice) => notice.includes('fixture write error')));
});

test('closing a confirmation without a button is cancellation', async () => {
  const api = loadPlugin();
  const decisions = [];
  const modal = new api.ConfirmModal({}, 'fixture', (decision) => decisions.push(decision));
  modal.close();
  await new Promise(setImmediate);
  assert.deepEqual(decisions, [false]);
});

test('batch rendering recurses and continues after a failed file', async () => {
  const api = loadPlugin();
  const good = new api.TFile('fixture/good.txt');
  const bad = new api.TFile('fixture/nested/bad.txt');
  const skip = new api.TFile('fixture/nested/skip.txt');
  const folder = new api.TFolder('fixture', [good, new api.TFolder('fixture/nested', [bad, skip])]);
  const plugin = new api.Plugin();
  plugin.app = {};
  const written = [];
  plugin.buildMarkdown = async (file) => {
    if (file === bad) throw new Error('fixture failure');
    return file === skip ? null : 'rendered fixture';
  };
  plugin.writeMd = async (file, md) => { written.push([file.path, md]); };
  await plugin.renderFolder(folder);
  api.modals[0].respond(true);
  await new Promise(setImmediate);
  assert.deepEqual(written, [['fixture/good.txt', 'rendered fixture']]);
  assert.ok(api.notices.includes('批量染色完成：成功 1，跳过 1，失败 1'));
});
