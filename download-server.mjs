import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import { download, requestVideo } from './video-downloader.mjs';
import { createTerminalDashboard } from './terminal-dashboard.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18766;
const MAX_CONCURRENT_DOWNLOADS = 2;
const STATE = path.join(ROOT, '.download-state');
const QUEUE = path.join(STATE, 'queue.json');
const DOWNLOADS=path.join(os.homedir(),'Downloads');
const clean = value => String(value||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,80);
export function validateVideoUrl(value) {
  const url = new URL(value);
  if(url.protocol!=='https:')throw new Error('视频地址必须使用 HTTPS。');
  if(!['v.ustc.edu.cn','ilesson.v.ustc.edu.cn'].includes(url.hostname))throw new Error(`视频域名不受支持：${url.hostname}`);
  if(url.username || url.password || (url.port && url.port!=='443'))throw new Error('视频地址包含不支持的账号信息或端口。');
  const valid = url.hostname==='v.ustc.edu.cn'
    ? /^\/api\/base\/orgs\/ustc\/captures\/[a-zA-Z0-9-]+\/videos\/\d+\/preview$/.test(url.pathname)
    : /^\/videos\/outbound\/ustc\/(?:.+\.mp4|\d+\/\d{8}\/\d{6}-\d{6}-\d+\/(?:INSTRUCTOR|ENCODER)-[a-fA-F0-9]+)$/.test(url.pathname);
  if(!valid)throw new Error(`视频路径不受支持：${url.hostname}${url.pathname}`);
  return url.href;
}
function normalize(task) {
  if(!task || ![task.courseId,task.lessonId,task.videoId].every(id=>/^\d+$/.test(String(id))))throw new Error('任务缺少有效编号或下载授权。');
  const result={courseId:String(task.courseId),lessonId:String(task.lessonId),videoId:String(task.videoId),url:validateVideoUrl(task.url),size:Number(task.size)||0,downloadAllowed:true};
  const label=task.label==='INSTRUCTOR'?'教师画面':task.label==='ENCODER'?'电脑录屏':'视频';
  const date=new Date(`${task.date}T12:00:00+08:00`);
  const weekday=Number.isNaN(date.valueOf())?'未知':new Intl.DateTimeFormat('en-US',{weekday:'short',timeZone:'Asia/Shanghai'}).format(date);
  result.name=`Week${clean(task.week)||'未知'}-${weekday}-${clean(task.date)||'日期未知'}-${clean(task.title)||'课程'}-${label}.mp4`;
  return result;
}
export function validateDownloadTask(task) {
  if(!task || !/^\d+$/.test(task.videoId) || typeof task.name!=='string' || /[<>:"/\\|?*\x00-\x1f]/.test(task.name) || !task.name.endsWith('.mp4'))throw new Error('下载任务记录无效。');
  validateVideoUrl(task.url);
}
export async function startDownloadService() {
  fs.mkdirSync(STATE,{recursive:true});
  let tasks=[];
  if(fs.existsSync(QUEUE)) {
    tasks=JSON.parse(fs.readFileSync(QUEUE,'utf8'));
    if(!Array.isArray(tasks))throw new Error('任务记录无效，请移走 .download-state/queue.json 后重新启动。');
    tasks=tasks.filter(t=>t.status!=='done').map(t=>{
      validateVideoUrl(t.url);
      if(!/^\d+$/.test(t.courseId)||!/^\d+$/.test(t.lessonId)||!/^\d+$/.test(t.videoId)||typeof t.name!=='string'||/[<>:"/\\|?*\x00-\x1f]/.test(t.name)||!t.name.endsWith('.mp4')||!['queued','running','done','failed','cancelled','paused'].includes(t.status))throw new Error('任务记录格式无效。');
      return {...t,status:t.status==='running'?'queued':t.status};
    });
  }
  const save=()=>{fs.writeFileSync(QUEUE+'.tmp',JSON.stringify(tasks));fs.renameSync(QUEUE+'.tmp',QUEUE);render();};
  const active=new Map();
  const taskId=task=>`${task.courseId}:${task.lessonId}:${task.videoId}`;
  const removeCancelled=()=>{
    tasks=tasks.filter(task=>{
      if(task.status!=='cancelled'||active.has(taskId(task)))return true;
      fs.rmSync(path.join(DOWNLOADS,task.name+'.part'),{force:true});
      progress.delete(task.name);return false;
    });
  };
  const cancelPending=()=>{
    const pending=tasks.filter(t=>t.status!=='cancelled');
    pending.forEach(task=>task.status='cancelled');
    try{save();}finally{for(const controller of active.values())controller.abort();}
    removeCancelled();save();
    return pending.length;
  };
  const progress=new Map();
  const dashboard=createTerminalDashboard(()=>({tasks,progress}));
  const {render,notify}=dashboard;
  async function pump() {
    const wanted=tasks.filter(t=>['queued','running'].includes(t.status)).slice(0,MAX_CONCURRENT_DOWNLOADS);
    for(const task of tasks){
      const controller=active.get(taskId(task));
      if(controller&&!wanted.includes(task)){
        if(task.status==='running')task.status='queued';
        controller.abort();
      }
    }
    for(const task of wanted){
      if(active.size>=MAX_CONCURRENT_DOWNLOADS)break;
      if(active.has(taskId(task))||task.status!=='queued')continue;
      const controller=new AbortController();active.set(taskId(task),controller);task.status='running';
      runTask(task,controller).catch(()=>notify('队列保存失败，请重启服务。'));
    }
    save();
  }
  async function runTask(task,controller){
    try {
          await download({url:task.url,name:task.name,size:task.size,quiet:true,onProgress:(bytes,total)=>{progress.set(task.name,{bytes,total});render();}},DOWNLOADS,'https://v.ustc.edu.cn/',(url,options)=>requestVideo(validateVideoUrl(url),{...options,validateUrl:validateVideoUrl}),controller.signal);
          if(task.size>0&&fs.statSync(path.join(DOWNLOADS,task.name)).size!==task.size)throw new Error('大小不匹配');
          if(task.status==='running'){task.status='done';notify(`已完成：${task.name}`);}
    }catch{if(!controller.signal.aborted){task.status='failed';notify(`错误：${task.name}`);}}
    finally{active.delete(taskId(task));removeCancelled();save();await pump();}
  }
  const server=http.createServer(async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try {
      if(req.headers.host!==`127.0.0.1:${PORT}`)return send(403,{error:'只接受本机地址。'});
      if(req.headers.origin&&req.headers.origin!=='https://v.ustc.edu.cn')return send(403,{error:'请求来源不允许。'});
      const pathname=new URL(req.url,`http://127.0.0.1:${PORT}`).pathname;
      if(req.method==='GET'&&pathname==='/health')return send(200,{ok:true,version:'0.4.0'});
      if(req.method==='GET'&&pathname==='/jobs')return send(200,{tasks:tasks.filter(t=>t.status!=='cancelled').map(t=>({id:taskId(t),name:t.name,status:t.status,bytes:progress.get(t.name)?.bytes||0,total:progress.get(t.name)?.total||t.size||0}))});
      if(req.method!=='POST'||!['/jobs','/jobs/cancel','/jobs/control'].includes(pathname))return send(404,{error:'请通过录课网站中的油猴面板提交任务。'});
      if(req.headers['x-course-helper']!=='ustc-download'||!(req.headers['content-type']||'').startsWith('application/json'))return send(403,{error:'请求格式不允许。'});
      if(pathname==='/jobs/cancel'){
        const cancelled=cancelPending();
        return send(200,{cancelled});
      }
      let body='';for await(const chunk of req){body+=chunk;if(body.length>1048576)return send(413,{error:'任务过大，请分批提交。'});}
      if(pathname==='/jobs/control'){
        let data;try{data=JSON.parse(body);}catch{return send(400,{error:'任务操作格式错误。'});}
        const task=tasks.find(t=>taskId(t)===data.id);
        if(!task)return send(404,{error:'任务不存在。'});
        if(data.action==='move'){
          const before=tasks.find(t=>taskId(t)===data.before);
          if(!before&&data.before!==null)return send(400,{error:'排序目标不存在。'});
          if(task!==before){tasks.splice(tasks.indexOf(task),1);if(before)tasks.splice(tasks.indexOf(before),0,task);else tasks.push(task);}
        }else if(data.action==='pause'&&['queued','running'].includes(task.status))task.status='paused';
        else if(data.action==='cancel')task.status='cancelled';
        else if(data.action==='resume'&&['paused','failed'].includes(task.status))task.status='queued';
        else return send(400,{error:'当前任务不能执行此操作。'});
        save();
        if(['paused','cancelled'].includes(task.status))active.get(taskId(task))?.abort();
        removeCancelled();save();
        send(200,{ok:true});setImmediate(()=>pump().catch(()=>notify('队列保存失败。')));return;
      }
      let incoming;
      try {
        const data=JSON.parse(body);
        if(!Array.isArray(data?.tasks)||!data.tasks.length||data.tasks.length>200)throw new Error('任务列表必须包含 1～200 路视频。');
        incoming=data.tasks.map(normalize);
      }catch(e){return send(400,{error:`下载任务无效：${e instanceof SyntaxError?'提交内容不是有效 JSON。':e instanceof TypeError?'任务字段格式错误或视频网址无效。':e.message||'未知原因。'}`});}
      const before=JSON.stringify(tasks);
      const skipped=[];
      for(const item of incoming) {
        const existing=tasks.find(t=>t.courseId===item.courseId&&t.lessonId===item.lessonId&&t.videoId===item.videoId);
        if(existing) {
          if(['running','paused'].includes(existing.status)||(existing.status==='done'&&fs.existsSync(path.join(DOWNLOADS,existing.name))))skipped.push(existing.name);
          if(['queued','failed','cancelled'].includes(existing.status)){existing.url=item.url;existing.size=item.size;existing.status='queued';}
          else if(existing.status==='done'&&!fs.existsSync(path.join(DOWNLOADS,existing.name)))existing.status='queued',existing.url=item.url;
          continue;
        }
        if(tasks.some(t=>t.name.toLowerCase()===item.name.toLowerCase())||fs.existsSync(path.join(DOWNLOADS,item.name))||fs.existsSync(path.join(DOWNLOADS,item.name+'.part'))){skipped.push(item.name);notify(`跳过重名：${item.name}`);continue;}
        tasks.push({...item,status:'queued'});
      }
      try{save();}catch{tasks=JSON.parse(before);return send(500,{error:'任务未保存，请检查项目目录写入权限。'});}
      send(202,{pending:tasks.filter(t=>['queued','running'].includes(t.status)).length,skipped});
      setImmediate(()=>pump().catch(()=>notify('队列保存失败，请重启服务。')));
    }catch{if(!res.headersSent)send(500,{error:'本地服务处理失败。'});else res.destroy();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(PORT,'127.0.0.1',resolve);});
  dashboard.start();
  if(process.stdin.isTTY){
    emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);
    const onKey=(character,key)=>{
      if(key?.ctrl&&key.name==='c'){process.stdin.setRawMode(false);process.exit(130);}
      if(/^[0-9]$/.test(character||'')&&!key?.ctrl&&!key?.alt){
        try{
          if(character==='0')cancelPending();
          else{
            const task=tasks.filter(t=>t.status!=='cancelled')[Number(character)-1];
            if(!task)return;
            task.status='cancelled';save();active.get(taskId(task))?.abort();removeCancelled();save();
          }
          pump().catch(()=>notify('队列保存失败。'));
        }
        catch{notify('取消状态保存失败，请检查项目目录写入权限。');}
      }
    };
    process.stdin.on('keypress',onKey);
    server.once('close',()=>{process.stdin.removeListener('keypress',onKey);process.stdin.setRawMode(false);process.stdin.pause();});
  }
  removeCancelled();save();
  server.once('close',dashboard.close);
  pump().catch(()=>notify('队列保存失败，请重启服务。'));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDownloadService().catch(error => { console.error(error.message); process.exitCode = 1; });
}
