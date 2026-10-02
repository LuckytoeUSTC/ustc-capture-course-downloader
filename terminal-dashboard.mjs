import fs from 'node:fs';

export function createTerminalDashboard(getState) {
  let displayReady=false;
  const messages=[];
  let renderScheduled=false,outputBlocked=false,lastFrame='';
  const sizeText=size=>`${(size/1048576).toFixed(1)} MB`;
  const width=text=>[...String(text)].reduce((sum,char)=>sum+(char.codePointAt(0)>255?2:1),0);
  const fit=(text,length)=>{let result='';for(const char of String(text).replace(/[\x00-\x1f\x7f]/g,' ')){if(width(result+char)>length-1){result+='…';break;}result+=char;}return result+' '.repeat(Math.max(0,length-width(result)));};
  function render(){
    if(!displayReady||!process.stdout.isTTY||renderScheduled||outputBlocked)return;
    renderScheduled=true;setImmediate(()=>{renderScheduled=false;paint();});
  }
  function paint(){
    const {tasks,progress}=getState();
    if(outputBlocked)return;
    const visible=tasks.filter(t=>t.status!=='cancelled'),cols=Math.max(2,process.stdout.columns||120),nameWidth=Math.max(1,cols-30),rows=Math.max(2,process.stdout.rows||30);
    const lines=['下载服务已启动','1～9 取消对应任务；0 取消全部；Ctrl+C 退出服务。','',`下载任务  总大小：${sizeText(visible.reduce((sum,t)=>sum+Math.max(0,t.size),0))}${visible.some(t=>!t.size)?'（部分未知）':''}`,`${fit('序号',6)}${fit('文件',nameWidth)}${fit('大小',14)}状态`];
    const limit=Math.max(0,rows-16);
    visible.slice(0,limit).forEach((task,index)=>lines.push(`${fit(index+1,6)}${fit(task.name,nameWidth)}${fit(task.size>0?sizeText(task.size):'未知',14)}${({queued:'排队',running:'下载',paused:'暂停',done:'完成',failed:'错误'})[task.status]||task.status}`));
    if(visible.length>limit)lines.push(`另有 ${visible.length-limit} 项，放大窗口或在网页查看。`);
    lines.push('');
    for(const running of visible.filter(t=>t.status==='running')){const p=progress.get(running.name)||{bytes:0,total:running.size},ratio=p.total?Math.min(1,p.bytes/p.total):0,filled=Math.floor(ratio*24);lines.push(`正在下载：${fit(running.name,cols-12).trimEnd()}`,`[${'='.repeat(filled)}${' '.repeat(24-filled)}] ${p.total?(ratio*100).toFixed(1)+'%':'下载中'} ${sizeText(p.bytes)}${p.total?' / '+sizeText(p.total):''}`);}
    if(messages.length)lines.push('');
    lines.push(...messages.slice(-3).map(message=>fit(message,cols-1).trimEnd()));
    const frame=lines.slice(0,rows-1).map(line=>fit(line,cols-1).trimEnd()).join('\r\n');
    if(frame===lastFrame)return;lastFrame=frame;
    if(!process.stdout.write('\x1b[H\x1b[2J'+frame)){
      outputBlocked=true;process.stdout.once('drain',()=>{outputBlocked=false;render();});
    }
  }
  const notify=message=>{messages.push(message);if(messages.length>3)messages.shift();render();};

  const restore=()=>{if(process.stdout.isTTY){try{fs.writeSync(process.stdout.fd,'\x1b[?25h\x1b[?1049l');}catch{}}};
  const start=()=>{
    displayReady=true;
    if(process.stdout.isTTY){process.stdout.write('\x1b[?1049h\x1b[?25l');process.once('exit',restore);}
    else console.log('下载服务已启动');
    process.stdout.on('resize',render);render();
  };
  const close=()=>{displayReady=false;process.stdout.removeListener('resize',render);restore();process.removeListener('exit',restore);};
  return {start,close,render,notify};
}
