// Offline regressions for navigation races and polling; no real browser, API or model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
const busyStates = new Set(['queued','processing','feedback_queued','feedbacking','cropping','locating','judging']);
const drain = () => new Promise(resolve => setImmediate(resolve));

function functionSource(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `actual function ${name} must exist`);
  const lineEnd = source.indexOf('\n', match.index);
  const end = source.slice(match.index, lineEnd).trimEnd().endsWith('}') ? lineEnd : source.indexOf('\n}', lineEnd)+2;
  assert.ok(end > match.index, `actual function ${name} must end`);
  return source.slice(match.index, end);
}
function job(id, revision=5, updated=revision) {
  return {id, revision, updated, status:'review', feedback_revision:revision, reviewed:true,
    feedback:'已保存回复', teacher_notes:'', photos:[], materials:[], calls:[], evidence:[],
    result:{questions:[{number:'1',page:1,question:`${id} 的题目`,student_answer:'5',status:'correct'}],observations:[],warnings:[]}};
}
function harness() {
  const state={route:'#queue',csrf:'offline-csrf',generation:0,authEpoch:0,pollInFlight:false,listRequest:0,filter:'pending',page:1,total:0,counts:{},
    job:null,jobs:[],students:[],dirty:false,feedbackDirty:false,actionPending:false,uploading:false,
    files:[],originals:[],submission:null,authDraft:null,conflictDraft:null};
  const nodes=new Map();
  const node=selector=>{
    if(selector==='dialog[open]')return [...nodes.values()].find(value=>value.open)||null;
    if(!nodes.has(selector))nodes.set(selector,{value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,
      checked:true,open:false,dataset:{},classList:{toggle(){},remove(){},add(){}},
      close(){this.open=false;},focus(){},setAttribute(){},querySelectorAll(){return [];}});
    return nodes.get(selector);
  };
  const field=node('question-field');field.dataset.field='question';
  const card={dataset:{question:'0'},querySelectorAll:()=>[field]};
  const requests=[],rendered=[],messages=[];
  let implementation=async()=>{throw new Error('unexpected offline request');},fetchImplementation=async()=>{throw new Error('unexpected offline fetch');};
  const context=vm.createContext({state,busyStates,structuredClone,AbortController,FormData,URLSearchParams,setTimeout,clearTimeout,
    fetch:(url,options)=>fetchImplementation(url,options),
    document:{hidden:false},location:{hash:'#queue'},window:{scrollTo(){}},
    $:node,$$:selector=>selector==='[data-question]'?[card]:[],confirm:()=>true,
    toast:message=>messages.push(message),showLogin(){node('#login-screen').hidden=false;},
    updateReviewActions(){},loadJobs:async()=>{},loadStudents:async()=>{},
    renderReview(){rendered.push({id:state.job.id,revision:state.job.revision});
      node('#review-view').innerHTML=state.job.id;node('#review-view').dataset.jobId=state.job.id;
      field.value=state.job.result.questions[0].question;
      node('#feedback').value=state.job.feedback;node('#teacher-notes').value=state.job.teacher_notes;
      node('#observations').value=state.job.result.observations.join('\n');node('#warnings').value=state.job.result.warnings.join('\n');},
    api:async(route,options={})=>{const request={route,options,body:options.body?JSON.parse(options.body):undefined};requests.push(request);return implementation(request);}});
  for(const name of ['requestContext','contextCurrent','applyJob','snapshotReview','expireSession','restoreDraft','collectReview','saveReview','route','costText','processingHTML','updateProcessingProgress','poll'])
    vm.runInContext(functionSource(name),context);
  return {state,node,field,requests,rendered,messages,context,setAPI:fn=>implementation=fn,setFetch:fn=>fetchImplementation=fn};
}

