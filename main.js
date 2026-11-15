'use strict';

// Dice Log Painter 1.1.0 — Copyright (c) 2026 _yeaz_
// SPDX-License-Identifier: MIT

const { Plugin, TFile, TFolder, Modal, Notice, FuzzySuggestModal, normalizePath } = require('obsidian');

/* ==== 可调常量 ==== */
const MAP_FILENAME = '染色映射.md';
const KP_NAMES = ['GM', 'KP', '主持人', '守密人', '守秘人']; // 固定黑
const KP_COLOR = '#000000';   // KP/GM 固定黑
const DICE_COLOR = '#888888'; // 骰子/系统回显 固定灰
const COLOR_S = 65;           // 自动软色板 饱和度
const COLOR_L = 50;           // 自动软色板 亮度

/* 发言头：昵称(平台用户 ID) [YYYY/MM/DD 或 YYYY-MM-DD ]HH:MM:SS（日期可省略） */
const HEADER_RE = /^(.*)\(([^()\s]+)\)\s+((?:(?:\d{4}\/\d{1,2}\/\d{1,2}|\d{4}-\d{1,2}-\d{1,2})\s+)?\d{1,2}:\d{2}:\d{2})\s*$/;
/* 骰子/系统回显特征 */
const DICE_RE = /掷出了|[dD]\d{1,3}\s*=\s*\d|骰子[:：=]|【[^】]*先攻[^】]*】/;

/* ---------- 纯函数 ---------- */

function validColor(value) {
	return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

const CELL_ENTITIES = {
	'&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '\\': '&#92;',
	'`': '&#96;', '*': '&#42;', '_': '&#95;', '[': '&#91;', ']': '&#93;', '~': '&#126;'
};
const CELL_CHARACTERS = Object.fromEntries(Object.entries(CELL_ENTITIES).map(([key, value]) => [value, key]));

function encodeCell(value) {
	return value.replace(/[&<>|\\`*_\[\]~]/g, (char) => CELL_ENTITIES[char]);
}

function decodeCell(value) {
	return value.replace(/&(?:amp|lt|gt|#124|#92|#96|#42|#95|#91|#93|#126);/g,
		(entity) => CELL_CHARACTERS[entity]);
}

function splitTableRow(line) {
	const cells = [];
	let cell = '';
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '\\' && (line[i + 1] === '|' || line[i + 1] === '\\')) {
			cell += line[++i];
		} else if (char === '|') {
			cells.push(decodeCell(cell.trim()));
			cell = '';
		} else cell += char;
	}
	cells.push(decodeCell(cell.trim()));
	return cells;
}

function parseMapping(text) {
	const map = Object.create(null);
	for (const line of text.split('\n')) {
		if (!line.trim().startsWith('|')) continue;
		const [, nick = '', name = '', color = ''] = splitTableRow(line.trim());
		if (!nick || /^:?-+:?$/.test(nick)) continue;
		if (nick === '昵称' && name === '名字' && color === '颜色') continue;
		map[nick] = { name, color: validColor(color) ? color : '' };
	}
	return map;
}

function reportError(error) {
	console.error('[dice-log-painter]', error);
	new Notice('染色失败：' + (error && error.message ? error.message : error));
}

function parseBlocks(content) {
	const lines = content.replace(/\r\n?/g, '\n').split('\n');
	const blocks = [];
	let cur = null;
	for (const line of lines) {
		const m = line.match(HEADER_RE);
		if (m) {
			if (cur) blocks.push(cur);
			cur = { name: m[1].trim(), body: [] };
		} else if (cur) {
			cur.body.push(line);
		}
	}
	if (cur) blocks.push(cur);
	for (const b of blocks) {
		while (b.body.length && b.body[0].trim() === '') b.body.shift();
		while (b.body.length && b.body[b.body.length - 1].trim() === '') b.body.pop();
	}
	return blocks;
}

/* 整条纯场外 → 剔除；半场外(行内括号)保留 */
function isOOC(text) {
	const t = text.trim();
	if (!t) return true;
	const c0 = t[0];
	if (c0 === '.' || c0 === '。' || c0 === '/') return true;      // ③ 指令
	// ①② 以括号开头：未闭合 或 闭合在行尾 → 整条场外；闭合后还有正文 → 半场外保留
	if (c0 === '（') {
		const i = t.indexOf('）');
		return i === -1 || i === t.length - 1;
	}
	if (c0 === '(') {
		const i = t.indexOf(')');
		return i === -1 || i === t.length - 1;
	}
	return false;
}

function cleanLine(text) {
	let s = text;
	s = s.replace(/\[CQ:[^\]]*\]/g, '');
	s = s.replace(/\[图片\]/g, '');
	s = s.replace(/\[图:[^\]]*\]/g, '');
	s = s.replace(/\[表情[^\]]*\]/g, '');
	s = s.replace(/\[回复[^\]]*\]/g, '');
	s = s.replace(/@\S+/g, '');            // @提及（含 @QQ号> 残片）全删
	return s.replace(/\s+$/, '');
}

function esc(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/[\\`*_\[\]!]/g, (char) => '&#' + char.charCodeAt(0) + ';');
}

function hslToHex(h, s, l) {
	s /= 100; l /= 100;
	const k = (n) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n) => {
		const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
		return Math.round(255 * c);
	};
	const hex = (x) => x.toString(16).padStart(2, '0');
	return '#' + hex(f(0)) + hex(f(8)) + hex(f(4));
}

