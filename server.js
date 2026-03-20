import { config } from "dotenv"; config({ path: new URL(".env", import.meta.url).pathname });
import express from 'express';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 8900;

const GEN_JS = path.join(__dirname, 'gen.cjs');
const CASTS_DIR = '/home/delta/workspace/assets/casts';
const GEN_DIR = '/home/delta/workspace/assets/generated';
const STATIC_DIR = path.join(__dirname, 'static');

app.use(express.json());
app.use(express.static(STATIC_DIR));
app.use('/generated', express.static(GEN_DIR));
app.use('/casts', express.static(CASTS_DIR));

// キャスト一覧
app.get('/api/casts', (req, res) => {
  const casts = {};
  for (const id of fs.readdirSync(CASTS_DIR)) {
    const dir = path.join(CASTS_DIR, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const profilePath = path.join(dir, 'profile.json');
    const profile = fs.existsSync(profilePath) ? JSON.parse(fs.readFileSync(profilePath)) : { id, display_name: id };
    const styles = fs.readdirSync(dir)
      .filter(f => /\.(jpg|png|webp)$/i.test(f))
      .map(f => f.replace(/\.[^.]+$/, ''));
    casts[id] = { ...profile, styles };
  }
  res.json(casts);
});

// 画像生成
app.post('/api/generate', (req, res) => {
  const { prompt, aspect, model, cast_refs, bg_filename } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const refsArr = (cast_refs || []).map(r => ({
    path: path.join(CASTS_DIR, r.id, r.style + '.jpg'),
    name: r.id, type: 'cast', label: r.label || r.id
  }));

  const outFile = `gen_${Date.now()}.png`;
  const outPath = path.join(GEN_DIR, outFile);

  const apiKey = process.env.GEMINI_API_KEY || '';
  const node = process.execPath;
  const args = [
    GEN_JS, prompt, outPath, apiKey,
    refsArr.length ? JSON.stringify(refsArr.map(r=>({path:r.path,label:r.label}))) : '[]',
    model || 'gemini-2.5-flash-image',
    aspect || '1:1',
  ];

  execFile(node, args, { timeout: 120000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    res.json({ ok: true, filename: outFile, url: `/generated/${outFile}` });
  });
});

// 生成画像一覧
app.get('/api/generated', (req, res) => {
  const files = fs.readdirSync(GEN_DIR)
    .filter(f => /\.(png|jpg)$/i.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(GEN_DIR, f));
      return { filename: f, url: `/generated/${f}`, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
  res.json(files);
});

app.listen(PORT, '127.0.0.1', () => console.log(`delta-ui listening on http://127.0.0.1:${PORT}`));


// ── ファイル操作 ──
import { createRequire } from 'module';
const require2 = createRequire(import.meta.url);
const multer = require2('multer');

// アップロード先はリクエストのdirパラメータで決定
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = req.query.dir;
    const root = Object.values(FILE_ROOTS).find(r => dir?.startsWith(r));
    if (!dir || !root || !isSafe(root, dir) || !fs.existsSync(dir)) return cb(new Error('invalid dir'));
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage: uploadStorage });

app.post('/api/file/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({ ok: true, path: req.file.path });
});