async function main() {
  const cost=harness().context.costText;
  const call=(min,max=min)=>({pricing:{min,max,currency:'CNY'}});
  assert.equal(cost([call(.0008,.0016)]),'估算 低于¥0.01');
  assert.equal(cost([call(.023,.047)]),'估算 ¥0.02–¥0.05');
  assert.equal(cost([call(.023,.024)]),'估算 ¥0.02');
  assert.equal(cost([call(0)]),'估算 ¥0.00');
  assert.equal(cost([call(.006),call(.006)]),'估算 ¥0.01','sum before rounding');
  assert.equal(cost([call(.02),{pricing:null}]),'估算 ¥0.02（部分调用）');
  assert.equal(cost([{pricing:null}]),'费用未估算');
  assert.equal(cost([]),'暂无调用');
  assert.equal(cost([call(.02),{pricing:{min:.02,max:.02,currency:'USD'}}]),'币种不同，见调用明细');
  // Complete B first, then A, and actually run the real saveReview() after the race.
  const h=harness();let resolveA,resolveB;
  h.setAPI(request=>request.options.method==='PUT'?Promise.resolve(job('B',6)):
    new Promise(resolve=>{if(request.route.endsWith('/A'))resolveA=resolve;else resolveB=resolve;}));
  h.context.location.hash='#review/A';const a=h.context.route();
  h.context.location.hash='#review/B';const b=h.context.route();
  resolveB(job('B'));await b;resolveA(job('A'));await a;
  assert.equal(h.state.job.id,'B');assert.equal(h.node('#review-view').innerHTML,'B');
  h.field.value='老师修改的 B 题目';h.state.dirty=true;
  await h.context.saveReview();
  assert.equal(h.requests.at(-1).route,'/api/jobs/B/review');
  assert.equal(h.requests.at(-1).body.result.questions[0].question,'老师修改的 B 题目');
  assert.equal(h.requests.at(-1).body.revision,5);

  // An ID-only guard misses A -> B -> A: the first A belongs to an older generation.
  const again=harness(),resolvers=[];
  again.setAPI(()=>new Promise(resolve=>resolvers.push(resolve)));
  again.context.location.hash='#review/A';const oldA=again.context.route();
  again.context.location.hash='#review/B';const middle=again.context.route();
  again.context.location.hash='#review/A';const newA=again.context.route();
  resolvers[2](job('A',7));await newA;resolvers[1](job('B',6));await middle;resolvers[0](job('A',5));await oldA;
  assert.equal(again.state.job.id,'A');assert.equal(again.state.job.revision,7);
  assert.deepEqual(again.rendered.map(value=>value.revision),[7]);

  // Timers and foreground refresh must share a single flight.
  const polling=harness();let release;
  polling.state.route='#review/A';polling.context.location.hash=polling.state.route;polling.state.job=job('A',5,10);
  polling.setAPI(()=>new Promise(resolve=>release=resolve));
  const first=polling.context.poll();await drain();
  await polling.context.poll();assert.equal(polling.requests.length,1);
  release(job('A',6,20));await first;assert.equal(polling.state.job.revision,6);
  assert.equal(polling.state.pollInFlight,false);
  polling.setAPI(async()=>job('A',5,30));await polling.context.poll();assert.equal(polling.state.job.revision,6);
  polling.setAPI(async()=>job('A',6,15));await polling.context.poll();assert.equal(polling.state.job.updated,20);

  for(const protection of ['dirty','feedbackDirty','dialog']) {
    let complete;polling.setAPI(()=>new Promise(resolve=>complete=resolve));
    const pending=polling.context.poll();await drain();
    if(protection==='dialog')polling.node('#image-dialog').open=true;else polling.state[protection]=true;
    complete(job('A',8,40));await pending;assert.equal(polling.state.job.revision,6,protection+' must protect editing');
    if(protection==='dialog')polling.node('#image-dialog').open=false;else polling.state[protection]=false;
  }
  polling.setAPI(async()=>{throw new Error('offline read failure');});await polling.context.poll();
  assert.equal(polling.state.pollInFlight,false);
  polling.setAPI(async()=>job('A',9,50));await polling.context.poll();assert.equal(polling.state.job.revision,9);

  polling.state.job.status='judging';polling.state.feedbackDirty=true;polling.node('#feedback').value='超时等待中保留的手动回复';
  polling.setAPI(async()=>job('A',10,60));await polling.context.poll();
  assert.equal(polling.state.job.status,'review');assert.equal(polling.state.job.revision,10);
  assert.equal(polling.node('#feedback').value,'超时等待中保留的手动回复');assert.equal(polling.state.feedbackDirty,true);

  // A live single-page model request has stage/time, never a made-up percentage.
  const progress=harness(),now=Date.now()/1000;
  progress.state.job={...job('P'),status:'processing',created:now-80,photos:[{page:1,recognized:false}],progress:{stage:'grading',page:1,started_at:now-70,stage_started_at:now-65}};
  progress.state.route='#review/P';
  progress.context.updateProcessingProgress();
  assert.match(progress.node('#processing-title').textContent,/识别与批改.*第 1 \/ 1 张/);
  assert.match(progress.node('#processing-time').textContent,/已等待 1 分/);
  assert.match(progress.node('#processing-detail').textContent,/模型尚未返回/);
  assert.doesNotMatch(progress.context.processingHTML(progress.state.job),/<progress|\d+%/);
  const multi={...progress.state.job,photos:[{page:1,recognized:true},{page:2,recognized:false}]};
  assert.match(progress.context.processingHTML(multi),/<progress max="2" value="1"/);
  const activeProgress=structuredClone(progress.state.job);
  progress.state.job={...activeProgress,status:'queued',created:now-3600,updated:now-5,progress:null};
  progress.context.updateProcessingProgress();
  assert.match(progress.node('#processing-title').textContent,/等待开始批改/);
  assert.doesNotMatch(progress.node('#processing-time').textContent,/分/,'retry queue time starts at the retry, not the original upload');
  progress.state.job=activeProgress;
  const messagesBefore=progress.messages.length;
  progress.setAPI(async()=>{throw new Error('offline');});await progress.context.poll();
  assert.equal(progress.node('#processing-connection').hidden,false);
  assert.match(progress.node('#processing-title').textContent,/上次状态/);
  assert.equal(progress.messages.length,messagesBefore,'connection warning should stay on the card, not toast repeatedly');
  progress.setAPI(async()=>structuredClone(progress.state.job));await progress.context.poll();
  assert.equal(progress.node('#processing-connection').hidden,true);
  assert.doesNotMatch(progress.node('#processing-title').textContent,/上次状态/);
  progress.state.progressCheck.checkedAt=Date.now()-20000;
  progress.node('#image-dialog').open=true;
  const pausedRequests=progress.requests.length;
  await progress.context.poll();progress.context.updateProcessingProgress();
  assert.equal(progress.requests.length,pausedRequests,'image viewing intentionally pauses polling');
  assert.equal(progress.node('#processing-connection').hidden,true,'paused polling is not a connection failure');
  progress.node('#image-dialog').open=false;
  await progress.context.poll();assert.equal(progress.requests.length,pausedRequests+1);
  progress.state.job.status='review';assert.equal(progress.context.processingHTML(progress.state.job),'');
  const previousTime=progress.node('#processing-time').textContent;
  progress.context.updateProcessingProgress();assert.equal(progress.node('#processing-time').textContent,previousTime,'finished job must stop its timer');

  // Keep all edit fields only in memory when authentication expires.
  const auth=harness();auth.state.job=job('A');auth.state.route='#review/A';auth.context.location.hash=auth.state.route;
  auth.context.renderReview();auth.field.value='未保存的题目';auth.node('#teacher-notes').value='老师的草稿备注';
  auth.node('#feedback').value='老师还没保存的回复';auth.node('#observations').value='草稿观察';
  auth.state.dirty=true;auth.state.feedbackDirty=true;
  const originalFile={file:new File(['offline photo'],'photo.jpg'),source:0,sourcePage:2};
  auth.state.files.push(originalFile);auth.state.submission={key:'same-offline-key'};
  const before=auth.context.requestContext();auth.context.expireSession(before);
  assert.equal(auth.state.csrf,'');assert.equal(auth.state.authDraft.result.questions[0].question,'未保存的题目');
  assert.equal(auth.state.authDraft.teacher_notes,'老师的草稿备注');
  assert.equal(auth.state.authDraft.feedback,'老师还没保存的回复');
  assert.equal(auth.state.files[0],originalFile);assert.equal(auth.state.submission.key,'same-offline-key');
  const savedEpoch=auth.state.authEpoch;auth.state.csrf='new-session';auth.context.expireSession(before);
  assert.equal(auth.state.csrf,'new-session');assert.equal(auth.state.authEpoch,savedEpoch,'old 401 must not expire a new session');
  auth.setAPI(async()=>job('A'));await auth.context.route(true);
  assert.equal(auth.state.job.result.questions[0].question,'未保存的题目');
  assert.equal(auth.node('#feedback').value,'老师还没保存的回复');
  assert.equal(auth.state.dirty,true);assert.equal(auth.state.feedbackDirty,true);assert.equal(auth.state.authDraft,null);

  const oldDraft=structuredClone(auth.context.snapshotReview());auth.state.authDraft=oldDraft;
  auth.state.dirty=false;auth.state.feedbackDirty=false;auth.setAPI(async()=>job('A',7));await auth.context.route(true);
  assert.equal(auth.state.job.revision,7);assert.equal(auth.state.job.result.questions[0].question,'A 的题目');
  assert.equal(auth.state.conflictDraft.result.questions[0].question,'未保存的题目');
  assert.equal(auth.state.dirty,false,'an old draft must not be silently attached to a new server revision');

  const realAuth=harness();realAuth.state.job=job('A');realAuth.state.route='#review/A';realAuth.context.renderReview();
  realAuth.field.value='401 时仍保留的题目';realAuth.state.dirty=true;
  vm.runInContext(functionSource('apiErrorMessage'),realAuth.context);
  vm.runInContext(functionSource('api'),realAuth.context);
  let late401;realAuth.setFetch(()=>new Promise(resolve=>late401=resolve));
  const oldRequest=realAuth.context.api('/api/students'),oldRejected=assert.rejects(oldRequest,/请先登录/);
  realAuth.state.authEpoch++;realAuth.state.generation++;realAuth.state.csrf='fresh-offline-session';
  late401({ok:false,status:401,json:async()=>({detail:'请先登录'})});await oldRejected;
  assert.equal(realAuth.state.csrf,'fresh-offline-session','actual API must ignore a late old-session 401');
  let lateSuccess;realAuth.setFetch(()=>new Promise(resolve=>lateSuccess=resolve));
  const previousUser=realAuth.context.api('/api/students'),previousRejected=assert.rejects(previousUser,/账号已变化/);
  realAuth.state.authEpoch++;
  lateSuccess({ok:true,status:200,json:async()=>[{name:'previous account private student'}]});await previousRejected;
  realAuth.setFetch(async()=>({ok:false,status:401,json:async()=>({detail:'请先登录'})}));
  await assert.rejects(realAuth.context.api('/api/students'),/请先登录/);
  assert.equal(realAuth.state.csrf,'');assert.equal(realAuth.state.authDraft.result.questions[0].question,'401 时仍保留的题目');

  // FastAPI returns validation details as an array; never show submitted text or note keys.
  realAuth.state.csrf='offline-session';realAuth.state.dirty=true;
  const invalid=details=>realAuth.setFetch(async()=>({ok:false,status:422,json:async()=>({detail:details})}));
  invalid([{type:'extra_forbidden',loc:['body','result','note_links','warning:private-note','superseded'],input:true}]);
  await assert.rejects(realAuth.context.api('/api/jobs/A/review',{method:'PUT',body:'{}'}),error=>{
    assert.equal(error.status,422);assert.match(error.message,/重启本机服务/);assert.match(error.message,/尚未保存/);assert.ok(!error.message.includes('private-note'));return true;
  });
  assert.equal(realAuth.state.dirty,true,'failed validation must preserve the draft');
  invalid([{type:'string_too_long',loc:['body','result','questions',1,'student_answer'],ctx:{max_length:3000},input:'private-answer'}]);
  await assert.rejects(realAuth.context.api('/api/jobs/A/review'),/第2个题目：孩子的实际作答不能超过3000个字符/);
  invalid([{type:'missing',loc:['body','teacher_notes']}]);
  await assert.rejects(realAuth.context.api('/api/jobs/A/review'),/老师补充缺失/);
  invalid([{type:'literal_error',loc:['body','result','questions',0,'status'],input:'private-answer'}]);
  await assert.rejects(realAuth.context.api('/api/jobs/A/review'),/第1个题目：判定未通过校验/);
  invalid([null]);await assert.rejects(realAuth.context.api('/api/jobs/A/review'),/提交内容未通过校验/);
  invalid([]);await assert.rejects(realAuth.context.api('/api/jobs/A/review'),/提交未成功/);

  const listing=harness(),listResolvers=[];let listRender=0;
  listing.context.renderJobs=()=>listRender++;
  vm.runInContext(functionSource('loadJobs'),listing.context);
  listing.setAPI(()=>new Promise(resolve=>listResolvers.push(resolve)));
  const oldList=listing.context.loadJobs();listing.state.filter='confirmed';const newList=listing.context.loadJobs();
  listResolvers[1]({items:[{id:'latest-list'}],total:1,counts:{confirmed_today:1}});await newList;
  listResolvers[0]({items:[{id:'stale-list'}],total:1,counts:{needs_attention:1}});await oldList;
  assert.equal(listing.state.jobs[0].id,'latest-list');assert.equal(listRender,1);
  const leaving=listing.context.loadJobs();listing.state.generation++;
  listResolvers[2]({items:[{id:'late-after-navigation'}],total:1,counts:{}});await leaving;
  assert.equal(listing.state.jobs[0].id,'latest-list');assert.equal(listRender,1);
  console.log('Navigation races, actual save target, single-flight polling, edit guards and in-memory reauthentication drafts: OK');
}
const deadline=setTimeout(()=>{console.error('Navigation regression did not finish; a request or lock remained pending.');process.exit(1);},10000);
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(deadline));