function hashColor(name) {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
	const hue = ((h % 360) + 360) % 360;
	return hslToHex(hue, COLOR_S, COLOR_L);
}

function pad2(n) { return String(n).padStart(2, '0'); }
function today() {
	const d = new Date();
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/* 把 blocks 渲染成 markdown 正文 */
function renderBody(blocks, map) {
	const processed = [];
	for (const blk of blocks) {
		const rawName = blk.name;
		// 先清理 CQ 码/@/图片，再判场外（否则 [CQ:reply]（场外）会漏删）
		const cleaned = blk.body.map(cleanLine);
		const cleanedText = cleaned.join('\n');
		if (isOOC(cleanedText)) continue;

		const mapped = Object.prototype.hasOwnProperty.call(map, rawName)
			? map[rawName] : { name: rawName, color: '' };
		const finalName = mapped.name || rawName;
		const isDice = DICE_RE.test(cleanedText);

		const escLines = [];
		for (const cl of cleaned) {
			escLines.push(cl.trim() === '' ? '' : esc(cl));
		}
		while (escLines.length && escLines[0] === '') escLines.shift();
		while (escLines.length && escLines[escLines.length - 1] === '') escLines.pop();
		if (!escLines.length) continue;

		let color;
		if (isDice) color = DICE_COLOR;
		else if (KP_NAMES.includes(finalName) || KP_NAMES.includes(rawName)) color = KP_COLOR;
		else if (validColor(mapped.color)) color = mapped.color;
		else color = hashColor(finalName);

		processed.push({ name: finalName, color, lines: escLines });
	}

	/* 合并同一发言人相邻块（且颜色一致） */
	const merged = [];
	for (const b of processed) {
		const last = merged[merged.length - 1];
		if (last && last.name === b.name && last.color === b.color) {
			last.lines.push('', ...b.lines);
		} else {
			merged.push({ name: b.name, color: b.color, lines: b.lines.slice() });
		}
	}

	let out = '';
	for (const b of merged) {
		const inner = esc(b.name) + '：' + b.lines.join('<br>');
		out += `<span style="color:${b.color}">${inner}</span>\n\n`;
	}
	return out;
}

/* ---------- 覆盖确认弹窗 ---------- */
class ConfirmModal extends Modal {
	constructor(app, message, onConfirm) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('p', { text: this.message });
		const bar = contentEl.createDiv({ cls: 'modal-button-container' });
		const ok = bar.createEl('button', { text: '覆盖', cls: 'mod-warning' });
		ok.onclick = () => this.respond(true);
		const cancel = bar.createEl('button', { text: '取消' });
		cancel.onclick = () => this.respond(false);
	}
	respond(confirmed) {
		if (this.responded) return;
		this.responded = true;
		this.close();
		Promise.resolve().then(() => this.onConfirm(confirmed)).catch(reportError);
	}
	onClose() {
		this.contentEl.empty();
		if (!this.responded) {
			this.responded = true;
			Promise.resolve().then(() => this.onConfirm(false)).catch(reportError);
		}
	}
}

/* ---------- 文件夹选择器 ---------- */
class FolderPicker extends FuzzySuggestModal {
	constructor(app, onChoose) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder('选择要批量染色的文件夹');
	}
	getItems() {
		return this.app.vault.getAllLoadedFiles().filter((f) => f instanceof TFolder);
	}
	getItemText(f) { return f.path || '/'; }
	onChooseItem(f) { this.onChoose(f); }
}

