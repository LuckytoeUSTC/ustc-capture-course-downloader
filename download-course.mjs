// Compatibility entry for the original 下载录课.cmd.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, requestVideo } from './video-downloader.mjs';

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  if (mode === 'download' && args[1]) {
    const html = fs.readFileSync(args[1], 'utf8');
    const ids = [...html.matchAll(/\/captures\/([a-zA-Z0-9-]+)\/videos\/(\d+)\/preview/g)].map(match => match[2]);
    if (!ids.length) throw new Error('请拖入能够播放的单堂录课 HTML。');
    const root = path.dirname(fileURLToPath(import.meta.url));
    const queueFile = path.join(root, '.download-state', 'queue.json');
    const tasks = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, 'utf8')) : [];
    const approved = tasks.filter(task => ids.includes(task.videoId));
    if (!approved.length) throw new Error('此 HTML 没有对应的已授权下载任务。请先通过油猴提交平台允许下载的录课。');
    if (approved.some(task => ['queued', 'running'].includes(task.status))) throw new Error('该任务已交给本地服务处理，请在油猴中查看下载进度。');
    const { validateDownloadTask, validateVideoUrl } = await import('./download-server.mjs');
    for (const task of approved) {
      validateDownloadTask(task);
      await download({url:task.url,name:task.name},path.resolve(args[2] || 'downloads'),'https://v.ustc.edu.cn/',(url,options)=>requestVideo(url,{...options,validateUrl:validateVideoUrl}));
    }
    return;
  }
  if (!mode || mode === 'serve') {
    const { startDownloadService } = await import('./download-server.mjs');
    await startDownloadService();
    return;
  }
  throw new Error('请双击“启动下载服务.cmd”，或运行 node download-server.mjs。');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
