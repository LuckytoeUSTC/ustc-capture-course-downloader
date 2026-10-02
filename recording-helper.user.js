// ==UserScript==
// @name         录课目录助手
// @namespace    ustc-course-helper
// @version      0.4.3
// @description  读取我的课程目录，多选录课并交给本地程序下载
// @match        https://v.ustc.edu.cn/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==
(() => {
  'use strict';
  const SERVICE = 'http://127.0.0.1:18766';
  if (document.getElementById('ustc-course-helper')) return;
  function api(route, data) {
    const method = data === undefined ? 'GET' : 'POST';
    const headers = { 'Content-Type': 'application/json', 'X-Course-Helper': 'ustc-download' };
    if (typeof GM_xmlhttpRequest === 'function') return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method, url: SERVICE + route, headers, anonymous: true, timeout: 30000,
        data: data === undefined ? undefined : JSON.stringify(data),
        onload: r => { try { const body = JSON.parse(r.responseText); if (r.status >= 400) throw new Error(body.error || '请求失败'); resolve(body); } catch (e) { reject(e); } },
        onerror: () => reject(new Error('请先双击“启动下载服务.cmd”，并保持窗口打开。')),
        ontimeout: () => reject(new Error('本地服务响应超时，请重试。')) });
    });
    return fetch(SERVICE + route, { method, headers, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30000) })
      .then(async r => { const body = await r.json(); if (!r.ok) throw new Error(body.error || '请求失败'); return body; });
  }
  async function siteApi(route) {
    const r = await fetch(route, {credentials:'same-origin',headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});
    if([401,403].includes(r.status)) throw new Error('请正常登录并确认课程访问权限。');
    if(!r.ok) throw new Error(`平台请求失败：HTTP ${r.status}`);
    if(!(r.headers.get('content-type')||'').includes('json')) throw new Error('请重新登录录课网站。');
    const body=await r.json();
    if(body.error?.code && body.error.code!=='0') throw new Error('平台未返回可访问的数据。');
    if(!Object.hasOwn(body,'data')) throw new Error('平台接口格式发生变化。');
    return body.data;
  }
  const coursePath = id => `/api/frontend/study-capture-courses/${id}`;
  const timeFormat = (value,options) => value && !Number.isNaN(new Date(value).valueOf()) ? new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...options}).format(new Date(value)) : '';
  function normalizeLesson(r) {
    const start=Date.parse(r.start_time),end=Date.parse(r.end_time);
    return {id:String(r.id),captureCode:r.capture_code,name:r.name||'录课',published:!!r.capture_code && r.published!==false,
      week:r.week,slots:String(r.slot_nos||'').replace(/,\s*/g,', '),
      date:timeFormat(r.start_time,{year:'numeric',month:'2-digit',day:'2-digit'}).replace(/\//g,'-'),
      startTime:timeFormat(r.start_time,{hour:'2-digit',minute:'2-digit',hour12:false}),endTime:timeFormat(r.end_time,{hour:'2-digit',minute:'2-digit',hour12:false}),
      durationSeconds:Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,(end-start)/1000):0,
      classroom:[r.classroom?.building?.name,r.classroom?.name||r.classroom?.code].filter(Boolean).join(' ')};
  }
  function safeVideo(value) {
    try { const u=new URL(value); if(u.protocol==='https:' && ['v.ustc.edu.cn','ilesson.v.ustc.edu.cn'].includes(u.hostname) && !u.username && !u.password && (!u.port||u.port==='443')) return u.href; }catch{}
    return null;
  }
  const detailFor = (id,lesson) => siteApi(`${coursePath(id)}/captures/${encodeURIComponent(lesson.captureCode)}?in_course_preview=false`);
  const videosFor = d => Array.isArray(d.lesson_videos)&&d.lesson_videos.length ? d.lesson_videos : Array.isArray(d.videos)?d.videos:[];
  const host = document.createElement('div'); host.id = 'ustc-course-helper'; document.documentElement.append(host);
  const root = host.attachShadow({mode:'open'});
  root.innerHTML = `<style>
    :host { all:initial; font:14px/1.5 system-ui; color:#233354; }
    * { box-sizing:border-box; }
    [hidden] { display:none!important; }
    button,input { font:inherit; }
    button { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:32px; padding:6px 11px; border:1px solid #dce4e8; border-radius:8px; background:#fff; color:#405563; font-weight:500; cursor:pointer; transition:background .15s,border-color .15s; }
    button:hover:not(:disabled) { background:#f3f6f8; border-color:#b8c9d3; }
    button:disabled { opacity:.42; cursor:default; }
    button:focus-visible,input:focus-visible { outline:2px solid #3286b8; outline-offset:2px; }
    .row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .muted { color:#60737c; font-size:12px; }
    .button-icon,.task-controls svg { width:14px; height:14px; display:block; flex:none; }
    .panel,.task-window,.viewer { position:fixed; z-index:2147483647; display:flex; flex-direction:column; overflow:hidden; background:#fff; border:1px solid #cbd7f3; border-radius:12px; box-shadow:0 10px 32px #3658a326; }
    .panel,.task-window { right:16px; width:min(540px,calc(100vw - 32px)); }
    .panel { top:24px; bottom:344px; }
    .task-window { bottom:80px; height:256px; }
    .launch { position:fixed; right:20px; bottom:24px; z-index:2147483646; padding:10px 15px; }
    .launch,.actions #download { background:#4169ef; border-color:#4169ef; color:#fff; box-shadow:0 4px 12px #4169ef30; }
    .launch:hover:not(:disabled),.actions #download:hover:not(:disabled) { background:#2f53d6; border-color:#2f53d6; }
    .toolbar { flex:none; padding:16px 16px 4px; background:#f4f7ff; border-bottom:1px solid #dce5e9; }
    .course-address { display:flex; align-items:stretch; gap:6px; margin-bottom:8px; }
    .input { flex:1; min-width:0; min-height:36px; padding:8px; background:#fff; border:1px solid #cbd7f3; border-radius:8px; color:#233354; }
    .input::placeholder { color:#9aa8b1; }
    #current { flex:none; white-space:nowrap; font-size:12px; padding:6px 10px; background:#eef0ff; border-color:#d6d4ff; color:#6447cf; }
    #current:hover:not(:disabled) { background:#e3ddff; border-color:#ac9be9; }
    .status { white-space:pre-wrap; max-height:6.4em; overflow:auto; color:#65759a; font-size:11px; line-height:1.6; }
    #course-title { display:block; margin:9px 0 0; color:#253c72; font-size:15px; font-weight:650; }
    .actions { justify-content:space-between; gap:10px; margin-top:6px; padding-top:4px; border-top:1px solid #e7edf1; }
    .select-tools { display:flex; align-items:center; gap:4px; flex-wrap:wrap; }
    .actions button { padding:6px 9px; font-size:12px; }
    .actions .quiet { border-color:transparent; background:transparent; color:#526aa5; padding:6px; }
    .actions .quiet:hover:not(:disabled) { background:#e9efff; color:#2e51ae; border-color:transparent; }
    .actions #download { padding:7px 12px; }
    #list { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:0 16px 12px; }
    .item { padding:12px 2px; border-bottom:1px solid #edf1f4; }
    .item>.row { min-height:32px; flex-wrap:nowrap; }
    .item label { flex:1; display:flex; align-items:center; gap:7px; min-width:0; }
    .item input { flex:none; width:15px; height:15px; margin:0; accent-color:#4169ef; }
    .lesson-week { flex:none; font-weight:650; color:#253c72; white-space:nowrap; }
    .lesson-line { min-width:0; overflow-x:auto; white-space:nowrap; color:#65759a; font-size:11px; scrollbar-width:thin; }
    .lesson-line .divider { color:#d4dce2; margin:0 7px; }
    .item>.row>button,.item>.row>.badge { flex:none; }
    .item button { padding:5px 8px; font-size:12px; color:#6846c6; background:#f0eaff; border-color:#d9ccfa; }
    .item button:hover:not(:disabled) { background:#e6daff; border-color:#bda6ed; }
    .badge { font-size:10px; background:#edf0f8; color:#7884a0; border-radius:12px; padding:2px 7px; white-space:nowrap; }
    .viewer { left:16px; right:572px; top:24px; bottom:80px; max-width:800px; }
    .viewer-head { flex:none; padding:12px 14px; border-bottom:1px solid #dce5e9; background:#f4f7ff; }
    .viewer-head strong { flex:1; overflow-wrap:anywhere; }
    #detail { flex:1; min-height:0; overflow:auto; padding:0 14px 14px; overscroll-behavior:contain; }
    video { width:100%; max-height:340px; background:#111; margin:8px 0; }
    .card { padding:12px 0; border-bottom:1px solid #e2e9ec; }
    .icon-button { width:30px; height:30px; min-height:30px; padding:0; border:0; background:transparent; color:#8a99a4; font-size:20px; border-radius:7px; }
    .icon-button:hover:not(:disabled) { background:#edf1f4; border:0; color:#405563; }
    .task-window .viewer-head { padding:8px 14px; background:#eaf0ff; border-color:#d7e1fa; color:#294a9a; }
    #progress { flex:1; min-height:0; overflow:auto; padding:4px 14px; background:#fafbff; }
    #task-message { flex:none; padding:0 14px; font-size:11px; line-height:1.6; max-height:6.4em; overflow:auto; white-space:pre-wrap; }
    .progress-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color:#425783; }
    .task-row { position:relative; height:64px; padding:6px 0; border-bottom:1px solid #e0e7f7; }
    .task-row[data-status=running] .progress-name { color:#315cd7; }
    .task-row[data-status=paused] .progress-name { color:#9b6318; }
    .task-row[data-status=done] .progress-name { color:#23815d; }
    .task-row[data-status=failed] .progress-name { color:#c54159; }
    .task-controls { display:flex; gap:5px; flex:none; }
    .task-controls button { width:30px; padding:0; background:#edf2ff; border-color:#d3defb; color:#4169df; }
    .task-controls button:hover:not(:disabled) { background:#dfe8ff; border-color:#a6bdf7; }
    .task-controls .cancel-task,#cancel { background:#fff0f2; border-color:#f5ccd4; color:#d24760; }
    .task-controls .cancel-task:hover:not(:disabled),#cancel:hover:not(:disabled) { background:#ffe0e6; border-color:#efa5b4; }
    #cancel { font-size:11px; min-height:28px; padding:4px 8px; }
    .drag-handle { flex:none; width:22px; min-height:28px; padding:0; border:0; background:transparent; color:#8a73cb; cursor:grab; }
    .drag-handle:active { cursor:grabbing; }
    .drag-handle svg { width:16px; height:16px; }
    .drag-handle:hover:not(:disabled) { color:#6744bb; background:#eee7ff; border:0; }
    .task-row progress { display:block; width:100%; margin:5px 0 0; appearance:none; -webkit-appearance:none; height:12px; border:0; border-radius:6px; overflow:hidden; background:#e4eafa; accent-color:#4978f5; }
    .task-row progress::-webkit-progress-bar { background:#e4eafa; border-radius:6px; }
    .task-row progress::-webkit-progress-value { background:linear-gradient(90deg,#6587ff,#398af5); border-radius:6px; }
    .task-row progress::-moz-progress-bar { background:#4978f5; }
    .task-row[data-status=paused] progress::-webkit-progress-value { background:#e6b24f; }
    .task-row[data-status=done] progress::-webkit-progress-value { background:#36b685; }
    .task-row[data-status=failed] progress::-webkit-progress-value { background:#e96a80; }
    .task-row.drop-before:before,.task-row.drop-after:after { content:''; position:absolute; left:0; right:0; height:5px; border-radius:2px; background:#ff8737; box-shadow:0 0 0 1px #fff,0 2px 7px #ff87374d; pointer-events:none; z-index:1; }
    .task-row.drop-before:before { top:-2px; }
    .task-row.drop-after:after { bottom:-2px; }
    @media(max-width:1000px) { .viewer { right:16px; max-width:none; } .panel { z-index:2147483646; } }
    </style><button class="launch" aria-label="下载" title="下载"><svg class="button-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 14h10"/></svg></button><section class="panel" hidden>
    <div class="toolbar"><div class="course-address"><input class="input" id="course" aria-label="课程网址或内部编号" placeholder="输入课程网址或编号，回车查询"><button id="current">当前课程</button></div>
    <div class="status" role="status">回车查询课程。</div><strong id="course-title" hidden></strong>
    <div class="row actions"><div class="select-tools"><button id="all" class="quiet" title="全选可用录课">全选</button><button id="none" class="quiet">清空选择</button></div><button id="download">下载</button></div>
    </div><div id="list"></div></section>
    <section class="task-window" id="task-window" hidden><div class="viewer-head row"><strong>下载任务</strong><button id="cancel">取消全部</button></div><div id="progress"  aria-label="下载进度">暂无下载任务。</div><span id="task-message" class="muted" role="status"></span></section>
    <section class="viewer" hidden><div class="viewer-head row"><strong id="video-title">视频查看</strong><button id="video-close" class="icon-button" title="关闭视频" aria-label="关闭视频">×</button></div><div id="detail"></div></section>`;
  const q = s => root.querySelector(s), status = q('.status'), input = q('#course'), list = q('#list'), detail = q('#detail');
  let rows = [], loadedId = '', busy = false, revision = 0;
  const textNode = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
  function idFrom(value) {
    if (/^\d+$/.test(value.trim())) return value.trim();
    const url = new URL(value);
    if (url.origin !== 'https://v.ustc.edu.cn') throw new Error('请输入课程编号或录课网站的“我的课程”网址。');
    const id = url.pathname.match(/^\/my-capture-courses\/(\d+)(?:\/|$)/)?.[1];
    if (!id) throw new Error('请输入课程内部编号，如 18370。');
    return id;
  }
  function stopPlayers() { detail.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); }); detail.replaceChildren(); q('.viewer').hidden=true; }
  q('#video-close').onclick=()=>{revision++;stopPlayers();};
  async function showLesson(lesson) {
    if(busy)return;const epoch=++revision;status.textContent='正在获取视频信息…';
    try {
      const result=await detailFor(loadedId,lesson);if(epoch!==revision)return;
      stopPlayers();const videos=videosFor(result);let count=0;
      for(const v of videos) {
        const url=safeVideo(v.play_url);if(!url)continue;
        const card=textNode('div',v.label==='INSTRUCTOR'?'教师画面':v.label==='ENCODER'?'电脑录屏':'视频');card.className='card';
        const player=document.createElement('video');player.controls=true;player.preload='none';player.src=url;
        player.onerror=()=>status.textContent='地址失效，请重新预览。';
        player.onplay=()=>detail.querySelectorAll('video').forEach(other=>{if(other!==player)other.pause();});
        card.append(player);detail.append(card);count++;
      }
      if(!count)throw new Error('这堂课暂无可播放视频。');
      q('#video-title').textContent=`${lesson.date} · ${lesson.name}`;q('.viewer').hidden=false;
      status.textContent='预览已打开。';
    }catch(e){if(epoch===revision)status.textContent=e.message;}
  }
  function fromCurrent() { input.value = location.href; }
  fromCurrent();
  q('.launch').onclick = () => {
    q('.panel').hidden=!q('.panel').hidden;
    q('#task-window').hidden=q('.panel').hidden;
    q('.launch').innerHTML=q('.panel').hidden?'<svg class="button-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 14h10"/></svg>':'<svg class="button-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
    q('.launch').setAttribute('aria-label',q('.panel').hidden?'下载':'收起');q('.launch').title=q('.panel').hidden?'下载':'收起';
    if(q('.panel').hidden){revision++;stopPlayers();clearInterval(progressTimer);progressTimer=undefined;}else startProgress();
  };
  q('#current').onclick = () => {fromCurrent();loadCourse();};
  input.onkeydown=event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();input.blur();loadCourse();}};
  function setBusy(value) { busy = value; for (const b of root.querySelectorAll('#current,#download,#all,#none')) b.disabled = value; list.querySelectorAll('input').forEach(c => c.disabled = value || !rows[Number(c.dataset.index)].published); }
  async function loadCourse() {
    if (busy) return; setBusy(true); const version = ++revision; stopPlayers(); list.replaceChildren(); rows = []; loadedId = '';q('#course-title').hidden=true;
    try {
      const id = idFrom(input.value); status.textContent = '正在获取目录…';
      const result = await siteApi(`${coursePath(id)}/schedules?in_course_preview=false`); if(version !== revision) return;
      const items = Array.isArray(result)?result:result?.items;
      if(!Array.isArray(items)) throw new Error('课程目录格式发生变化。');
      const course=items.find(r=>!r.deleted)?.course;
      q('#course-title').textContent=`${course?.name||items[0]?.name||'课程'}${course?.code?'（'+course.code+'）':''}`;q('#course-title').hidden=false;
      loadedId = id; rows = items.filter(r=>!r.deleted).map(normalizeLesson).sort((a,b)=>`${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
      rows.forEach((lesson, index) => {
        const item = textNode('div',''); item.className = 'item';
        const top = textNode('div',''); top.className = 'row';
        const label = textNode('label',''), check = document.createElement('input'); check.type = 'checkbox'; check.dataset.index = index; check.disabled = !lesson.published;
        const week = textNode('span', `week ${lesson.week??'—'}`);week.className='lesson-week';
        label.append(check,week);top.append(label);item.append(top);
        if(!lesson.published){const badge=textNode('span','暂无录课');badge.className='badge unpublished';top.append(badge);}
        const meta = textNode('span',''); meta.className = 'lesson-line';
        let day = ''; const dateValue = new Date(`${lesson.date}T12:00:00+08:00`);
        if(!Number.isNaN(dateValue.valueOf())) day = new Intl.DateTimeFormat('en-US',{weekday:'short',timeZone:'Asia/Shanghai'}).format(dateValue);
        const seconds = Number(lesson.durationSeconds);
        const duration = Number.isFinite(seconds) && seconds > 0 ? `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}` : '';
        const parts=[lesson.slots?`slot ${lesson.slots}`:'',`${lesson.date.replace(/-/g,'.')} ${day}${lesson.startTime&&lesson.endTime?' '+lesson.startTime+' - '+lesson.endTime:''}`.trim(),duration,lesson.classroom].filter(Boolean);
        parts.forEach((value,index)=>{if(index){const divider=textNode('span','|');divider.className='divider';meta.append(divider);}meta.append(textNode('span',value));});
        meta.title=parts.join(' | ');label.append(meta);
        if (lesson.published) {
          const view = textNode('button','预览');
          view.onclick = () => showLesson(lesson);
          top.append(view);
        }
        list.append(item);
      });
      status.textContent = `${rows.filter(r=>r.published).length} 堂可用录课。`;
    } catch(e) {status.textContent = e.message;} finally {setBusy(false);}
  }
  q('#all').onclick = () => {list.querySelectorAll('input:not(:disabled)').forEach(c=>c.checked=true);};
  q('#none').onclick = () => {list.querySelectorAll('input').forEach(c=>c.checked=false);};
  q('#download').onclick = async () => {
    if(busy) return;
    const selected = [...list.querySelectorAll('input:checked')].map(c=>rows[Number(c.dataset.index)]);
    if(!selected.length) {status.textContent='请先勾选录课。';return;}
    setBusy(true); status.textContent='正在提交…';
    try {
      await api('/health'); const tasks=[],skipped=[];
      for(let i=0;i<selected.length;i++) {
        const lesson=selected[i];status.textContent=`获取视频 ${i+1}/${selected.length}…`;
        try {
          const d=await detailFor(loadedId,lesson);
          let count=0;
          for(const v of videosFor(d)) {
            const url=safeVideo(v.download_url)||safeVideo(v.play_url);if(!url)continue;
            tasks.push({courseId:loadedId,lessonId:lesson.id,videoId:String(v.id),week:lesson.week,title:lesson.name,date:lesson.date,label:v.label,url,size:Number(v.size)||0,downloadAllowed:true});count++;
          }
          if(!count)skipped.push(`${lesson.date}：没有可用视频地址`);
        }catch{skipped.push(`${lesson.date}：获取详情失败`);}
      }
      if(!tasks.length){status.textContent=`没有可提交的下载任务。\n${skipped.join('\n')}`;return;}
      const result=await api('/jobs',{tasks});status.textContent=`任务已接收，可以关闭网页。${result.skipped?.length?'\n跳过重名：\n'+result.skipped.join('\n'):''}${skipped.length?'\n未提交：\n'+skipped.join('\n'):''}`;if(!q('.panel').hidden)startProgress();
    }
    catch(e){status.textContent=e.message;} finally{setBusy(false);}
  };
  let progressTimer, progressLoading=false;
  let draggedTask;
  const clearDropMarks=()=>q('#progress').querySelectorAll('.drop-before,.drop-after').forEach(item=>item.classList.remove('drop-before','drop-after'));
  const controlTask=async(id,action,before)=>{
    try{await api('/jobs/control',{id,action,before});q('#task-message').textContent='';await refreshProgress();}
    catch(e){q('#task-message').textContent=e.message;}
  };
  const refreshProgress = async () => {
    if(progressLoading)return;progressLoading=true;
    const footer=q('#progress');footer.hidden=false;
    try {
      const result=await api('/jobs');footer.replaceChildren();
      if(!result.tasks.length)footer.append(textNode('div','暂无下载任务。'));
      for(const task of result.tasks){
        const ratio=task.status==='done'?1:task.total>0?Math.min(1,task.bytes/task.total):0;
        const label=textNode('div',`${task.name}：${({queued:'排队中',running:'下载中',done:'已完成',failed:'失败',cancelled:'已取消',paused:'已暂停'})[task.status]}${task.total>0?' '+(ratio*100).toFixed(1)+'%':''}`);label.className='progress-name';label.title=label.textContent;
        const bar=document.createElement('progress');bar.max=1;bar.setAttribute('aria-label',task.name);
        if(task.status!=='running'||task.total>0)bar.value=ratio;
        const item=textNode('div','');item.className='task-row';item.dataset.taskId=task.id;item.dataset.status=task.status;
        const handle=textNode('button','');handle.className='drag-handle';handle.draggable=true;handle.title='拖动排序';handle.setAttribute('aria-label','拖动排序');handle.innerHTML='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/></svg>';
        handle.ondragstart=event=>{draggedTask=task.id;event.dataTransfer.setData('text/plain',task.id);event.dataTransfer.effectAllowed='move';event.dataTransfer.setDragImage(item,12,20);};
        handle.ondragend=()=>{draggedTask=undefined;clearDropMarks();};
        item.ondragover=event=>{if(!draggedTask)return;event.preventDefault();clearDropMarks();if(draggedTask!==task.id)item.classList.add(event.clientY<item.getBoundingClientRect().top+item.offsetHeight/2?'drop-before':'drop-after');};
        item.ondragleave=event=>{if(!item.contains(event.relatedTarget))item.classList.remove('drop-before','drop-after');};
        item.ondrop=event=>{event.preventDefault();const id=draggedTask,before=item.classList.contains('drop-after')?item.nextElementSibling?.dataset.taskId||null:task.id;draggedTask=undefined;clearDropMarks();if(id&&id!==task.id&&id!==before)controlTask(id,'move',before);};
        const top=textNode('div','');top.className='row';const controls=textNode('div','');controls.className='task-controls';
        const toggle=textNode('button','');toggle.innerHTML=['queued','running'].includes(task.status)?'<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx=".5"/><rect x="9" y="3" width="3" height="10" rx=".5"/></svg>':'<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3v10l8-5z"/></svg>';toggle.title=['queued','running'].includes(task.status)?'暂停':'开始';toggle.setAttribute('aria-label',toggle.title);toggle.disabled=task.status==='done';toggle.onclick=()=>controlTask(task.id,['queued','running'].includes(task.status)?'pause':'resume');
        const cancel=textNode('button','×');cancel.className='cancel-task';cancel.title=task.status==='done'?'删去该项':'取消任务';cancel.setAttribute('aria-label',cancel.title);cancel.disabled=task.status==='cancelled';cancel.onclick=()=>controlTask(task.id,'cancel');
        controls.append(toggle,cancel);top.append(handle,label,controls);item.append(top,bar);footer.append(item);
      }
    }catch(e){footer.replaceChildren(textNode('div',e.message));}finally{progressLoading=false;}
  };
  const startProgress = () => {if(!progressTimer)progressTimer=setInterval(()=>{if(!draggedTask)refreshProgress();},3000);refreshProgress();};
  q('#cancel').onclick = async () => {
    const button=q('#cancel');button.disabled=true;
    try{await api('/jobs/cancel',{});status.textContent='已取消。';await refreshProgress();}
    catch(e){status.textContent=e.message;}finally{button.disabled=false;}
  };
})();
