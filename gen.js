
const fs = require('fs');
const https = require('https');
// argv: prompt outPath apiKey refsJson model aspect
// refsJson: JSON array of {path, label} e.g. '[{"path":"/...","label":"A"}]' or '' for no ref
const [,, prompt, outPath, apiKey, refsJsonArg, modelArg, aspectArg] = process.argv;
const aspect = aspectArg || '1:1';
const refs = (() => { try { return JSON.parse(refsJsonArg || '[]'); } catch(e) { return []; } })()
  .filter(r => r.path && fs.existsSync(r.path));
if (!prompt || !outPath || !apiKey) { console.error('usage: gen.js <prompt> <outPath> <apiKey> [refsJson] [model] [aspect]'); process.exit(1); }

function httpsPost(urlStr, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(new Error('parse: '+d.slice(0,100)));} }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function genWithRefs(refList) {
  const model = modelArg || 'gemini-3-pro-image-preview';
  console.log('using model:', model, 'refs:', refList.length);
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;
  const ASPECT_INSTRUCTIONS = {
    '1:1':  '',
    '9:16': 'IMPORTANT: Output must be a vertical portrait image with 9:16 aspect ratio (tall, like a smartphone screen). Width must be narrower than height.',
    '16:9': 'IMPORTANT: Output must be a horizontal landscape image with 16:9 aspect ratio (wide, like a cinema screen). Width must be wider than height.',
    '4:3':  'IMPORTANT: Output must be a horizontal image with 4:3 aspect ratio (standard landscape). Width must be wider than height.',
    '3:4':  'IMPORTANT: Output must be a vertical portrait image with 3:4 aspect ratio. Height must be taller than width.',
  };
  const aspectPrompt = ASPECT_INSTRUCTIONS[aspect] || '';
  const parts = [];
  for (const ref of refList) {
    const mimeType = ref.path.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const b64 = fs.readFileSync(ref.path).toString('base64');
    parts.push({ inline_data: { mime_type: mimeType, data: b64 } });
    if (ref.type === 'background') {
      parts.push({ text: '[This is the background setting/scene. Keep this background exactly.]' });
    } else {
      const charName = ref.name ? ref.label + ' (' + ref.name + ')' : ref.label;
      parts.push({ text: '[This is character ' + charName + '. Reproduce this character\'s appearance faithfully in the output.]' });
    }
  }
  const refNote = refList.length > 0 ? ' Use the reference images as character design bases. Maintain each character visual style.' : '';
  const fullPrompt = [prompt, refNote, aspectPrompt].filter(Boolean).join(' ');
  parts.push({ text: fullPrompt });
  // imageConfig.aspectRatio: '1:1','16:9','9:16','4:3','3:4' etc. をそのまま渡す
  const VALID_ASPECTS = ['1:1','1:4','1:8','2:3','3:2','3:4','4:1','4:3','4:5','5:4','8:1','9:16','16:9','21:9'];
  const imageAspect = VALID_ASPECTS.includes(aspect) ? aspect : null;
  const generationConfig = {
    responseModalities: ['image', 'text'],
    ...(imageAspect ? { imageConfig: { aspectRatio: imageAspect } } : {}),
  };
  const payload = {
    contents: [{ parts }],
    generationConfig,
  };
  // APIリクエストログ（画像データはサイズのみ記録）
  const logPayload = {
    ts: new Date().toISOString(),
    model, aspect, imageAspect,
    promptLength: fullPrompt.length,
    prompt: fullPrompt.slice(0, 200),
    refs: refList.map(r => ({ label: r.label, name: r.name, type: r.type, sizeKB: Math.round(fs.statSync(r.path).size / 1024) })),
    generationConfig,
    outputPath: outPath,
    outputUrl: '/api/image_gen/img/' + require('path').basename(outPath),
  };
  console.log('[API REQUEST]', JSON.stringify(logPayload));
  // ログファイルに追記
  const logDir = '/srv/shared/metroon/private/system/logs/api';
  try {
    if (fs.existsSync(logDir)) {
      const logFile = logDir + '/nanobanana_gen_' + new Date().toISOString().slice(0,10) + '.jsonl';
      fs.appendFileSync(logFile, JSON.stringify(logPayload) + '\n');
    }
  } catch(e) { console.warn('[LOG WRITE FAILED]', e.message); }

  const data = await httpsPost(url, payload);
  if (data.error) { console.error('[API ERROR]', JSON.stringify(data.error)); process.exit(1); }
  const resParts = data.candidates?.[0]?.content?.parts ?? [];
  const imgPart = resParts.find(p => p.inlineData?.data);
  if (!imgPart) { console.error('No image in response:', JSON.stringify(data).slice(0,300)); process.exit(1); }
  fs.writeFileSync(outPath, Buffer.from(imgPart.inlineData.data, 'base64'));
  console.log('OK(' + model + '):' + outPath);
}

async function genImagen() {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-fast-generate-001:predict?key=' + apiKey;
  const imagenPayload = { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: aspect } };
  console.log('[API REQUEST imagen]', JSON.stringify({ aspect, promptLength: prompt.length, parameters: imagenPayload.parameters }));
  const data = await httpsPost(url, imagenPayload);
  if (data.error) { console.error('[API ERROR]', JSON.stringify(data.error)); process.exit(1); }
  const b64 = data.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) { console.error('No image:', JSON.stringify(data).slice(0,200)); process.exit(1); }
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
  console.log('OK(imagen):' + outPath);
}

async function run() {
  const useGemini = (refs.length > 0 || (modelArg && modelArg.startsWith('gemini'))) && modelArg !== 'imagen-4.0-fast-generate-001';
  if (useGemini) {
    await genWithRefs(refs);
  } else {
    await genImagen();
  }
}
run().catch(e => { console.error(e.message); process.exit(1); });
