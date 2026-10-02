import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import { clearLine, cursorTo } from 'node:readline';

export function requestVideo(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const destination = new URL(url);
    try { options.validateUrl?.(destination.href); }
    catch { reject(new Error('重定向视频地址不受支持。')); return; }
    if (destination.protocol !== 'https:' || destination.username || destination.password) {
      reject(new Error('拒绝非 HTTPS 或包含用户名密码的重定向。')); return;
    }
    // Use the native HTTPS client: Node fetch fails with UND_ERR_SOCKET here.
    const request = https.get(destination, { headers: options.headers, signal: options.signal }, response => {
      clearTimeout(timer);
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.destroy();
        if (redirects >= 5) { reject(new Error('重定向次数过多。')); return; }
        let next;
        try { next = new URL(response.headers.location, destination).href; }
        catch { reject(new Error('无效的重定向地址。')); return; }
        resolve(requestVideo(next, options, redirects + 1)); return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const body = [204, 205, 304].includes(response.statusCode) ? null : Readable.toWeb(response);
      if (!body) response.destroy();
      resolve(new Response(body, { status: response.statusCode, headers }));
    });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('连接超时'), { code: 'ETIMEDOUT' })), 30000);
    request.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

export async function download(video, directory, referer, request = requestVideo, signal) {
  signal?.throwIfAborted();
  const target = path.join(directory, video.name);
  const partial = target + '.part';
  if (fs.existsSync(target)) { if(!video.quiet)console.log(`已存在，跳过：${video.name}`);return; }
  const offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  const headers = { Referer: referer || 'https://v.ustc.edu.cn/' };
  if (offset) headers.Range = `bytes=${offset}-`;
  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try { response = await request(video.url, { headers, signal: signal ? AbortSignal.any([controller.signal,signal]) : controller.signal }); }
  catch (error) { throw new Error(`连接失败：${error.code || error.cause?.code || error.name}（未收到 HTTP 响应）。`); }
  finally { clearTimeout(timer); }
  const stop = async message => { await response.body?.cancel(); throw new Error(message); };
  if ([401, 403].includes(response.status)) return stop(`HTTP ${response.status}：登录、课程权限或预览令牌失效。请正常登录后重新保存可播放的页面。`);
  if (!response.ok) return stop(`HTTP ${response.status}，停止下载。`);
  const type = response.headers.get('content-type') || '';
  if (!/video\/mp4|application\/octet-stream/i.test(type)) return stop(`返回的不是 MP4（${type || '类型缺失'}），停止下载。`);
  const range = response.headers.get('content-range');
  if (offset && response.status === 206 && !range?.startsWith(`bytes ${offset}-`)) return stop('服务器返回的续传起点不匹配，保留临时文件。');
  if (!offset && response.status === 206 && !range?.startsWith('bytes 0-')) return stop('服务器返回的文件起点不为零。');
  fs.mkdirSync(directory, { recursive: true });
  const append = offset > 0 && response.status === 206;
  const stream = fs.createWriteStream(partial, { flags: append ? 'a' : 'w' });
  let streamError;
  stream.on('error', error => { streamError = error; });
  let bytes = 0, last = Date.now();
  const progressTotal = Number(range?.match(/\/(\d+)$/)?.[1]) || Number(response.headers.get('content-length')) + (append ? offset : 0) || Number(video.size) || 0;
  let progressShown = false;
  const showProgress = () => {
    const current = bytes + (append ? offset : 0), ratio = progressTotal ? Math.min(1,current/progressTotal) : 0;
    video.onProgress?.(current,progressTotal);
    if(video.quiet)return;
    const filled = Math.floor(ratio*24);
    const line = `[${'='.repeat(filled)}${' '.repeat(24-filled)}] ${progressTotal ? (ratio*100).toFixed(1)+'%' : '下载中'} ${(current/1048576).toFixed(1)} MB${progressTotal ? ' / '+(progressTotal/1048576).toFixed(1)+' MB' : ''}`;
    if(!progressShown)console.log(`下载：${video.name}`);
    if(process.stdout.isTTY){cursorTo(process.stdout,0);clearLine(process.stdout,0);}else process.stdout.write('\r');
    process.stdout.write(line);progressShown=true;
  };
  showProgress();
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      if (streamError) throw streamError;
      if (!stream.write(chunk)) await once(stream, 'drain');
      bytes += chunk.length;
      if (Date.now() - last > 1000) {
        showProgress();
        last = Date.now();
      }
    }
    stream.end();
    await once(stream, 'finish');
    const expected = Number(response.headers.get('content-length'));
    if (!bytes || (expected && bytes !== expected)) throw new Error('下载不完整，保留 .part 文件以供续传。');
    const total = range?.match(/^bytes \d+-\d+\/(\d+)$/)?.[1];
    if (total && fs.statSync(partial).size !== Number(total)) throw new Error('尚未获取完整视频，保留 .part 文件以供续传。');
    signal?.throwIfAborted();
    fs.renameSync(partial, target);
    showProgress();if(!video.quiet)process.stdout.write('\n');progressShown=false;
    if(!video.quiet)console.log(`完成：${target}`);
  } catch (error) { if(progressShown)process.stdout.write('\n');if(!stream.closed)await new Promise(resolve=>{stream.once('close',resolve);stream.destroy();});throw error; }
}