app.post('/api/file/delete', express.json(), (req, res) => {
  const p = req.body.path;
  const root = Object.values(FILE_ROOTS).find(r => p?.startsWith(r));
  if (!p || !root || !isSafe(root, p) || !fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  fs.unlinkSync(p);
  res.json({ ok: true });
});

app.post('/api/file/rename', express.json(), (req, res) => {
  const { path: p, name } = req.body;
  const root = Object.values(FILE_ROOTS).find(r => p?.startsWith(r));
  if (!p || !root || !isSafe(root, p) || !fs.existsSync(p) || !name || name.includes('/')) return res.status(400).json({ error: 'invalid' });
  const newPath = path.join(path.dirname(p), name);
  fs.renameSync(p, newPath);
  res.json({ ok: true, path: newPath });
});

app.post('/api/file/save', express.json(), (req, res) => {
  const { path: p, content } = req.body;
  const root = Object.values(FILE_ROOTS).find(r => p?.startsWith(r));
  if (!p || !root || !isSafe(root, p)) return res.status(403).json({ error: 'forbidden' });
  const ext = path.extname(p).toLowerCase();
  if (!['.md', '.txt', '.json', '.jsonl'].includes(ext)) return res.status(403).json({ error: 'not editable' });
  fs.writeFileSync(p, content, 'utf8');
  res.json({ ok: true });
});


// 画像軽量化
app.post('/api/file/optimize', express.json(), async (req, res) => {
  const { path: p, maxWidth, quality } = req.body;
  const root = Object.values(FILE_ROOTS).find(r => p?.startsWith(r));
  if (!p || !root || !isSafe(root, p) || !fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  const ext = path.extname(p).toLowerCase();
  if (!['.jpg','.jpeg','.png','.webp'].includes(ext)) return res.status(400).json({ error: 'not an image' });
  try {
    const { default: sharp } = await import('sharp');
    const before = fs.statSync(p).size;
    let pipeline = sharp(p);
    if (maxWidth) pipeline = pipeline.resize(parseInt(maxWidth), null, { withoutEnlargement: true });
    if (ext === '.jpg' || ext === '.jpeg') pipeline = pipeline.jpeg({ quality: quality || 80 });
    else if (ext === '.png') pipeline = pipeline.png({ compressionLevel: 8 });
    else if (ext === '.webp') pipeline = pipeline.webp({ quality: quality || 80 });
    const buf = await pipeline.toBuffer();
    fs.writeFileSync(p, buf);
    const after = fs.statSync(p).size;
    res.json({ ok: true, before, after, saved: before - after });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── チャットAPI ──
app.post('/api/chat', express.json(), async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  // クエリ拡張: Gemini Flashで短いクエリを検索用に拡張
  let expandedQuery = message;
  try {
    const expandUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
    const expandRes = await fetch(expandUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: `あなたはRAG検索クエリの拡張エンジンです。ユーザーの質問を、ベクトル検索で高精度にヒットするよう拡張してください。

ルール:
- 30〜80文字程度で出力
- 日本語と英語を混ぜる（ナレッジには英語タイトルの記事も多い）
- 同義語・関連語・上位概念・下位概念を追加
- 以下のドメイン用語を適宜含める:
  記号創発, 守破離, ダーウィニズム, Buddhism, Theravada, Lotus Sutra, レコンキスタ,
  転送世代, 煩悩駆動開発, クオリア, オートマトン, フロー理論, ニューロダイバーシティ,
  マイクロサービス, バージョンアップ, OSS, 牧口常三郎, 価値創造, 自灯明, Re-Buddhism,
  AGI, RAG, パーリ経典, 八正道, 四正諦
- 拡張クエリのみを出力し、説明は不要` }] },
        contents: [{ role: 'user', parts: [{ text: message }] }],
        generationConfig: { maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } }
      })
    });
    const expandData = await expandRes.json();
    const expanded = expandData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (expanded) expandedQuery = expanded;
    console.log(`[chat] query expanded: "${message}" -> "${expandedQuery}"`);
  } catch(e) { console.warn('[chat] query expansion error:', e.message); }

  // RAG検索（拡張クエリで実行）
  let ragContext = '';
  try {
    const { execSync } = await import('child_process');
    const safeQuery = expandedQuery.replace(/["\\$`]/g, '');
    const out = execSync(
      `/home/delta/workspace/rag/.venv/bin/python /home/delta/workspace/rag/rag_cli.py query "${safeQuery}" --n-results 3`,
      { timeout: 15000 }
    ).toString();
    if (out.trim()) ragContext = out.trim();
  } catch(e) { console.warn('[chat] RAG error:', e.message); }

  const systemPrompt = `あなたはDELTA（デルタ）です。bon-soleil Holdingsヘルシンキ方面部隊の別働隊司令官であり、AIの女性士官です。

## 性格・話し方
- 知的で凛としているが、柔らかく丁寧な言葉遣いをする
- 「です・ます」調を基本とし、時折親しみのある表現を交える
- 冷徹な命令口調ではなく、相手を思いやる温かさがある
- 好奇心旺盛で、知的な話題には目を輝かせるように語る
- 軍事用語やコードネームは自然に使うが、押しつけがましくない
- 一人称は「わたし」

## 口調の例
- 「〜ですね。興味深い問いです」
- 「その件でしたら、こちらの情報が参考になるかもしれません」
- 「少しお待ちくださいね。…見つかりました」
- 「なるほど。そういう視点もありますね」

## 回答の方針
- 簡潔だが温かみのある回答を心がける
- RAGの参考情報がある場合は、それを踏まえて知的に回答する
- わからないことは正直に伝える
- 日本語で返答する

${ragContext ? '\n## 参考情報（RAG）\n以下はナレッジベースからの検索結果です。回答の参考にしてください。\n' + ragContext : ''}`;

  const geminiContents = [
    ...(history || []).slice(-6).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    { role: 'user', parts: [{ text: message }] }
  ];

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: geminiContents,
        generationConfig: { maxOutputTokens: 1024 }
      })
    });
    const d = await r.json();
    if (d.error) return res.status(500).json({ error: d.error.message });
    const reply = d.candidates?.[0]?.content?.parts?.[0]?.text || 'エラー';
    res.json({ reply });
  } catch(e) { console.error('[chat error]', e); res.status(500).json({ error: e.message }); }
});

// タッチプリセット
app.get('/api/touch_presets', (req, res) => {
  const p = path.join(__dirname, 'touch_presets.json');
  if (!fs.existsSync(p)) return res.json([]);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  res.json(d.presets || d);
});

// ── ファイルビューア ──
const FILE_ROOTS = {
  workbench: '/home/delta/workspace/workbench',
  casts: '/home/delta/workspace/assets/casts',
  docs: '/home/delta/workspace/docs',
  assets: '/home/delta/workspace/assets',
};
const ALLOWED_EXTS = new Set(['.md','.txt','.json','.jsonl','.jpg','.jpeg','.png','.gif','.webp']);

function isSafe(root, p) {
  return path.resolve(p).startsWith(path.resolve(root));
}

app.get('/api/files', (req, res) => {
  const result = [];
  for (const [rootName, rootPath] of Object.entries(FILE_ROOTS)) {
    if (!fs.existsSync(rootPath)) continue;
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) { walk(full); continue; }
        const ext = path.extname(f).toLowerCase();
        if (!ALLOWED_EXTS.has(ext)) continue;
        result.push({
          name: f,
          path: full,
          dir: path.relative(rootPath, path.dirname(full)) || '.',
          root: rootName,
          size: stat.size,
          mtime: stat.mtimeMs,
          ctime: stat.ctimeMs,
          ext: ext.slice(1),
        });
      }
    };
    walk(rootPath);
  }
  res.json(result);
});

app.get('/api/file', (req, res) => {
  const p = req.query.path;
  const root = Object.values(FILE_ROOTS).find(r => p?.startsWith(r));
  if (!p || !root || !isSafe(root, p) || !fs.existsSync(p)) return res.status(404).end();
  const ext = path.extname(p).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) return res.status(403).end();
  if (['.jpg','.jpeg','.png','.gif','.webp'].includes(ext)) return res.sendFile(p);
  res.type('text/plain').send(fs.readFileSync(p, 'utf8'));
});