/* ---------- 插件主体 ---------- */
module.exports = class DiceLogPainter extends Plugin {
	async onload() {
		this.addCommand({
			id: 'paint-active-log',
			name: '染色渲染为 Markdown',
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				const ok = !!(f && f.extension === 'txt');
				if (ok && !checking) this.renderFile(f);
				return ok;
			}
		});

		this.addCommand({
			id: 'paint-folder',
			name: '染色渲染整个文件夹（批量）',
			callback: () => {
				new FolderPicker(this.app, (folder) => this.renderFolder(folder).catch(reportError)).open();
			}
		});

		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
			if (file instanceof TFile && file.extension === 'txt') {
				menu.addItem((item) => {
					item.setTitle('染色渲染为 Markdown')
						.setIcon('palette')
						.onClick(() => this.renderFile(file));
				});
			} else if (file instanceof TFolder) {
				menu.addItem((item) => {
					item.setTitle('染色渲染此文件夹的 txt（批量）')
						.setIcon('palette')
						.onClick(() => this.renderFolder(file).catch(reportError));
				});
			}
		}));
	}

	mapPath(folder) {
		const base = (!folder || folder.path === '' || folder.path === '/') ? '' : folder.path + '/';
		return normalizePath(base + MAP_FILENAME);
	}

	/* 载入映射表；不存在则自动扫全目录昵称生成预填模板 */
	async loadMapping(folder) {
		const path = this.mapPath(folder);
		let mapFile = this.app.vault.getAbstractFileByPath(path);
		if (!mapFile) {
			await this.generateMappingTemplate(folder, path);
			mapFile = this.app.vault.getAbstractFileByPath(path);
			new Notice('已生成映射模板 ' + MAP_FILENAME + '，填好「名字」列后重跑渲染即可。');
		}
		return mapFile instanceof TFile
			? parseMapping(await this.app.vault.read(mapFile)) : Object.create(null);
	}

	async generateMappingTemplate(folder, path) {
		const kids = folder && folder.children ? folder.children : [];
		const txts = kids.filter((f) => f instanceof TFile && f.extension === 'txt');
		const nicks = new Set();
		for (const t of txts) {
			const c = await this.app.vault.read(t);
			for (const line of c.replace(/\r\n?/g, '\n').split('\n')) {
				const m = line.match(HEADER_RE);
				if (m) nicks.add(m[1].trim());
			}
		}
		let md = '# 染色映射\n\n> 「名字」列填好后重跑渲染命令生效。「颜色」列可留空（自动软色）或填 `#rrggbb`。\n> 优先级：骰子灰 > KP黑 > 手动颜色 > 自动色。\n\n';
		md += '| 昵称 | 名字 | 颜色 |\n|---|---|---|\n';
		for (const n of Array.from(nicks).sort()) {
			md += `| ${encodeCell(n)} |  |  |\n`;
		}
		await this.app.vault.create(path, md);
	}

	/* 读取 txt → 生成 md 文本（含 frontmatter）；无发言返回 null */
	async buildMarkdown(file) {
		const content = await this.app.vault.read(file);
		const blocks = parseBlocks(content);
		if (!blocks.length) return null;
		const map = await this.loadMapping(file.parent);
		const body = renderBody(blocks, map);
		const fm = `---\nsource: ${JSON.stringify(file.name)}\ngenerated: ${today()}\n---\n\n`;
		return fm + body;
	}

	/* 写出同目录同名 md；返回生成的 TFile */
	async writeMd(file, md) {
		const targetPath = normalizePath(file.path.replace(/\.txt$/i, '.md'));
		const existing = this.app.vault.getAbstractFileByPath(targetPath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, md);
			return existing;
		}
		return await this.app.vault.create(targetPath, md);
	}

	/* 单文件：覆盖前弹窗确认 */
	async renderFile(file) {
		try {
			const md = await this.buildMarkdown(file);
			if (md == null) { new Notice('未识别到发言（格式不符？）'); return; }
			const targetPath = normalizePath(file.path.replace(/\.txt$/i, '.md'));
			const existing = this.app.vault.getAbstractFileByPath(targetPath);
			const doWrite = async () => {
				const tf = await this.writeMd(file, md);
				new Notice('已生成 ' + tf.name);
				await this.app.workspace.getLeaf(true).openFile(tf);
			};
			if (existing) {
				new ConfirmModal(this.app, existing.name + ' 已存在，覆盖？', async (yes) => { if (yes) await doWrite(); }).open();
			} else {
				await doWrite();
			}
		} catch (e) {
			reportError(e);
		}
	}

	/* 递归收集文件夹下所有 txt */
	collectTxt(folder, arr) {
		for (const c of folder.children) {
			if (c instanceof TFile && c.extension === 'txt') arr.push(c);
			else if (c instanceof TFolder) this.collectTxt(c, arr);
		}
	}

	/* 批量：一次性确认，逐个渲染（已存在直接覆盖），末尾汇总 */
	async renderFolder(folder) {
		const txts = [];
		this.collectTxt(folder, txts);
		if (!txts.length) { new Notice('该文件夹（含子目录）没有 txt'); return; }
		const label = folder.path || '/';
		new ConfirmModal(
			this.app,
			`将渲染「${label}」下 ${txts.length} 个 txt 为 Markdown，已存在的 .md 会被覆盖，继续？`,
			async (yes) => {
				if (!yes) return;
				let ok = 0, skip = 0, fail = 0;
				for (const f of txts) {
					try {
						const md = await this.buildMarkdown(f);
						if (md == null) { skip++; continue; }
						await this.writeMd(f, md);
						ok++;
					} catch (e) {
						console.error('[dice-log-painter]', f.path, e);
						fail++;
					}
				}
				new Notice(`批量染色完成：成功 ${ok}，跳过 ${skip}，失败 ${fail}`);
			}
		).open();
	}
};

/* 测试导出（仅供 node 回归，Obsidian 运行时无副作用） */
module.exports.__test = { parseBlocks, isOOC, cleanLine, renderBody, hashColor, DICE_RE,
	validColor, encodeCell, splitTableRow, parseMapping, ConfirmModal };
