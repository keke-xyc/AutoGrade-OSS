"use strict";
(() => {
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const escapeHTML = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const busyStates = new Set(["queued", "processing", "feedback_queued", "feedbacking", "cropping", "locating", "judging"]);
const labels = {queued:"等待批改",processing:"正在批改",review:"待复核",confirmed:"已确认",failed:"处理失败",feedback_queued:"等待生成回复",feedbacking:"正在生成回复",cropping:"局部识别中",locating:"重新定位中",judging:"文字判题中",correct:"正确",incorrect:"错误",blank:"未作答",uncertain:"无法判定"};
const regionSources = {teacher:'老师标记区域',ocr:'OCR 关联区域，需核对',model:'模型估计区域，需核对'};
const state = {user:null,csrf:"",students:[],jobs:[],filter:"pending",files:[],originals:[],submitKey:"",uploading:false,actionPending:false,job:null,dirty:false,feedbackDirty:false,apiConfigured:false,route:"",generation:0,authEpoch:0,pollInFlight:false,listRequest:0,page:1,total:0,counts:{},authDraft:null,conflictDraft:null,submission:null,uploadXHR:null,history:null,historyRequest:0};
const today = () => new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const badge = (status) => `<span class="badge ${escapeHTML(status)}">${escapeHTML(labels[status] || status)}</span>`;

function toast(message) {
  $("#toast").textContent = message; $("#toast").hidden = false;
  const bar=$('#review-view:not([hidden]) .review-actions');
  $('#toast').style.bottom=bar?`${Math.max(20,innerHeight-bar.getBoundingClientRect().top+12)}px`:'';
  clearTimeout(toast.timer); toast.timer = setTimeout(() => $("#toast").hidden = true, 4800);
}

function requestContext(jobId = state.job?.id) {
  return {generation:state.generation,authEpoch:state.authEpoch,jobId};
}
function contextCurrent(ctx, checkJob = true) {
  return ctx.generation===state.generation && ctx.authEpoch===state.authEpoch &&
    (!checkJob || (ctx.jobId===state.job?.id && state.route===`#review/${ctx.jobId}`));
}
function applyJob(job, ctx) {
  if(!contextCurrent(ctx,false)||state.route!==`#review/${job.id}`||ctx.jobId!==job.id)return false;
  if(state.job?.id===job.id && (job.revision<state.job.revision ||
    (job.revision===state.job.revision && job.updated<state.job.updated)))return false;
  state.job=job;return true;
}
function snapshotReview() {
  if(!state.job?.result || $('#review-view').dataset.jobId!==state.job.id)return null;
  return {jobId:state.job.id,...collectReview(),feedback:$('#feedback').value,dirty:state.dirty,feedbackDirty:state.feedbackDirty};
}
function expireSession(ctx = requestContext()) {
  if(ctx.authEpoch!==state.authEpoch)return;
  const hadSession=!!state.csrf;
  if(state.csrf && (state.dirty||state.feedbackDirty))state.authDraft=snapshotReview()||state.authDraft;
  state.csrf='';state.authEpoch++;state.generation++;state.actionPending=false;
  $$('dialog[open]').forEach(dialog=>dialog.close());
  showLogin();$('#login-error').textContent=hadSession?'登录已过期，请重新登录。当前页面的修改与已选照片已保留。':'';
}
function apiErrorMessage(detail) {
  if(typeof detail==='string')return detail;
  if(!Array.isArray(detail)||!detail.length)return '提交未成功，请稍后重试。';
  if(detail.some(e=>e?.type==='extra_forbidden'&&Array.isArray(e.loc)&&['superseded','image_notes'].includes(e.loc.at(-1))))
    return '服务不支持新版复核字段，请重启本机服务后刷新页面。当前修改尚未保存，请先记下修改内容。';
  const e=detail[0],loc=Array.isArray(e?.loc)?e.loc:[];
  const fields={question:'原题',student_answer:'孩子的实际作答',expected_answer:'参考答案',explanation:'依据与订正提示',knowledge_point:'知识点',teacher_notes:'老师补充',number:'题号',page:'页码',revision:'作业版本',status:'判定',observations:'照片观察',warnings:'识别疑问',bbox:'图片区域'};
  const field=fields[loc.at(-1)]||'提交内容',index=loc.indexOf('questions');
  const prefix=index>=0&&Number.isInteger(loc[index+1])?`第${loc[index+1]+1}个题目：`:'';
  if(e?.type==='string_too_long'&&Number.isInteger(e.ctx?.max_length))return `${prefix}${field}不能超过${e.ctx.max_length}个字符，请缩短后重试。`;
  if(e?.type==='missing')return `${prefix}${field}缺失，请补全后重试。`;
  if(e?.type==='extra_forbidden')return '提交包含服务不支持的字段，请确认服务已重启、页面已刷新。';
  return `${prefix}${field}未通过校验，请检查后重试。`;
}
async function api(path, options = {}) {
  const {context=requestContext(),timeout=(options.method&&options.method!=='GET'?30000:15000),...settings}=options;
  const headers = {...options.headers, "X-CSRF-Token": state.csrf};
  if(state.user && path!=="/api/login" && path!=="/api/me")headers["X-User-ID"]=state.user.user_id;
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try {
    const response = await fetch(path, {...settings,signal:controller.signal,headers,credentials:"same-origin"});
    const value = await response.json().catch(() => ({detail:"服务暂时无法响应"}));
    if (!response.ok) {
      if(response.status===401 && path!=="/api/login")expireSession(context);
      const error=new Error(apiErrorMessage(value.detail));error.status=response.status;throw error;
    }
    if(context.authEpoch!==state.authEpoch)throw new Error('账号已变化，请重新操作。');
    return value;
  } catch(error) {
    if(error.name==='AbortError')throw new Error('等待超时，修改已保留；服务可能已受理，请先刷新核对结果。');
    throw error;
  } finally {clearTimeout(timer);}
}
function restoreDraft(job) {
  const draft=state.authDraft;if(!draft||draft.jobId!==job.id)return;
  state.authDraft=null;
  if(draft.revision===job.revision && !busyStates.has(job.status)) {
    state.job={...job,result:draft.result,teacher_notes:draft.teacher_notes,reviewed:draft.reviewed,feedback:draft.feedback};
    state.dirty=draft.dirty;state.feedbackDirty=draft.feedbackDirty;
    renderReview();if(draft.notes_checked&&$('#notes-checked'))$('#notes-checked').checked=true;
    updateReviewActions();toast('未保存的修改已恢复，请核对后保存。');
  } else {
    state.conflictDraft=draft;renderReview();toast('作业版本已变化。旧草稿已保留供对照，未覆盖新版。');
  }
}

function showLogin() { $("#login-screen").hidden = false; $("#workspace").hidden = true; }
function clearPrivateState() {
  state.authEpoch++;state.generation++;state.listRequest++;state.historyRequest++;
  state.uploadXHR?.abort();
  [...state.files,...state.originals].forEach(discardPhoto);
  Object.assign(state,{students:[],jobs:[],files:[],originals:[],submitKey:'',uploading:false,actionPending:false,job:null,dirty:false,feedbackDirty:false,authDraft:null,conflictDraft:null,submission:null,uploadXHR:null,history:null,page:1,total:0,counts:{},filter:'pending',route:''});
  ['#jobs-list','#students-list','#student-history','#review-view','#users-list','#account-usage'].forEach(selector=>{$(selector).innerHTML='';});
  $('#upload-form').reset();$('#job-student-filter').value='';$('#job-day-from').value='';$('#job-day-to').value='';
  $('#password-form').reset();$('#create-user-form').reset();$('#reset-password-form').reset();
  $('#student-form').reset();$('#question-form').reset();
  $('#student-select').innerHTML='<option value="">请选择学生</option>';$('#job-student-filter').innerHTML='<option value="">全部学生</option>';
  imageOpenSerial++;imagePhoto=null;imageQuestion=null;cropSelection=null;cropStart=null;
  $('#full-image').removeAttribute('src');$('#preview-image').removeAttribute('src');$('#download-original').removeAttribute('href');
  $('#image-question-text').textContent='';$('#image-question-select').innerHTML='';$('#question-regions').innerHTML='';
  $('#crop-canvas').width=0;$('#crop-canvas').height=0;
  $('#account-name').textContent='我的工作台';$('#account-identity').textContent='';$('#toast').hidden=true;
  $('#password-error').textContent='';$('#create-user-error').textContent='';
  $$('dialog[open]').forEach(dialog=>dialog.close());
  renderPhotos();renderOriginals();updateUploadState();
}
async function start() {
  const me = await api("/api/me");
  if(state.user && state.user.user_id!==me.user.user_id){clearPrivateState();location.hash='#queue';}
  state.user=me.user;state.csrf = me.csrf; state.apiConfigured = me.api_configured;
  $('#account-name').textContent=me.user.display_name;$('#account-role').textContent=me.user.is_admin?'管理员':'老师';
  $('#account-identity').textContent=`${me.user.display_name} · ${me.user.username}`;
  $('#admin-panel').hidden=!me.user.is_admin||!!me.user.must_change_password;
  $('#password-required').hidden=!me.user.must_change_password;
  $("#login-screen").hidden = true; $("#workspace").hidden = false; $("#api-banner").hidden = me.api_configured;
  if(me.offline_demo){$("#api-banner").hidden=false;$("#api-banner").textContent="离线界面演示：批改和评语均为模拟响应，未调用 DeepSeek。真实图片仅用于检查显示与上传。";}
  $("#today").textContent = new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"long",day:"numeric",weekday:"short"}).format(new Date());
  $("#assignment-day").value ||= today();
  if(me.user.must_change_password){location.hash='#account';await route(true);return;}
  await loadStudents(); await loadJobs();
  await route(true);
  updateUploadState();
}

async function loadStudents() {
  const epoch=state.authEpoch,students=await api("/api/students");if(epoch!==state.authEpoch)return;
  state.students=students;
  const selected = $("#student-select").value;
  $("#student-select").innerHTML = '<option value="">请选择学生</option>' + state.students.map(s => `<option value="${s.id}">${escapeHTML(s.name)} · ${escapeHTML(s.grade)}</option>`).join("");
  if (state.students.some(s=>s.id===selected)) $("#student-select").value = selected;
  const filter=$('#job-student-filter'),filterValue=filter.value;
  filter.innerHTML='<option value="">全部学生</option>'+state.students.map(s=>`<option value="${s.id}">${escapeHTML(s.name)}</option>`).join('');filter.value=filterValue;
  renderStudents();
}
function pagination(page,total,attribute) {
  const pages=Math.max(1,Math.ceil(total/30));
  return `<button type="button" class="button secondary" ${attribute}="${page-1}" ${page<=1?'disabled':''}>上一页</button><span>第${page}/${pages}页 · ${total}份</span><button type="button" class="button secondary" ${attribute}="${page+1}" ${page>=pages?'disabled':''}>下一页</button>`;
}
async function loadJobs() {
  const ctx=requestContext(),serial=++state.listRequest;
  const params=new URLSearchParams({filter:state.filter,page:state.page,page_size:30,student_id:$('#job-student-filter').value,day_from:$('#job-day-from').value,day_to:$('#job-day-to').value});
  const value=await api(`/api/jobs?${params}`,{context:ctx});
  if(!contextCurrent(ctx,false)||serial!==state.listRequest)return;
  if(!value.items.length && state.page>1 && state.page>Math.ceil(value.total/30)){state.page=Math.max(1,Math.ceil(value.total/30));return loadJobs();}
  state.jobs=value.items;state.total=value.total;state.counts=value.counts;renderJobs();
}
function jobFilterState() {
  return AutoGradeWorkspace.filters({
    student:$('#job-student-filter').value,
    start:$('#job-day-from').value,
    end:$('#job-day-to').value
  });
}
function updateJobFilterSummary() {
  const selected=jobFilterState();
  const status=$('#job-filter-status');
  if(status){status.hidden=!selected.applied;status.textContent=selected.applied?`${selected.count} 项已设置`:'';}
  const label=$('#date-filter-label');
  if(label)label.textContent=selected.dateActive?'日期筛选 · 已设置':'日期筛选';
}
function jobCard(job) {
  return AutoGradeWorkspace.jobCard(job,labels);
}
function renderJobs() {
  updateJobFilterSummary();
  $("#stat-review").textContent = state.counts.needs_attention||0;
  $("#stat-processing").textContent = state.counts.processing||0;
  $("#stat-confirmed").textContent = state.counts.confirmed_today||0;
  $("#nav-count").textContent = state.counts.pending||0;
  const jobs = state.jobs;
  $("#list-count").textContent = state.total;
  $('#job-pagination').innerHTML=pagination(state.page,state.total,'data-job-page');
  $('#job-pagination').hidden=state.total<=30;
  $("#jobs-list").innerHTML = jobs.length ? jobs.map(jobCard).join("") : AutoGradeWorkspace.emptyList({filter:state.filter,hasConstraints:jobFilterState().applied});
}
function renderStudents() {
  $("#students-list").innerHTML = state.students.length ? state.students.map(s=>`<article class="job-card"><div class="job-card-head"><span class="avatar">${escapeHTML(s.name.slice(0,1))}</span><div><strong>${escapeHTML(s.name)}</strong><small>${escapeHTML(s.grade)}</small></div></div><div class="job-card-footer"><button class="text-button" data-student-history="${s.id}">查看作业记录 →</button><button class="text-button error-text" data-delete-student="${s.id}">删除档案</button></div></article>`).join("") : '<div class="empty-state"><div class="empty-symbol">◉</div><h3>先认识一个孩子</h3><p class="muted">新建学生后，就可以关联作业和确认过的历史记录。</p></div>';
}

async function route(force = false) {
  const next = state.user?.must_change_password ? '#account' : (location.hash || "#queue");
  if (!force && next === state.route) return;
  if(state.actionPending){location.hash=state.route;toast("正在保存或处理，请稍候再离开");return;}
  if (!force && (state.dirty || state.feedbackDirty) && !confirm("本页有尚未保存的修改。离开后会丢失，仍然离开吗？")) {
    location.hash = state.route; return;
  }
  if (state.uploading && !next.startsWith("#upload")) {location.hash = "#upload"; toast("照片正在上传，请等待上传成功"); return;}
  if(!state.csrf){showLogin();return;}
  state.generation++;state.route = next; state.dirty = false; state.feedbackDirty = false;state.job=null;
  $$('dialog[open]').forEach(dialog=>dialog.close());
  const [page, id] = next.slice(1).split("/");
  const target = ["queue","upload","students","review","account"].includes(page) ? page : "queue";
  $$(".view").forEach(el=>el.hidden = el.id !== `${target}-view`);
  $$("[data-nav]").forEach(el=>{const active=el.dataset.nav===(target==="review"?"queue":target);el.classList.toggle("active",active);el.setAttribute('aria-current',active?'page':'false');});
  window.scrollTo(0,0);
  if (target === "review" && id) {
    $("#review-view").innerHTML = '<div class="review-working"><div class="spinner"></div><p>正在打开作业…</p></div>';
    const ctx=requestContext(id);
    try {
      const job=await api(`/api/jobs/${id}`,{context:ctx});
      if(applyJob(job,ctx)){renderReview();restoreDraft(job);}
    } catch(error) {
      if(contextCurrent(ctx,false)&&state.route===next){$('#review-view').innerHTML=`<div class="notice">${escapeHTML(error.message)}</div><a class="button secondary" href="#queue">返回待办</a>`;if(state.authDraft?.jobId===id){state.conflictDraft=state.authDraft;state.authDraft=null;renderConflictDraft();}}
    }
  } else if (target === "queue") {state.job = null; await loadJobs();}
  else if (target === "students") {state.job = null; await loadStudents(); $("#student-history").hidden = true;}
  else if (target === "account" && !state.user?.must_change_password)await loadAccounts();
}

function fileKind(file) {
  const type = file.type.toLowerCase();
  if (/^image\/hei[cf](?:-sequence)?$/.test(type) || /\.hei[cf]$/i.test(file.name)) return 'heif';
  if (['image/jpeg','image/png','image/webp','image/mpo'].includes(type) || /\.(jpe?g|png|webp|mpo)$/i.test(file.name)) return 'image';
  if (type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  return '';
}
function previewHTML(item, index, original = false) {
  if (item.url) return `<img src="${item.url}" alt="${original?'原题':'第'}${index+1}${original?'':'页'}预览">`;
  const retry = item.previewError ? `${original?'':`<span class="preview-error">${escapeHTML(item.previewError)}</span>`}<button type="button" class="text-button" data-preview="${index}" title="${escapeHTML(item.previewError)}">${original?'失败·重试':'重试预览'}</button>` : '<span>生成预览中…</span>';
  return `<div class="${original?'original-icon':'photo-placeholder'}">${retry}</div>`;
}
function previewWait(promise,signal,disposeLate=()=>{}) {
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(Object.assign(new Error('预览已中断'),{name:'AbortError'}));
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{if(signal?.aborted)disposeLate(value);else resolve(value);},reject).finally(()=>signal?.removeEventListener('abort',abort));
  });
}
async function localThumbnail(file,signal) {
  let image,url;
  try {
    if(typeof createImageBitmap==='function')image=await previewWait(createImageBitmap(file),signal,bitmap=>bitmap.close());
    else {
      url=URL.createObjectURL(file);image=new Image();
      await previewWait(new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('图片无法预览，请另存为 JPG 后重试'));image.src=url;}),signal);
    }
    const width=image.width||image.naturalWidth,height=image.height||image.naturalHeight;
    if(!width||!height||width*height>25000000)throw new Error('图片尺寸无效或超过2500万像素');
    const scale=Math.min(1,600/Math.max(width,height)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    const blob=await previewWait(new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.82)),signal);
    if(!blob)throw new Error('无法生成图片预览，请重试');
    return blob;
  } finally {image?.close?.();if(url){image.src='';URL.revokeObjectURL(url);}}
}
let previewQueue = Promise.resolve();
function queuePreview(item) {
  if (item.previewPending) return;
  item.previewPending = true; item.previewError = '';
  // Decode just one file at a time and display real small images, not full-size Blob URLs.
  previewQueue = previewQueue.then(async () => {
    const selected = () => state.files.includes(item) || state.originals.includes(item);
    if (!selected()) {item.previewPending=false;return;}
    item.controller = new AbortController();
    const ctx=requestContext(),timer=setTimeout(()=>item.controller?.abort(),120000);
    try {
      if(fileKind(item.file)==='image') {
        const blob=await localThumbnail(item.file,item.controller.signal);
        if(selected()&&!item.controller.signal.aborted)item.url=URL.createObjectURL(blob);
      } else {
        if(!state.csrf)throw new Error('请登录后重试预览');
        const form = new FormData(); form.append('file', item.file);
        const response = await fetch(item.pdf?'/api/materials/preview':'/api/photos/preview', {method:'POST',body:form,headers:{'X-CSRF-Token':state.csrf},credentials:'same-origin',signal:item.controller.signal});
        if (!response.ok) {
          if(response.status===401)expireSession(ctx);
          const value = await response.json().catch(()=>({}));
          throw new Error(typeof value.detail==='string'?value.detail:'预览失败，请重试');
        }
        if(item.pdf) {
          const value=await response.json();
          if(selected()&&ctx.authEpoch===state.authEpoch){item.pageCount=value.page_count;item.pages=value.pages;item.url=value.pages[0].preview;}
        } else {
          const blob=await response.blob();
          if(selected()&&ctx.authEpoch===state.authEpoch)item.url=URL.createObjectURL(blob);
        }
      }
    } catch (error) {
      if(selected()){item.previewError=error.name==='AbortError'?'预览等待超时，请重试':error.message;toast(`${item.file.name}：${item.previewError}`);}
    } finally {
      clearTimeout(timer);
      item.previewPending = false; item.controller = null;
      if (selected()) {renderPhotos(false);renderOriginals(false);if(item.pdf)renderMapping();}
    }
  });
}
function discardPhoto(item) {
  item.controller?.abort();
  if(item.url?.startsWith('blob:'))URL.revokeObjectURL(item.url);
  item.pages=null;
}
function renderPhotos(updateMapping = true) {
  // Preview completion can re-render tiles; do not collapse an actively used page menu.
  const openActions=new Set([...$("#photo-list").querySelectorAll(".photo-actions[open]")].map(menu=>Number(menu.closest(".photo-tile").dataset.photoIndex)));
  $("#photo-list").innerHTML = state.files.map((item,i)=>`<div class="photo-tile" data-photo-index="${i}">${item.url?`<button type="button" class="photo-preview" data-view-photo="${i}" aria-label="查看第${i+1}页完整预览">${previewHTML(item,i)}</button>`:previewHTML(item,i)}<p>${i+1}. ${escapeHTML(item.file.name)}</p><details class="photo-actions" ${openActions.has(i)?'open':''}><summary aria-label="调整第${i+1}页的页序或删除">调整页序</summary><div class="photo-controls"><button type="button" data-move-photo="${i}" data-direction="-1" ${i===0?'disabled':''} aria-label="第${i+1}页前移">←</button><button type="button" data-remove-photo="${i}" aria-label="删除第${i+1}页">删除</button><button type="button" data-move-photo="${i}" data-direction="1" ${i===state.files.length-1?'disabled':''} aria-label="第${i+1}页后移">→</button></div></details></div>`).join("");
  updateUploadSummary();
  $("#photo-count").textContent = state.files.length ? `已选择${state.files.length}张 · ${(state.files.reduce((sum,x)=>sum+x.file.size,0)/1048576).toFixed(1)}MB · 请核对页序` : "尚未选择照片";
  if (updateMapping) renderMapping();
}
function renderOriginals(updateMapping = true) {
  $('#original-list').innerHTML=state.originals.map((item,i)=>`<div class="original-item">${previewHTML(item,i,true)}<span>${i+1}. ${escapeHTML(item.file.name)}${item.pdf&&item.pageCount?` · ${item.pageCount}页`:''}${item.previewError?`<small class="preview-error">${escapeHTML(item.previewError)}</small>`:''}</span>${item.url?`<button type="button" class="text-button" data-preview-original="${i}">查看</button>`:''}<button type="button" class="text-button" data-remove-original="${i}" aria-label="移除原题${i+1}">移除</button></div>`).join('');
  if (updateMapping) renderMapping();
}
function renderMapping() {
  $('#material-mapping').hidden=!state.originals.length||!state.files.length;
  $('#material-mapping').innerHTML='<h3>核对原题对应关系</h3><p class="fine">请选择实际对应的原题版本。PDF 使用文件内部页码，从1开始。</p>'+state.files.map((item,i)=>{
    const source=state.originals[item.source],pdf=source?.pdf;
    return `<div class="mapping-row"><label for="source-file-${i}">作业第${i+1}张 · ${escapeHTML(item.file.name)}</label><select id="source-file-${i}" data-source-file="${i}" ${uploadLocked()?'disabled':''}><option value="">本页不提供原题</option>${state.originals.map((s,j)=>`<option value="${j}" ${item.source===j?'selected':''}>${escapeHTML(s.file.name)}</option>`).join('')}</select>${pdf?`<label for="source-page-${i}">PDF 内部页码</label><select id="source-page-${i}" data-source-page="${i}" ${!source.pageCount||uploadLocked()?'disabled':''}>${source.pageCount?Array.from({length:source.pageCount},(_,p)=>`<option value="${p+1}" ${item.sourcePage===p+1?'selected':''}>内部第${p+1}页</option>`).join(''):'<option>等待预览完成</option>'}</select>${source.pages?`<button type="button" class="mapping-preview" data-mapping-preview="${i}"><img src="${source.pages[(item.sourcePage||1)-1]?.preview||source.pages[0].preview}" alt="PDF内部第${item.sourcePage||1}页"><span>查看这一页</span></button>`:''}`:''}</div>`;
  }).join('');
}
function addOriginals(files) {
  if(uploadLocked())return;
  for(const file of files) {
    if(state.originals.length>=10){toast('原题最多选择10个文件，展开后最多10页');break;}
    if(file.size>20*1048576){toast(`${file.name}超过20MB`);continue;}
    const kind=fileKind(file),pdf=kind==='pdf';
    if(!kind){toast('原题支持 JPG、PNG、WebP、HEIC / HEIF 和 PDF，Word 请先转成 PDF');continue;}
    if([...state.files,...state.originals].reduce((s,x)=>s+x.file.size,0)+file.size>100*1048576){toast('作业与原题合计最多100MB');break;}
    const item={file,pdf,url:null};
    state.originals.push(item);
    queuePreview(item);
  }
  state.submitKey='';renderOriginals();
}
function addPhotos(files) {
  if (uploadLocked()) return;
  for (const file of files) {
    if (state.files.length>=10) {toast("每份作业最多10张照片"); break;}
    if (file.size>20*1048576) {toast(`${file.name}超过20MB`);continue;}
    const kind=fileKind(file);
    if (!['image','heif'].includes(kind)) {toast("作业支持 JPG、PNG、WebP、HEIC / HEIF 图片"); continue;}
    if ([...state.files,...state.originals].reduce((s,x)=>s+x.file.size,0)+file.size>100*1048576) {toast("作业与原题合计最多100MB"); break;}
    const item={file,url:null,source:null,sourcePage:1};
    state.files.push(item);
    queuePreview(item);
  }
  state.submitKey=""; renderPhotos();
}
function uploadLocked() {return state.uploading||!!state.submission;}
function updateUploadSummary() {
  const student=state.students?.find(s=>s.id===$('#student-select').value);
  const text=AutoGradeWorkspace.uploadSummary({
    count:state.files.length,studentName:student?.name,day:$('#assignment-day').value,
    uploading:state.uploading,submission:!!state.submission
  });
  const title=$('#upload-submit-title'),detail=$('#upload-submit-detail');
  if(title)title.textContent=text.title;
  if(detail)detail.textContent=text.detail;
}
function createSubmitKey() {
  // getRandomValues also works over LAN HTTP; randomUUID requires a secure context.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
function updateUploadState() {
  const locked=uploadLocked();
  $$('#upload-form input, #upload-form select, #upload-form textarea, #upload-form button').forEach(el=>el.disabled=locked);
  $('#submit-upload').disabled=state.uploading||!!state.submission?.checking;
  $('#submit-upload').textContent=state.submission?'同一提交重试 →':'提交批改 →';
  updateUploadSummary();
  $('#upload-cancel').hidden=!state.uploading;$('#upload-cancel').disabled=false;
  $('#upload-check').hidden=!state.submission||state.uploading;$('#upload-check').disabled=!!state.submission?.checking;
  $('#upload-release').hidden=!state.submission||state.uploading;$('#upload-release').disabled=!!state.submission?.checking;
  $('#upload-lock-notice').hidden=!state.submission;
  $('#upload-lock-notice').textContent=state.submission?'本次提交内容已固定。中断后服务器仍可能受理，请核对结果或使用同一提交重试，避免重复批改。':'';
}
function showUploadProgress(message,percent) {
  $('#upload-progress').hidden=false;$('#upload-progress').textContent=message;
  const meter=$('#upload-meter');meter.hidden=percent===undefined;
  if(percent==null)meter.removeAttribute('value');else meter.value=Math.max(0,Math.min(100,percent));
}
function uploadWithProgress(form) {
  return new Promise((resolve,reject)=> {
    const xhr = new XMLHttpRequest(); xhr.open("POST","/api/jobs"); xhr.setRequestHeader("X-CSRF-Token",state.csrf);
    const ctx=requestContext(),active=()=>state.uploadXHR===xhr;state.uploadXHR=xhr;
    let finished=false,waitTimer,idleTimer;
    const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(waitTimer);clearTimeout(idleTimer);if(active())state.uploadXHR=null;error?reject(error):resolve(value);};
    const idle=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>{if(active())showUploadProgress('两分钟没有新的上传进度，可中断等待；原文件和提交键会保留。');},120000);};
    xhr.timeout=1200000;idle();
    xhr.upload.onprogress = event => {if(!active())return;idle();const percent=event.lengthComputable&&event.total>0?Math.round(event.loaded/event.total*100):null;showUploadProgress(`上传照片${percent===null?'':` ${percent}%`} · 请暂时保持页面打开`,percent);};
    xhr.upload.onload=()=>{clearTimeout(idleTimer);if(active())showUploadProgress('照片已传输，正在准备图片；受理后将在后台批改。',null);waitTimer=setTimeout(()=>{if(active())xhr.abort();},300000);};
    xhr.onload = () => {
      let value;try{value=JSON.parse(xhr.responseText);}catch{finish(new Error('响应无法确认，请先核对是否已受理'));return;}
      if(xhr.status>=200&&xhr.status<300&&typeof value.id==='string'){finish(null,value);return;}
      if(xhr.status===401)expireSession(ctx);
      const error=new Error(typeof value.detail==='string'?value.detail:'提交结果无法确认，请核对受理状态');error.status=xhr.status;finish(error);
    };
    xhr.onerror=()=>finish(new Error('网络中断，提交结果未确认。照片与原提交键已保留。'));
    xhr.onabort=()=>finish(new Error('已中断等待，服务器仍可能受理。请核对结果或使用同一提交重试。'));
    xhr.ontimeout=()=>finish(new Error('上传等待超时，提交结果未确认。请先核对受理状态。'));
    xhr.send(form);
  });
}
async function completeUpload(job,submission,ctx) {
  if(!contextCurrent(ctx,false)||state.submission!==submission)return;
  [...state.files,...state.originals].forEach(discardPhoto);state.files=[];state.originals=[];
  state.submission=null;state.submitKey='';state.uploading=false;
  renderPhotos();renderOriginals();$('#reference').value='';updateUploadState();
  $('#upload-progress').hidden=true;$('#upload-meter').hidden=true;toast('上传已受理，批改在后台继续');location.hash=`#review/${job.id}`;
}
async function checkSubmission() {
  const submission=state.submission;if(!submission||submission.checking||state.uploading)return;
  const ctx=requestContext();submission.checking=true;updateUploadState();
  try {
    const job=await api(`/api/submissions/${encodeURIComponent(submission.key)}`,{context:ctx});
    if(!contextCurrent(ctx,false)||state.submission!==submission)return;
    if(job.id)await completeUpload(job,submission,ctx);
    else {showUploadProgress('目前尚未登记，旧请求仍可能处理中。请稍后核对，或点击“同一提交重试”；不会另建一份作业。');}
  }catch(error){toast(error.message);}finally{submission.checking=false;updateUploadState();}
}
async function releaseSubmission() {
  const submission=state.submission;if(!submission||state.uploading||submission.checking)return;
  const ctx=requestContext();submission.checking=true;updateUploadState();
  try {
    const job=await api(`/api/submissions/${encodeURIComponent(submission.key)}`,{context:ctx});
    if(!contextCurrent(ctx,false)||state.submission!==submission)return;
    if(job.id){await completeUpload(job,submission,ctx);return;}
    if(!confirm('旧请求仍可能在服务器受理并产生费用。放弃重试后再次提交会使用新提交键，可能重复批改和收费。确认放弃这次重试并重新编辑？'))return;
    state.submission=null;state.submitKey='';showUploadProgress('照片已保留，可重新编辑。旧请求仍可能受理，请留意待办中的作业。');
  }catch(error){toast(error.message);}finally{submission.checking=false;updateUploadState();}
}

function reviewTextField(field,label,value,rows=2) {
  const formatted=AutoGradeText.needsPreview(value)||AutoGradeText.formulaParts(value).length>0;
  let input=`<label>${escapeHTML(label)}</label><textarea data-field="${field}" rows="${rows}">${escapeHTML(value)}</textarea>`;
  if(['question','student_answer','expected_answer'].includes(field))input=`<div class="math-input">${input}<div class="math-symbols" role="group" aria-label="数学符号">${['÷','×','+','−','=','>','<','(',')','/'].map(symbol=>`<button type="button" data-math-symbol="${escapeHTML(symbol)}" aria-label="插入 ${escapeHTML(symbol)}">${escapeHTML(symbol)}</button>`).join('')}</div></div>`;
  if(typeof AutoGradeMath!=='undefined'&&AutoGradeMath.toLatex(value)!==null&&input.includes('class="math-input"'))return input;
  const preview=`<div class="math-preview" data-preview-field="${field}" role="region" aria-label="${escapeHTML(label)}预览" ${formatted?'':'hidden'}>${formatted?AutoGradeText.mixedHTML(value,true):''}</div>`;
  return formatted?`<div class="math-mixed-input"><label>${escapeHTML(label)}</label>${preview}<details class="math-source"><summary>编辑文字 <span class="fine">· 点击公式可直接修改</span></summary>${input.replace(`<label>${escapeHTML(label)}</label>`,'')}</details></div>`:preview+input;
}
function insertMathSymbol(button) {
  const input=button.closest('.math-input')?.querySelector('textarea');
  if(!input||button.matches(':disabled')||input.matches(':disabled'))return;
  input.setRangeText(button.dataset.mathSymbol,input.selectionStart,input.selectionEnd,'end');
  input.focus({preventScroll:true});
  input.dispatchEvent(new Event('input',{bubbles:true}));
}
function updateTextPreview(input) {
  const preview=input.closest('[data-question]')?.querySelector(`[data-preview-field="${input.dataset.field}"]`);
  if(!preview)return;
  if(preview.querySelector?.('math-field'))return;
  preview.hidden=!AutoGradeText.needsPreview(input.value)&&AutoGradeText.formulaParts(input.value).length===0;
  preview.innerHTML=preview.hidden?'':AutoGradeText.mixedHTML(input.value,true);
}
function questionHTML(q,i) {
  const options = ["correct","incorrect","blank","uncertain"].map(s=>`<option value="${s}" ${q.status===s?'selected':''}>${labels[s]}</option>`).join("");
  const materialId=state.job.photos.find(p=>p.page===q.page)?.material_id;
  const originalTool=materialId?`<button type="button" class="text-button" data-original-id="${materialId}">对照空白原题</button><span class="fine">${({matched:'原题对应：模型确认匹配',unmatched:'原题对应：不匹配',uncertain:'原题对应：待核对',not_provided:'原题对应：尚未确认'})[q.source_match]||'原题对应：尚未确认'}</span>`:'';
  const photo=state.job.photos.find(p=>p.page===q.page),box=q.bbox;
  const crop=photo&&box&&needsQuestionReview(q)?`<button type="button" class="question-crop" data-image-question="${i}" data-crop-width="${box.width}" data-crop-height="${box.height}" aria-label="放大本题原图（位置需核对）"><img src="/images/${photo.id}" alt="本题关联区域，点击查看整页" style="width:${100/box.width}%;left:${-100*box.x/box.width}%;top:${-100*box.y/box.height}%"></button>`:'';
  return `<details class="question-card" data-question="${i}" ${needsQuestionReview(q)?'open':''}><summary><strong>${escapeHTML(q.number)}</strong><span class="fine">第${q.page}页</span>${badge(q.status)}<span class="question-review-status" data-question-review></span></summary><div class="question-body"><div class="question-tools"><button class="button secondary" type="button" data-image-question="${i}">▧ 定位原图</button><span class="fine">${q.bbox?(regionSources[q.bbox_source]||regionSources.model):'尚无位置，可手动标记'}</span>${originalTool}</div>${crop}${reviewTextField("question","识别到的原题（可修改）",q.question)}<div class="answer-grid"><div>${reviewTextField("student_answer","孩子的实际作答",q.student_answer)}</div><div>${reviewTextField("expected_answer","参考答案",q.expected_answer)}</div></div><label>判题结果（可手动更正）</label><select data-field="status">${options}</select>${reviewTextField("explanation","依据与订正提示",q.explanation)}<label>知识点</label><input data-field="knowledge_point" value="${escapeHTML(q.knowledge_point)}" maxlength="100"><div class="question-tools"><button type="button" class="button secondary" data-action="judge-text" data-question-index="${i}" ${q.judgment_pending?'':'hidden'}>重新判题（1次 API）</button><details class="question-more"><summary>更多题目操作</summary><div class="question-more-actions"><button class="text-button" type="button" data-crop-question="${i}">框选重识别（1次 API）</button><button class="text-button error-text" type="button" data-delete-question="${i}">删除题目</button></div></details></div><p class="fine judgment-hint" data-judgment-hint hidden>题干或作答已修改。请重新判题，或核对后采用当前判定。</p><div data-related-notes></div><button type="button" class="button secondary question-confirm" data-action="confirm-question" data-confirm-question="${i}" ${needsQuestionReview(q)?'':'hidden'}>采用当前判定</button></div></details>`;
}

const tokens = n => Number(n).toLocaleString('zh-CN');
function costText(calls) {
  if(!calls.length)return '暂无调用';
  const priced=calls.filter(c=>c.pricing), currencies=new Set(priced.map(c=>c.pricing.currency));
  if(!priced.length)return '费用未估算';
  if(currencies.size!==1)return '币种不同，见调用明细';
  const low=priced.reduce((s,c)=>s+c.pricing.min,0),high=priced.reduce((s,c)=>s+c.pricing.max,0);
  const unit=[...currencies][0]==='CNY'?'¥':`${[...currencies][0]} `;
  const amount=value=>value>0&&value<.01?`低于${unit}0.01`:`${unit}${value.toFixed(2)}`;
  const from=amount(low),to=amount(high);
  return `估算 ${from}${from!==to?'–'+to:''}${priced.length<calls.length?'（部分调用）':''}`;
}
function usageText(calls) {
  const known=calls.filter(c=>!c.usage || (Number.isInteger(c.usage.prompt_tokens)&&Number.isInteger(c.usage.completion_tokens)));
  if(calls.length&&!known.length)return `${calls.length}次 · 接口未返回 Token 用量`;
  const input=known.reduce((s,c)=>s+c.input_tokens,0),output=known.reduce((s,c)=>s+c.output_tokens,0);
  return `${calls.length}次 · 输入 ${tokens(input)} / 输出 ${tokens(output)} Token${known.length<calls.length?'（部分请求用量缺失）':''}`;
}
function usageHTML(job) {
  const shared=job.calls.filter(c=>!c.photo_id);
  const unknown=job.calls.some(c=>c.usage&&(!Number.isInteger(c.usage.prompt_tokens)||!Number.isInteger(c.usage.completion_tokens)));
  return `<details class="metrics usage-panel"><summary>API 用量与费用 <span class="fine">${tokens(job.calls.reduce((s,c)=>s+c.input_tokens+c.output_tokens,0))} 已记录 Token${unknown?' · 部分用量未知':''} · ${escapeHTML(costText(job.calls))}</span></summary><p>${escapeHTML(costText(job.calls))}</p><div class="usage-pages">${job.photos.map(p=>{const calls=job.calls.filter(c=>c.photo_id===p.id);return `<div><strong>第${p.page}页</strong><p>${usageText(calls)}</p><p>${escapeHTML(costText(calls))}</p></div>`;}).join('')}${shared.length?`<div><strong>整份作业 / 家长回复</strong><p>${usageText(shared)}</p><p>${escapeHTML(costText(shared))}</p></div>`:''}</div><details><summary>每次调用明细</summary>${job.calls.map(c=>{const u=c.usage;return `<p>${c.page?'第'+c.page+'页':'整份作业'} · ${escapeHTML(({grading:'整页识别',crop:'局部重识别',location:'重新定位',text_judgment:'按文字判题',feedback:'家长回复'})[c.kind]||c.kind)} · ${escapeHTML(c.model)} · ${c.seconds}秒${c.reference_count?` · 含${c.reference_count}张原题对照`:""}<br>${usageText([c])}${u&&Number.isInteger(u.prompt_cache_hit_tokens)?` · 缓存命中 ${tokens(u.prompt_cache_hit_tokens)} / 未命中 ${tokens(c.input_tokens-u.prompt_cache_hit_tokens)}`:''}${u?.completion_tokens_details?.reasoning_tokens!==undefined?` · 思考 ${tokens(u.completion_tokens_details.reasoning_tokens)}（已含在输出中）`:''}<br>${escapeHTML(costText([c]))}${c.pricing?`<br>${escapeHTML(c.pricing.note)}`:''}${!u?' · 旧记录未保存缓存明细':''}</p>`;}).join('')||'<p>暂无模型调用记录。</p>'}</details><p class="fine">图片识别用量包含作业图、指定原题页、提示及输出；按文字判题只发送文字，用量归入该题所在页。重识别累加。家长回复单列。旧的多图请求无法精确拆到每页。超时或中断可能产生未记录费用；实际扣款以 DeepSeek 账单为准。</p></details>`;
}
function updateReviewActions() {
  const job=state.job;if(!job)return;
  const busy=busyStates.has(job.status),locked=busy||state.actionPending;
  $$('#review-view [data-action], #review-view [data-math-symbol], #review-view input, #review-view textarea, #review-view select').forEach(el=>el.disabled=locked);
  $$('#review-view math-field').forEach(el=>el.readOnly=locked);
  $$('#review-view .math-text-toggle').forEach(el=>el.disabled=locked);
  $$('#review-view [data-math-start]').forEach(el=>el.disabled=locked);
  const bar=$('.review-actions');if(!bar)return;
  const dirty=state.dirty||state.feedbackDirty,stale=job.feedback_revision!==job.revision;
  const scoped=job.result?.questions.every(q=>q.id);
  const manual=scoped?job.result.questions.filter(needsQuestionReview).length:0;
  const notesReady=!job.result?.notes_pending||(!scoped&&$('#notes-checked')?.checked);
  const reviewed=(scoped?job.result.questions.every(q=>q.reviewed):$('#reviewed')?.checked)&&notesReady,feedback=$('#feedback')?.value.trim();
  const archived=job.status==='confirmed'&&!dirty&&!stale;
  const canConfirm=reviewed&&feedback&&(state.feedbackDirty||(!state.dirty&&!stale));
  const generateNext=scoped&&!archived&&(!reviewed||!feedback||(stale||state.dirty)&&!state.feedbackDirty);
  let title,detail,phase='review';
  if(locked){title=state.actionPending?'正在保存或处理…':'正在处理作业';detail='请稍候，完成后可继续操作';phase='pending';}
  else if(manual){title=`${manual}题需人工处理`;detail='补全题干和实际作答后重新判题；仍看不清时可保留无法判定';}
  else if(dirty){title='有未保存的修改';detail=state.feedbackDirty?'保存修改会同时保存复核内容与回复':'生成回复时会一并保存修改';phase='unsaved';}
  else if(archived){title='已确认归档';detail='复制回复后，回微信粘贴发送';phase='archived';}
  else if(!reviewed&&scoped){title='可以生成回复';detail='其余题目采用当前判定，无需逐题确认';}
  else if(!notesReady){title='还有记录待核对';detail='核对疑问后，可直接确认并生成回复';}
  else if(!reviewed){title='请完成逐题复核';detail='核对原图与判定，勾选已完成复核';}
  else if(!feedback){title='复核已完成';detail='生成或填写家长回复，再确认归档';}
  else if(stale){title='家长回复需重新核对';detail='核对并保存回复后，可确认归档';phase='unsaved';}
  else{title='可以确认归档';detail='检查家长回复后，归档并复制发送';phase='ready';}
  if(generateNext&&!locked&&!manual)detail='生成回复调用1次 API，同时保存修改并采用其余判定';
  bar.dataset.phase=phase;
  $('#review-action-title').textContent=title;$('#save-indicator').textContent=detail;
  bar.querySelector('.review-status-mark').textContent=archived?'✓':locked?'…':'·';
  const save=bar.querySelector('[data-action="save-all"]'),confirm=bar.querySelector('[data-primary-review]')||bar.querySelector('[data-action="confirm"]'),copy=bar.querySelector('[data-action="copy"]');
  save.disabled=locked||!dirty;
  save.hidden=!dirty;copy.hidden=!archived;confirm.hidden=archived;
  confirm.dataset.action=manual?'focus-question':generateNext?'generate':'confirm';
  confirm.disabled=locked||archived||(!manual&&!generateNext&&!canConfirm);confirm.textContent=archived?'已归档':manual?'处理题目':generateNext?'生成回复':'确认归档';
  confirm.title=manual?'定位下一道需要人工处理的题目':generateNext?'保存修改并采用其余判定，生成回复（1次 API）':'核对回复后确认归档';
  copy.disabled=locked||!archived||!feedback||stale;
  confirm.classList.toggle('primary',!archived);confirm.classList.toggle('secondary',archived);
  copy.classList.toggle('primary',archived);copy.classList.toggle('secondary',!archived);
  const generate=$('#review-view [data-action="generate"]');
  if(generate){generate.disabled=locked||!!manual||(!scoped&&!reviewed);generate.textContent=job.feedback?'重新生成回复（1次 API）':'生成家长回复（1次 API）';}
  const saveReply=$('#review-view [data-action="save-feedback"]');
  if(saveReply)saveReply.disabled=locked||!reviewed;
  if($('#reviewed'))$('#reviewed').disabled=locked||!notesReady;
  $$('[data-confirm-question]').forEach(button=>button.disabled=locked||!!job.result.questions[Number(button.dataset.confirmQuestion)].reviewed);
  const remaining=$('#review-view [data-action="confirm-remaining"]');if(remaining)remaining.hidden=scoped&&job.result.questions.filter(q=>!q.reviewed).length<2;
  const notesButton=$('#review-view [data-action="confirm-notes"]');if(notesButton)notesButton.disabled=locked||notesReady;
  $$('#review-view [data-delete-question], #review-view [data-add-question]').forEach(el=>el.disabled=locked);
}
function updateQuestionSummary(questions) {
  const counts=questions.reduce((c,q)=>(c[q.status]=(c[q.status]||0)+1,c),{});
  if($('#question-heading-counts'))$('#question-heading-counts').textContent=`${counts.incorrect||0}题错误 · ${counts.uncertain||0}题待判断`;
  if($('#question-summary'))$('#question-summary').textContent=`${questions.length}题 · ${counts.correct||0}题正确 · ${counts.incorrect||0}题错误 · ${counts.blank||0}题未作答 · ${counts.uncertain||0}题无法判定`;
}
function needsQuestionReview(q) {
  return !q.reviewed&&(q.status==='uncertain'||!!q.judgment_pending);
}
function questionListHTML(questions) {
  const {urgent, errors, routine} = AutoGradeReview.groupQuestions(questions);
  const errorsCount = AutoGradeReview.countStatus(errors);
  const routineCount = AutoGradeReview.countStatus(routine);
  return `<div id="question-attention"><div class="review-group-title"><strong>优先核对</strong><span class="fine" data-pending-count>${urgent.length} 题需要人工判断</span></div><p class="fine">先处理无法判定、修改后待判题的题目；图片和原题均可随时查看。</p>${urgent.length?urgent.map(({q,i})=>questionHTML(q,i)).join(''):`<div class="panel review-ready" data-review-ready><strong>没有必须人工处理的题目</strong><p class="fine">可以继续检查 AI 标记的错误或未作答题。</p></div>`}</div>${errors.length?`<details class="review-question-group review-corrections" open><summary>建议核对：错误与未作答 · ${errors.length} 题 <span class="fine">${errorsCount.incorrect||0} 错误 · ${errorsCount.blank||0} 未作答</span></summary><p class="fine">AI 判断仍可能有误，请对照原图检查，尤其注意计算过程和漏识别。</p>${errors.map(({q,i})=>questionHTML(q,i)).join('')}</details>`:''}${routine.length?`<details class="other-questions"><summary>查看其他 ${routine.length} 题 <span class="fine">${routineCount.correct||0} 正确 · ${routineCount.uncertain||0} 已保留无法判定</span></summary>${routine.map(({q,i})=>questionHTML(q,i)).join('')}</details>`:''}`;
}
function noteEntries(result) {
  return ['observation','warning'].flatMap(kind=>(result[kind+'s']||[]).map(text=>({key:kind+':'+text,kind,text,link:result.note_links?.[kind+':'+text]||{scope:'unassigned',question_ids:[],checked:false}})));
}
function warningChoice(n,result) {
  if(Object.hasOwn(result.warning_states||{},n.text))return result.warning_states[n.text];
  return n.link.scope==='questions'&&n.link.question_ids.length&&n.link.question_ids.every(id=>result.questions.some(q=>q.id===id&&q.status!=='uncertain'))?'on_confirm':'pending';
}
function warningSelectHTML(n,result,id) {
  const choice=warningChoice(n,result);
  const options=[...(choice==='on_confirm'?[['on_confirm','生成回复时自动解决']]:[]),['pending','保留疑问，用于回复'],['resolved','无需处理 / 已解决，仅留档'],['needs_photo','需要补图']];
  return `<label for="${id}">疑问处理</label><select id="${id}" data-warning-index="${id}" data-warning-text="${escapeHTML(n.text)}">${options.map(([v,label])=>`<option value="${v}" ${choice===v?'selected':''}>${label}</option>`).join('')}</select>`;
}
function noteStatus(n,result) {
  return n.kind==='observation'?n.link.superseded?'旧观察，仅留档':n.link.checked?'用于回复':'待核对':({resolved:'已解决，不用于回复',needs_photo:'需要补图',on_confirm:'确认题目时解决',pending:n.link.checked?'保留疑问':'待核实'})[warningChoice(n,result)];
}
function noteEditorHTML(result) {
  return noteEntries(result).map((n,i)=>`<div class="review-note ${n.link.checked?'':'note-pending'}" id="review-note-${i}" data-note-key="${escapeHTML(n.key)}"><div class="note-heading"><strong>${n.kind==='observation'?'照片观察':'识别疑问'}</strong><span class="fine" data-note-status>${noteStatus(n,result)}</span></div><p>${AutoGradeText.textHTML(n.text)}</p>${n.kind==='warning'?warningSelectHTML(n,result,`note-warning-${i}`):`<label><input type="checkbox" data-note-use ${n.link.superseded?'':'checked'}> 用于家长回复（确认这条观察仍符合原图）</label>`}<details class="note-association"><summary>调整关联范围（选填）</summary><label for="note-scope-${i}">这条记录关联到</label><select id="note-scope-${i}" data-note-scope>${[['unassigned','尚未关联，按整份记录核对'],['questions','指定题目（可多选）'],['all','整份作业']].map(([v,label])=>`<option value="${v}" ${n.link.scope===v?'selected':''}>${label}</option>`).join('')}</select><div class="note-question-links" ${n.link.scope==='questions'?'':'hidden'}>${result.questions.map(q=>`<label><input type="checkbox" data-note-question="${escapeHTML(q.id)}" ${n.link.question_ids.includes(q.id)?'checked':''}>第${q.page}页 · ${escapeHTML(q.number)}</label>`).join('')}</div></details></div>`).join('')||'<p class="fine">暂无额外记录。</p>';
}
function relatedNotesHTML(q,result) {
  const notes=noteEntries(result).filter(n=>n.link.scope==='questions'&&n.link.question_ids.includes(q.id));
  const active=notes.filter(n=>!n.link.checked&&n.kind==='warning');
  const history=notes.filter(n=>!active.includes(n));
  return (active.length?'<p class="fine">重新判题得到结果后，生成回复时会自动处理相关疑问。仍看不清时可保留说明或选择补图。</p>':'')+active.map((n,i)=>`<div class="related-note note-pending"><strong>识别疑问 · ${noteStatus(n,result)}</strong><p>${AutoGradeText.textHTML(n.text)}</p>${warningSelectHTML(n,result,`q-note-${escapeHTML(q.id)}-${i}`)}</div>`).join('')+(history.length?`<details class="related-note-history"><summary>查看照片观察与已处理记录（${history.length}条）</summary>${history.map(n=>`<p><strong>${n.kind==='observation'?'照片观察':'识别疑问'} · ${noteStatus(n,result)}</strong><br>${AutoGradeText.textHTML(n.text)}<br><button type="button" class="text-button" data-edit-note="${escapeHTML(n.key)}">修改记录</button></p>`).join('')}</details>`:'');
}
function generalWarningsHTML(result) {
  const notes=noteEntries(result).filter(n=>n.kind==='warning'&&!n.link.checked&&n.link.scope!=='questions');
  return notes.length?`<details class="general-warning-list"><summary>其他识别疑问（${notes.length}条，可查看）</summary><p class="fine">可能漏题等疑问仍会保留，不要求逐条确认。</p>${notes.map((n,i)=>`<div class="related-note note-pending"><p>${AutoGradeText.textHTML(n.text)}</p>${warningSelectHTML(n,result,`general-warning-${i}`)}</div>`).join('')}</details>`:'';
}
function updateScopedReview() {
  const result=state.job.result;
  result.notes_pending=noteEntries(result).some(n=>!n.link.checked);
  $$('[data-question]').forEach(card=>{
    const q=result.questions[Number(card.dataset.question)];
    const status=card.querySelector('[data-question-review]');if(status)status.textContent=q.reviewed?(q.status==='uncertain'?'已保留无法判定':'已采用'):q.judgment_pending?'作答已改 · 请重新判题':q.status==='uncertain'?'需人工处理':'判定可用';
    const notes=card.querySelector('[data-related-notes]');if(notes)notes.innerHTML=relatedNotesHTML(q,result);
    const button=card.querySelector('[data-confirm-question]');if(button){button.hidden=!needsQuestionReview(q);button.textContent=q.status==='uncertain'?'保留无法判定并继续':'采用当前判定（无需重新判题）';}
    const hint=card.querySelector('[data-judgment-hint]');if(hint)hint.hidden=!q.judgment_pending;
    const rejudge=card.querySelector('[data-action="judge-text"]');if(rejudge)rejudge.hidden=!q.judgment_pending;
  });
  $$('[data-note-key]').forEach(row=>{const n=noteEntries(result).find(n=>n.key===row.dataset.noteKey);row.classList.toggle('note-pending',!n?.link.checked);row.querySelector('[data-note-status]').textContent=noteStatus(n,result);const use=row.querySelector('[data-note-use]');if(use)use.checked=!n.link.superseded;});
  const retained=noteEntries(result).filter(n=>n.kind==='warning'&&['pending','needs_photo'].includes(warningChoice(n,result))).length;
  const pending=result.questions.filter(needsQuestionReview).length;
  const pendingCount=$('#question-attention [data-pending-count]');if(pendingCount)pendingCount.textContent=`${pending} 题需要人工判断`;
  const readyNote=$('#question-attention [data-review-ready]');if(readyNote)readyNote.hidden=!!pending;
  if($('#review-progress'))$('#review-progress').textContent=pending?`${pending}题需人工处理 · 其余题目无需逐题确认`:`异常题已处理，无需逐题确认${retained?` · ${retained}条疑问按所选方式保留`:''}`;
  if($('#general-warnings'))$('#general-warnings').innerHTML=generalWarningsHTML(result);
  if($('#reviewed'))$('#reviewed').checked=result.questions.every(q=>q.reviewed)&&!result.notes_pending;
}
function markQuestionChanged(index,field,value) {
  const result=state.job.result,q=result.questions[index];q.reviewed=false;
  if(value!==undefined)q[field]=value;
  if(['question','student_answer'].includes(field))q.judgment_pending=true;
  if(field==='status')q.judgment_pending=false;
  for(const n of noteEntries(result))if(['question','student_answer','status','source_match'].includes(field)&&(n.link.scope!=='questions'||n.link.question_ids.includes(q.id))){
    if(n.kind==='observation'){n.link.superseded=true;n.link.checked=true;}
    else if(n.link.scope==='questions'){
      n.link.checked=false;
      if(result.warning_states[n.text]!=='needs_photo')delete result.warning_states[n.text];
    }
  }
  if($('#note-review-list'))$('#note-review-list').innerHTML=noteEditorHTML(result);
  updateScopedReview();
}
function processingHTML(job) {
  if(!['queued','processing'].includes(job.status))return '';
  const completed=job.photos.filter(p=>p.recognized).length;
  return `<section class="processing-card" aria-label="图片批改进度"><div class="spinner" aria-hidden="true"></div><div><h3 id="processing-title" role="status" aria-live="polite"></h3>${job.photos.length>1?`<progress max="${job.photos.length}" value="${completed}" aria-label="已完成批改的照片"></progress>`:''}<p id="processing-time" class="fine" aria-live="off"></p><p id="processing-detail" class="muted"></p><p id="processing-connection" class="notice" role="status" hidden></p></div></section>`;
}
function updateProcessingProgress() {
  const job=state.job,title=$('#processing-title');
  if(!title||!job||!['queued','processing'].includes(job.status)||state.route!==`#review/${job.id}`||document.hidden)return;
  const now=Date.now()/1000,progress=job.progress||{},page=progress.page;
  const elapsed=Math.max(0,Math.floor(now-(progress.started_at||(job.status==='queued'?job.updated:job.created)||now)));
  const stageElapsed=Math.max(0,now-(progress.stage_started_at||now));
  const check=state.progressCheck;
  const disconnected=check?.jobId===job.id&&check.failed;
  const stages={preparing:'正在准备批改',locating:'正在定位题目区域',grading:'正在识别与批改',organizing:'正在整理批改结果',saving:'正在保存批改结果'};
  const current=job.status==='queued'?'照片已保存，等待开始批改':`${stages[progress.stage]||'正在处理作业'}${page?` · 第 ${page} / ${job.photos.length} 张`:''}`;
  const values={
    '#processing-title':`${disconnected?'上次状态：':''}${current}`,
    '#processing-time':`${job.photos.length>1?`已完成 ${job.photos.filter(p=>p.recognized).length} / ${job.photos.length} 张 · `:''}已等待 ${elapsed<60?`${elapsed} 秒`:`${Math.floor(elapsed/60)} 分 ${elapsed%60} 秒`}`,
    '#processing-detail':!disconnected&&progress.stage==='grading'&&stageElapsed>=60?'本张处理时间较长，模型尚未返回结果。照片已保存，可以离开页面，稍后查看。':'照片已保存，可以离开页面，稍后查看。',
    '#processing-connection':disconnected?'暂时无法获取最新状态，显示的是上次记录；连接恢复后会继续更新。':''
  };
  for(const [selector,text] of Object.entries(values)){const node=$(selector);if(node.textContent!==text)node.textContent=text;}
  $('#processing-connection').hidden=!disconnected;
}
function renderReview() {
  const job=state.job; if(!job) return;
  const view=$('#review-view');view.dataset.jobId=job.id;
  const busy=busyStates.has(job.status);
  const questions=job.result?.questions||[];
  const counts = questions.reduce((c,q)=>({...c,[q.status]:(c[q.status]||0)+1}),{});
  const header=`<a class="back-link" href="#queue">← 返回作业待办</a><div class="review-heading"><p class="eyebrow">先处理识别异常，再生成家长回复</p><h1>${escapeHTML(job.student_name)}的数学作业</h1><div class="review-meta"><span>${escapeHTML(job.grade)}</span><span>${escapeHTML(job.day)}</span><span>${job.photos.length}张照片</span>${badge(job.status)}</div></div>${job.error?`<div class="notice">${escapeHTML(job.error)}</div>`:""}`;
  const photos=`<div class="photo-strip">${job.photos.map((p,i)=>`<button type="button" data-image-page="${i}"><img src="/images/${p.id}?variant=thumb" alt="第${p.page}页缩略图">第${p.page}页${busy&&p.recognized?' · 已识别':''}</button>`).join("")}</div>`;
  const resources=((job.materials||[]).length?`<details class="original-review"><summary>查看空白原题资料（${job.materials.length}页）</summary><div class="photo-strip">${job.materials.map(m=>`<button type="button" data-original-id="${m.id}"><img src="/images/${m.id}?variant=thumb" alt="原题第${m.page}页">${escapeHTML(m.name)} · 第${m.source_page}页</button>`).join("")}</div></details>`:"")+usageHTML(job);
  if(!job.result) {
    $("#review-view").innerHTML=header+processingHTML(job)+photos+resources+(!busy?`<div class="review-working"><div class="empty-symbol">▧</div><h3>批改尚未完成</h3><p class="muted">照片已保留。请查看上方原因后决定是否重试。</p><button class="button primary" data-action="retry">重新批改</button></div>`:'')+`<button class="text-button error-text" data-action="delete" ${busy?'disabled':''}>删除这份作业</button>`;updateProcessingProgress();return;
  }
  const stale=job.feedback_revision!==job.revision;
  const actions=`<section class="review-actions" aria-label="复核与回复操作"><div class="review-status" role="status" aria-live="polite"><span class="review-status-mark" aria-hidden="true">·</span><div><strong id="review-action-title"></strong><p id="save-indicator"></p></div></div><div class="review-action-buttons" role="group" aria-label="保存与归档"><button type="button" class="button secondary" data-action="save-all">保存修改</button><button type="button" class="button primary" data-primary-review data-action="confirm">确认归档</button><button type="button" class="button secondary" data-action="copy">复制回复</button></div><details class="review-options"><summary aria-label="更多操作">更多</summary><div class="review-options-menu"><button type="button" class="text-button" data-action="delete">删除这份作业</button></div></details></section>`;
  $("#review-view").innerHTML=header+processingHTML(job)+photos+`<div class="section-heading"><h2>识别与批改 <span class="count-pill">${questions.length}题</span></h2><button type="button" class="text-button" data-add-question>＋ 补录一道题</button><span id="question-heading-counts" class="fine">${counts.incorrect||0}题错误 · ${counts.uncertain||0}题待判断</span></div>${busy?'<div class="notice">任务正在后台处理中，完成后可继续编辑。</div>':''}<div class="review-layout"><div><fieldset class="review-fields" ${busy?'disabled':''}>${questionListHTML(questions)}</fieldset></div><aside class="review-sidebar"><div class="panel"><h2>处理进度</h2><p id="question-summary" class="question-summary" role="status" aria-live="polite"></p><p id="review-progress" class="fine" role="status"></p><p class="fine">补全无法判定的题目后重新判题；有结果后直接生成回复，其余题目无需逐题确认。</p><div id="general-warnings"></div><details id="review-records" class="review-records" ><summary>照片观察与识别疑问 <span class="count-pill">${noteEntries(job.result).length}条</span></summary><p class="fine">这些是可选的原始记录，不要求逐条确认。更正后过时的观察默认仅留档；未解决的识别疑问按所选方式保留。照片质量与定位说明仅留档，不用于家长回复。</p><div id="note-review-list">${noteEditorHTML(job.result)}</div>${(job.result.image_notes||[]).length?`<details class="image-notes"><summary>照片质量与定位说明（仅留档，${job.result.image_notes.length}条）</summary>${job.result.image_notes.map(text=>`<p class="fine">${escapeHTML(text)}</p>`).join("")}</details>`:""}<button type="button" class="button secondary" data-action="confirm-notes">确认这些记录已核对</button><details class="warning-editor"><summary>修改观察或疑问原文</summary><label for="observations">照片可见的表现（每行一条）</label><textarea id="observations" rows="4" ${busy?'disabled':''}>${escapeHTML(job.result.observations.join("\n"))}</textarea><label for="warnings">识别疑问（每行一条）</label><textarea id="warnings" rows="3" ${busy?'disabled':''}>${escapeHTML(job.result.warnings.join("\n"))}</textarea><p class="fine">改写后随生成回复一起确认。关联范围选填；只记录照片可见的表现。</p></details></details><label for="teacher-notes">老师补充（选填）</label><textarea id="teacher-notes" rows="3" maxlength="4000" ${busy?'disabled':''}>${escapeHTML(job.teacher_notes)}</textarea><input id="reviewed" type="checkbox" hidden ${job.reviewed?'checked':''}></div><div class="panel"><h2>给家长的回复</h2><p class="fine">${busy?"正在处理中，请稍后查看。":"异常题处理完后直接生成（1次 API），自动保存修改并采用其余判定。生成后检查回复，再确认归档。"}</p>${stale&&job.feedback?'<p class="feedback-stale">批改或历史依据已变化，旧回复需要重新核对。</p>':''}<textarea id="feedback" rows="8" maxlength="2000" placeholder="生成后，你可以按自己的表达习惯修改。" ${busy?'disabled':''}>${escapeHTML(job.feedback)}</textarea><details class="feedback-options"><summary>更多回复操作</summary><button class="button secondary" data-action="generate" ${busy?'disabled':''}>${job.feedback?'重新生成回复':'生成家长回复'}</button></details>${job.evidence.map(e=>`<details class="evidence"><summary>${escapeHTML(e.day)} · 历史依据</summary><p>${escapeHTML(e.claim)}</p><p>${AutoGradeText.textHTML(e.result.questions.map(q=>`${q.number} ${q.knowledge_point}：${labels[q.status]}；${q.explanation}`).join("\n"))}</p></details>`).join("")}</div></aside></div><details class="review-resources"><summary>原题资料与 API 用量</summary>${resources}</details>${actions}`;
  $$('[data-question]').forEach(card=>card.querySelectorAll('[data-field]').forEach(input=>{
    input.id=`q-${card.dataset.question}-${input.dataset.field}`;
    if(input.previousElementSibling?.tagName==='LABEL')input.previousElementSibling.htmlFor=input.id;
  }));
  $("#feedback").setAttribute("aria-label","给家长的回复");
  $$('.question-crop').forEach(crop=>{
    const image=crop.querySelector('img');
    const size=()=>crop.style.aspectRatio=(image.naturalWidth*Number(crop.dataset.cropWidth))/(image.naturalHeight*Number(crop.dataset.cropHeight));
    if(image.complete&&image.naturalWidth)size();else image.addEventListener('load',size,{once:true});
    image.addEventListener('error',()=>{crop.hidden=true;},{once:true});
  });
  AutoGradeMath.mount($('#review-view'));
  updateQuestionSummary(questions);
  updateScopedReview();
  renderConflictDraft();
  updateReviewActions();
  updateProcessingProgress();
}
function renderConflictDraft() {
  $('#draft-conflict')?.remove();const draft=state.conflictDraft;
  if(!draft||state.route!==`#review/${draft.jobId}`)return;
  const panel=document.createElement('section');panel.id='draft-conflict';panel.className='panel';
  panel.innerHTML='<h2>保留的旧草稿</h2><p class="fine">作业已变化或被删除，旧草稿未覆盖服务器内容。请对照核对，也可复制下面文字。</p><label for="draft-conflict-text">旧草稿内容</label><textarea id="draft-conflict-text" rows="8" readonly></textarea>';
  $('#review-view').append(panel);panel.querySelector('textarea').value=JSON.stringify({题目:draft.result.questions,老师备注:draft.teacher_notes,家长回复:draft.feedback},null,2);
}
function collectReview() {
  if($('#review-view').dataset.jobId!==state.job?.id||state.route!==`#review/${state.job?.id}`)throw new Error('页面与作业不一致，请重新打开后核对');
  const result=structuredClone(state.job.result);
  $$('[data-question]').forEach(card=> {
    const q=result.questions[Number(card.dataset.question)];
    card.querySelectorAll('[data-field]').forEach(input=>q[input.dataset.field]=input.value);
  });
  result.observations=$("#observations").value.split("\n").map(s=>s.trim()).filter(Boolean);
  result.warnings=$("#warnings").value.split("\n").map(s=>s.trim()).filter(Boolean);
  const states={};$$('[data-warning-index]').forEach(select=>states[select.dataset.warningText]=select.value);
  if(result.questions.every(q=>q.id)){
    const links={};noteEntries(result).forEach(n=>links[n.key]=structuredClone(n.link));
    $$('[data-note-key]').forEach(row=>{
      const key=row.dataset.noteKey;if(!links[key])return;
      links[key].scope=row.querySelector('[data-note-scope]').value;
      links[key].question_ids=links[key].scope==='questions'?[...row.querySelectorAll('[data-note-question]:checked')].map(input=>input.dataset.noteQuestion):[];
      const use=row.querySelector('[data-note-use]');if(use)links[key].superseded=!use.checked;
    });result.note_links=links;
  }
  result.warning_states=Object.fromEntries(result.warnings.map(text=>[text,states[text]||result.warning_states?.[text]]).filter(([,value])=>value&&value!=='on_confirm'));
  return {revision:state.job.revision,result,teacher_notes:$("#teacher-notes").value,reviewed:$("#reviewed").checked,notes_checked:!!$("#notes-checked")?.checked,...(result.questions.every(q=>q.id)?{confirm_questions:[],confirm_notes:[]}: {})};
}
function confirmationPlan(result,ids,allNotes=false) {
  const ready=id=>ids.includes(id)||result.questions.some(q=>q.id===id&&q.reviewed);
  const notes=noteEntries(result).filter(n=>!n.link.checked&&(allNotes||n.link.scope==='questions'&&n.link.question_ids.some(id=>ids.includes(id))&&n.link.question_ids.every(ready)));
  const resolve=notes.filter(n=>n.kind==='warning'&&warningChoice(n,result)==='on_confirm'&&n.link.question_ids.every(ready));
  const questions=[...new Set([...ids,...resolve.filter(n=>!n.link.question_ids.some(id=>ids.includes(id))).map(n=>n.link.question_ids[0])])];
  return {questions,notes:notes.map(n=>n.key),resolve:resolve.map(n=>n.key)};
}
async function saveReview(rerender=true,confirmQuestions=[],confirmNotes=[],resolveNotes=[]) {
  const ctx=requestContext();
  const feedbackText=$("#feedback")?.value;
  const body=collectReview();
  if(body.confirm_questions){body.confirm_questions=confirmQuestions;body.confirm_notes=confirmNotes;body.resolve_notes=resolveNotes;}
  const job=await api(`/api/jobs/${ctx.jobId}/review`,{method:"PUT",body:JSON.stringify(body),context:ctx});
  if(!applyJob(job,ctx))throw new Error('页面已变化，请重新打开原作业核对保存结果');
  state.dirty=false;
  if(rerender) {renderReview(); if(state.feedbackDirty) $("#feedback").value=feedbackText; updateReviewActions();}
  return state.job;
}
async function saveFeedback(rerender=true) {
  const ctx=requestContext();
  const text=$("#feedback").value.trim();
  if(!text) throw new Error("请先填写或生成家长回复");
  const job=await api(`/api/jobs/${ctx.jobId}/feedback`,{method:"PUT",body:JSON.stringify({revision:state.job.revision,feedback:text}),context:ctx});
  if(!applyJob(job,ctx))throw new Error('页面已变化，请重新打开原作业核对保存结果');
  state.feedbackDirty=false; if(rerender)renderReview();
}
function selectReply(box) {
  box.disabled=false;box.focus();box.select();box.setSelectionRange(0,box.value.length);
}
async function copyReply(text,ctx) {
  if(navigator.clipboard?.writeText){
    try {await navigator.clipboard.writeText(text);return true;}catch{/* Try legacy copying when browser permissions reject the modern API. */}
  }
  if(!contextCurrent(ctx))return false;
  const box=$('#feedback'),disabled=box.disabled,readOnly=box.readOnly;
  try {
    // HTTP LAN pages may lack Clipboard API. Keep this fallback inside the button click.
    box.readOnly=true;selectReply(box);
    return document.execCommand?.('copy')===true;
  }catch{return false;}
  finally{box.disabled=disabled;box.readOnly=readOnly;}
}
async function action(name,button) {
  const id=state.job.id;
  if(state.actionPending)return;
  if($('#review-view').dataset.jobId!==id||state.route!==`#review/${id}`)throw new Error('请重新打开作业后再操作');
  const ctx=requestContext(id);
  if(name==='focus-question'){
    if(busyStates.has(state.job.status))return;
    const index=state.job.result.questions.findIndex(needsQuestionReview),card=$(`[data-question="${index}"]`);
    if(card){const group=card.closest('.other-questions');if(group)group.open=true;card.open=true;card.scrollIntoView({block:'start'});card.querySelector('summary').focus({preventScroll:true});}
    return;
  }
  state.actionPending=true;updateReviewActions();button.disabled=true;
  try {
    if(name==="save-all") {await saveReview(false);if(state.feedbackDirty)await saveFeedback(false);renderReview();toast("复核与回复修改已保存");}
    if(['confirm-question','confirm-remaining','confirm-notes'].includes(name)) {
      const result=collectReview().result,index=Number(button.dataset.confirmQuestion);
      const ids=name==='confirm-question'?[result.questions[index].id]:name==='confirm-remaining'?result.questions.filter(q=>!q.reviewed).map(q=>q.id):[];
      const plan=confirmationPlan(result,ids,name!=='confirm-question');
      await saveReview(true,plan.questions,plan.notes,plan.resolve);toast(name==='confirm-question'?'本题已确认，相关疑问已按所选方式处理':'复核确认已保存');
    }
    if(name==="save-review") {await saveReview();toast("复核结果已保存");}
    if(name==="save-feedback") {if(state.dirty)await saveReview();await saveFeedback();toast("家长回复已保存，请继续确认归档");}
    if(name==="judge-text") {
      const index=Number(button.dataset.questionIndex),question=collectReview().result.questions[index];
      if(!question?.question.trim())throw new Error('请先填写完整题干，再按文字判题');
      if(/\\placeholder\b/.test(question.question+question.student_answer))throw new Error('请先填完整分数或带分数的空格，再重新判题');
      const editedReply=$('#feedback').value,keepReply=state.feedbackDirty;
      if(state.dirty)await saveReview(false);
      if(!contextCurrent(ctx))return;
      try {
        const job=await api(`/api/jobs/${id}/judge-text`,{method:'POST',body:JSON.stringify({revision:state.job.revision,question_index:index}),timeout:240000,context:ctx});
        if(!applyJob(job,ctx))return;
        renderReview();if(keepReply)$('#feedback').value=editedReply;
        const remaining=job.result.questions.filter(needsQuestionReview).length;
        toast(remaining?`判题已更新，还剩${remaining}题需人工处理`:'判题已更新，可以直接生成回复');
      }catch(error){
        if(contextCurrent(ctx)) {
          try {const job=await api(`/api/jobs/${id}`,{context:ctx});if(applyJob(job,ctx)){renderReview();if(keepReply)$('#feedback').value=editedReply;}}catch{/* Never repeat a billable request automatically. */}
        }
        throw error;
      }
    }
    if(name==="generate") {
      if(state.feedbackDirty && !confirm("重新生成会替换当前编辑的回复，继续吗？"))return;
      if(state.job.result.questions.every(q=>q.id)){
        const result=collectReview().result;
        if(result.questions.some(needsQuestionReview))throw new Error('请先补全并重新判题；仍无法判定的题目可选择“保留无法判定并继续”。');
        const acceptance=AutoGradeReview.pendingAcceptance(result.questions);
        if(acceptance.incorrect+acceptance.blank>0&&!confirm(`即将采用 ${acceptance.total} 道未逐题确认的 AI 判定，其中 ${acceptance.incorrect} 道标记错误、${acceptance.blank} 道标记未作答。请确认已对照原图核查；继续后会生成家长回复（1次 API）。`))return;
        const ids=result.questions.filter(q=>!q.reviewed).map(q=>q.id),plan=confirmationPlan(result,ids,true);
        await saveReview(true,plan.questions,plan.notes,plan.resolve);
      }else{
        if(state.job.result.notes_pending&&!$('#notes-checked')?.checked)throw new Error('请先确认相关观察与疑问');
        if(!$('#reviewed').checked)throw new Error('请先确认待复核题目');
        await saveReview();
      }
      if(!contextCurrent(ctx))return;
      await api(`/api/jobs/${id}/feedback`,{method:"POST",body:JSON.stringify({revision:state.job.revision}),context:ctx});
      const job=await api(`/api/jobs/${id}`,{context:ctx});if(!applyJob(job,ctx))return;
      state.feedbackDirty=false;renderReview();toast("正在生成家长回复，你可以稍后回来查看");
    }
    if(name==="confirm") {
      if(state.dirty)await saveReview();
      if(state.feedbackDirty)await saveFeedback();
      if(state.job.feedback_revision!==state.job.revision)throw new Error("回复已过期，请重新生成，或核对修改后保存回复");
      const job=await api(`/api/jobs/${id}/confirm`,{method:"POST",body:JSON.stringify({revision:state.job.revision}),context:ctx});if(!applyJob(job,ctx))return;renderReview();await loadJobs();toast("已确认归档。复制回复后，请回微信发送");
    }
    if(name==="copy") {
      if(state.dirty||state.feedbackDirty)throw new Error("请先保存修改并确认归档，再复制回复");
      if(state.job.status!=="confirmed")throw new Error("请先确认并归档");
      if(state.job.feedback_revision!==state.job.revision)throw new Error('回复已过期，请重新核对并归档后复制');
      const copied=await copyReply(state.job.feedback,ctx);if(!contextCurrent(ctx))return;
      if(copied)toast("回复已复制，请回微信粘贴发送");
      else{selectReply($('#feedback'));toast('自动复制受限，已选中回复，请手动复制。');}
    }
    if(name==="retry") {await api(`/api/jobs/${id}/retry`,{method:"POST",body:JSON.stringify({revision:state.job.revision}),context:ctx});const job=await api(`/api/jobs/${id}`,{context:ctx});if(applyJob(job,ctx))renderReview();}
    if(name==="delete" && confirm("删除这份作业及照片？引用它的历史依据也会失效。此操作不能撤销。")) {await api(`/api/jobs/${id}`,{method:"DELETE",context:ctx});if(contextCurrent(ctx)){state.dirty=false;state.feedbackDirty=false;location.hash="#queue";toast("作业已删除");}}
  } finally {if(contextCurrent(ctx,false)){state.actionPending=false;updateReviewActions();}}
}
function editQuestionList(change) {
  if(state.actionPending||busyStates.has(state.job?.status))return;
  const draft=snapshotReview();if(!draft)return;
  const before=structuredClone(draft.result.questions);
  change(draft.result.questions);
  for(const q of draft.result.questions)if(!q.id){q.id=createSubmitKey();q.reviewed=false;q.judgment_pending=true;}
  const remaining=new Set(draft.result.questions.map(q=>q.id)),removed=before.filter(q=>!remaining.has(q.id));
  for(const n of noteEntries(draft.result))if(n.link.scope==='questions'&&removed.some(q=>n.link.question_ids.includes(q.id))){n.link.scope='unassigned';n.link.question_ids=[];n.link.checked=false;}
  state.job={...state.job,result:draft.result,teacher_notes:draft.teacher_notes,reviewed:false,feedback:draft.feedback};
  state.dirty=true;$('#image-dialog').close();renderReview();state.feedbackDirty=draft.feedbackDirty;updateReviewActions();
}
function showPreview(url,title) {
  $('#preview-title').textContent=title;$('#preview-image').src=url;$('#preview-dialog').showModal();
}

let zoom=1,cropEnabled=false,cropStart=null,cropSelection=null,imagePhoto=null,imageQuestion=null,imageIsOriginal=false,imageOpenSerial=0;
async function openImage(photoIndex,questionIndex=null,crop=false,original=false) {
  if(crop&&(state.dirty||state.feedbackDirty))throw new Error('请先保存修改，再调整位置或重识别；仍可只读查看原图');
  const serial=++imageOpenSerial,ctx=requestContext();
  imageIsOriginal=original;imagePhoto=(original?state.job.materials:state.job.photos)[photoIndex];imageQuestion=questionIndex;
  zoom=1;cropSelection=null;cropEnabled=false;$("#crop-toggle").classList.remove("active");$("#crop-canvas").hidden=true;$("#crop-submit").hidden=true;$("#location-submit").hidden=true;
  $('#image-text-details').open=false;$('.image-more').open=false;
  $("#image-title").textContent=`第${imagePhoto.page}页${questionIndex!==null?` · ${state.job.result.questions[questionIndex].number}`:""}`;
  $("#image-stage").classList.remove('selecting');$("#image-stage").style.width="100%";$("#full-image").src=`/images/${imagePhoto.id}`;
  $("#download-original").href=`/images/${imagePhoto.id}?variant=original`;
  const questions=state.job.result?.questions||[];
  const pageQuestions=questions.map((q,i)=>({q,i})).filter(({q})=>!original&&q.page===imagePhoto.page);
  $("#image-reading").hidden=!pageQuestions.length;
  $("#image-question-select").innerHTML=pageQuestions.map(({q,i})=>`<option value="${i}">${escapeHTML(q.number)} · ${labels[q.status]}</option>`).join('');
  if(imageQuestion===null&&pageQuestions.length)imageQuestion=pageQuestions[0].i;
  if(imageQuestion!==null)$("#image-question-select").value=imageQuestion;
  renderRegions();
  $("#image-scroll").scrollTo(0,0);
  $("#image-dialog").showModal();
  if($("#full-image").complete&&$("#full-image").naturalWidth)focusRegion();
  if(crop) {if($("#full-image").complete)toggleCrop();else $("#full-image").addEventListener("load",()=>{if(serial===imageOpenSerial&&contextCurrent(ctx)&&$('#image-dialog').open)toggleCrop();},{once:true});}
}
function renderRegions() {
  const regions=$("#question-regions");regions.replaceChildren();
  $("#page-locate").hidden=imageIsOriginal;
  const locked=busyStates.has(state.job.status)||state.actionPending,unsaved=state.dirty||state.feedbackDirty;
  $('#page-locate').disabled=locked||unsaved;$('#crop-toggle').disabled=locked||unsaved;$('#image-question-select').disabled=state.actionPending;
  if(imageIsOriginal){$('#image-title').textContent=`空白原题 · ${imagePhoto.name} · 第${imagePhoto.source_page}页`;$('#image-question-text').textContent='';$('#crop-toggle').hidden=true;$('#crop-help').textContent='这是空白原题，可下载原文件核对版本。';return;}
  const questions=unsaved?snapshotReview()?.result.questions||state.job.result?.questions:state.job.result?.questions;
  const question=questions?.[imageQuestion];
  $("#image-title").textContent=`第${imagePhoto.page}页${question?' · '+question.number:''}`;
  $("#image-question-text").innerHTML=question?`<strong>原题：</strong>${AutoGradeText.textHTML(question.question)}<br><strong>实际作答：</strong>${AutoGradeText.textHTML(question.student_answer)}<br>${labels[question.status]} · ${AutoGradeText.textHTML(question.explanation)}`:'';
  $("#crop-toggle").hidden=imageQuestion===null||busyStates.has(state.job.status);
  $("#crop-help").textContent=unsaved?'修改尚未保存：可只读查看，保存后才能调整位置或重识别。':question?.bbox?(question.bbox_source==='teacher'?'当前框为老师保存的区域。':question.bbox_source==='ocr'?'当前框来自 OCR 关联，仍需核对。':'当前框为模型估计，可手动调整。'):'此题尚无位置框，可手动框选并免费保存。';
  (state.job.result?.questions||[]).forEach((q,i)=>{
    if(q.page!==imagePhoto.page||!q.bbox)return;
    const box=document.createElement('button');box.type='button';box.className=`region-box ${q.status}${i===imageQuestion?' selected':''}`;box.dataset.regionQuestion=i;
    box.disabled=state.actionPending;
    box.setAttribute('aria-label',`定位 ${q.number} ${labels[q.status]}`);
    const b=q.bbox;box.style.left=`${b.x*100}%`;box.style.top=`${b.y*100}%`;box.style.width=`${b.width*100}%`;box.style.height=`${b.height*100}%`;
    const label=document.createElement('span');label.textContent=q.number;box.append(label);regions.append(box);
  });
}
function focusRegion() {
  if(imageIsOriginal||!state.job||!$('#image-dialog').open)return;
  const box=state.job.result?.questions[imageQuestion]?.bbox;
  if(!box)return;
  const image=$("#full-image"),scroll=$("#image-scroll");
  scroll.scrollTo({left:Math.max(0,(box.x+box.width/2)*image.clientWidth-scroll.clientWidth/2),top:Math.max(0,(box.y+box.height/2)*image.clientHeight-scroll.clientHeight/2)});
}
function selectImageQuestion(index) {
  imageQuestion=index;cropEnabled=false;cropStart=null;cropSelection=null;
  $("#crop-canvas").hidden=true;$("#crop-toggle").classList.remove('active');$("#crop-submit").hidden=true;$("#location-submit").hidden=true;
  $("#image-stage").classList.remove('selecting');$("#image-question-select").value=index;
  renderRegions();focusRegion();
}
function sizeCanvas() {
  const canvas=$("#crop-canvas"),image=$("#full-image");
  canvas.width=image.clientWidth;canvas.height=image.clientHeight;
  drawSelection();
}
function drawSelection() {
  const canvas=$("#crop-canvas"),ctx=canvas.getContext("2d");ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!cropSelection)return;
  const {x,y,width,height}=cropSelection;
  ctx.fillStyle="#306b5225";ctx.strokeStyle="#306b52";ctx.lineWidth=2;
  ctx.fillRect(x*canvas.width,y*canvas.height,width*canvas.width,height*canvas.height);
  ctx.strokeRect(x*canvas.width,y*canvas.height,width*canvas.width,height*canvas.height);
}
function toggleCrop() {
  if(state.actionPending||busyStates.has(state.job?.status)||state.dirty||state.feedbackDirty){toast('请先保存修改或等待当前操作完成');return;}
  $('#image-text-details').open=false;$('.image-more').open=false;
  cropEnabled=!cropEnabled;$("#crop-canvas").hidden=!cropEnabled;$("#crop-toggle").classList.toggle("active",cropEnabled);
  $("#image-stage").classList.toggle('selecting',cropEnabled);
  if(cropEnabled)$("#crop-help").textContent="拖动框选完整题干与作答。可仅保存位置（免费），或重识别（一次 API 调用）。";else renderRegions();
  $("#crop-submit").hidden=!cropEnabled||!cropSelection;$("#location-submit").hidden=!cropEnabled||!cropSelection;sizeCanvas();
}
function pointerPosition(event) {const r=$("#crop-canvas").getBoundingClientRect();return{x:Math.min(1,Math.max(0,(event.clientX-r.left)/r.width)),y:Math.min(1,Math.max(0,(event.clientY-r.top)/r.height))};}

function accountUsageHTML(usage) {
  const estimates=Object.entries(usage.costs).map(([currency,cost])=>`${escapeHTML(currency)} ${cost.min.toFixed(4)}–${cost.max.toFixed(4)}`).join('；')||'暂无费用估算';
  return `<p>${usage.calls}次已记录调用 · 输入 ${tokens(usage.input_tokens)} / 输出 ${tokens(usage.output_tokens)} Token</p><p class="fine">累计估算：${estimates}${usage.unpriced_calls?`（${usage.unpriced_calls}次未估价）`:''}</p>`;
}
async function loadAccounts() {
  const ctx=requestContext();
  $('#account-usage').textContent='正在读取用量…';
  const usage=await api('/api/account/usage',{context:ctx});
  if(!contextCurrent(ctx,false)||state.route!=='#account')return;
  $('#account-usage').innerHTML=accountUsageHTML(usage);
  if(!state.user.is_admin)return;
  const [users,totals]=await Promise.all([api('/api/admin/users',{context:ctx}),api('/api/admin/usage',{context:ctx})]);
  if(!contextCurrent(ctx,false)||state.route!=='#account')return;
  $('#users-list').innerHTML=users.map(user=>{
    const total=totals.find(item=>item.user_id===user.id);
    return `<article class="job-card"><div class="job-card-head"><span class="avatar">${escapeHTML(user.display_name.slice(0,1))}</span><div><strong>${escapeHTML(user.display_name)}</strong><small>${escapeHTML(user.username)} · ${user.is_admin?'管理员':user.enabled?'已启用':'已停用'}${user.must_change_password?' · 待改初始密码':''}</small></div></div>${total?accountUsageHTML(total):''}${!user.is_admin?`<div class="job-card-footer"><button type="button" class="text-button" data-reset-user="${user.id}" data-username="${escapeHTML(user.username)}">重置密码</button><button type="button" class="text-button ${user.enabled?'error-text':''}" data-status-user="${user.id}" data-enabled="${user.enabled?'0':'1'}">${user.enabled?'停用账号':'启用账号'}</button></div>`:''}</article>`;
  }).join('');
}
$('#password-form').addEventListener('submit',async event=>{
  event.preventDefault();$('#password-error').textContent='';
  if($('#new-password').value!==$('#confirm-password').value){$('#password-error').textContent='两次新密码不一致';return;}
  const button=event.target.querySelector('button[type="submit"]');button.disabled=true;
  try {
    await api('/api/account/password',{method:'PUT',body:JSON.stringify({old_password:$('#old-password').value,new_password:$('#new-password').value})});
    clearPrivateState();state.csrf='';state.user=null;showLogin();toast('密码已修改，请使用新密码重新登录。');
  }catch(error){$('#password-error').textContent=error.message;}finally{button.disabled=false;}
});
$('#logout-all').addEventListener('click',async()=>{
  if(!confirm('退出所有设备？未保存的修改和所选照片将清除，已受理的任务会继续处理。'))return;
  try{await api('/api/logout-all',{method:'POST'});clearPrivateState();state.csrf='';state.user=null;showLogin();toast('已退出所有设备。');}catch(error){toast(error.message);}
});
$('#create-user-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.target.querySelector('button[type="submit"]');button.disabled=true;$('#create-user-error').textContent='';
  try{
    await api('/api/admin/users',{method:'POST',body:JSON.stringify({username:$('#teacher-username').value.trim(),display_name:$('#teacher-name').value.trim(),password:$('#teacher-password').value})});
    event.target.reset();toast('老师账号已创建，首次登录需修改临时密码。');await loadAccounts();
  }catch(error){$('#create-user-error').textContent=error.message;}finally{button.disabled=false;}
});
$('#users-list').addEventListener('click',async event=>{
  const reset=event.target.closest('[data-reset-user]');
  if(reset){$('#reset-password-form').dataset.userId=reset.dataset.resetUser;$('#reset-password-form').reset();$('#reset-password-error').textContent='';$('#reset-password-name').textContent=`账号：${reset.dataset.username}`;$('#reset-password-dialog').showModal();return;}
  const button=event.target.closest('[data-status-user]');if(!button)return;
  const enabled=button.dataset.enabled==='1';
  if(!confirm(enabled?'启用该账号？排队中的任务将在其改完密码后继续。':'停用该账号？所有登录将失效，排队任务暂停；已经发出的模型请求可能继续计费。'))return;
  button.disabled=true;
  try{await api(`/api/admin/users/${button.dataset.statusUser}/status`,{method:'PUT',body:JSON.stringify({enabled})});await loadAccounts();}catch(error){toast(error.message);button.disabled=false;}
});
$('#reset-password-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.target.querySelector('button[type="submit"]');button.disabled=true;$('#reset-password-error').textContent='';
  try{await api(`/api/admin/users/${event.target.dataset.userId}/password`,{method:'PUT',body:JSON.stringify({password:$('#reset-password').value})});event.target.reset();$('#reset-password-dialog').close();toast('密码已重置，老师重新登录后需修改临时密码。');await loadAccounts();}catch(error){$('#reset-password-error').textContent=error.message;}finally{button.disabled=false;}
});
$("#login-form").addEventListener("submit",async event=>{
  event.preventDefault();const button=event.target.querySelector('button[type="submit"]');button.disabled=true;$("#login-error").textContent="";
  state.authEpoch++;state.generation++;
  try {await api("/api/login",{method:"POST",body:JSON.stringify({username:$('#username').value.trim(),password:$("#password").value})});$("#password").value="";await start();}catch(error){$("#login-error").textContent=error.message;}finally{button.disabled=false;}
});
async function logout() {
  if(state.actionPending||state.uploading||state.submission?.checking){toast('请先结束当前操作');return;}
  try {
    if(state.submission&&!confirm('本次上传的结果尚未确认，退出不会取消服务器批改。退出会清除本机草稿和照片选择，已受理的作业可重新登录后在待办查看。确认退出？'))return;
    if((state.dirty||state.feedbackDirty)&&!confirm('有未保存的修改，仍然退出吗？'))return;
    await api('/api/logout',{method:'POST'});clearPrivateState();state.csrf='';state.user=null;showLogin();
  }catch(error){toast(error.message);}
}
$('#logout').addEventListener('click',logout);$('#mobile-logout').addEventListener('click',logout);
$("#refresh").addEventListener("click",()=>loadJobs().catch(e=>toast(e.message)));
$('#jobs-list').addEventListener('click',event=>{
  if(!event.target.closest('[data-clear-job-filters]'))return;
  $('#job-student-filter').value='';
  $('#job-day-from').value='';$('#job-day-to').value='';
  state.filter='all';state.page=1;
  $$('[data-filter]').forEach(button=>{const active=button.dataset.filter==='all';button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  updateJobFilterSummary();
  loadJobs().catch(e=>toast(e.message));
});
$$('[data-filter]').forEach(button=>button.addEventListener('click',()=>{state.filter=button.dataset.filter;state.page=1;$$('[data-filter]').forEach(el=>{el.classList.toggle('active',el===button);el.setAttribute('aria-pressed',String(el===button));});loadJobs().catch(e=>toast(e.message));}));
['#job-student-filter','#job-day-from','#job-day-to'].forEach(selector=>$(selector).addEventListener('change',()=>{state.page=1;updateJobFilterSummary();loadJobs().catch(e=>toast(e.message));}));
$('#job-pagination').addEventListener('click',event=>{const button=event.target.closest('[data-job-page]');if(button&&!button.disabled){state.page=Number(button.dataset.jobPage);loadJobs().catch(e=>toast(e.message));}});
$('#upload-cancel').addEventListener('click',()=>state.uploadXHR?.abort());
$('#upload-check').addEventListener('click',checkSubmission);
$('#upload-release').addEventListener('click',releaseSubmission);
for(const id of ["#add-student","#add-student-page"])$(id).addEventListener("click",()=>{$("#student-form").reset();$("#student-dialog").showModal();});
$("#student-form").addEventListener("submit",async event=>{
  event.preventDefault();const button=event.target.querySelector('button[type=submit]');button.disabled=true;
  try {const value=await api("/api/students",{method:"POST",body:JSON.stringify({name:$("#student-name").value,grade:$("#student-grade").value})});await loadStudents();$("#student-select").value=value.id;updateUploadSummary();state.submitKey="";$("#student-dialog").close();toast("学生已创建");}catch(e){toast(e.message);}finally{button.disabled=false;}
});
$("#photo-input").addEventListener("change",event=>{addPhotos([...event.target.files]);event.target.value="";});
  ["#student-select","#assignment-day"].forEach(selector=>$(selector).addEventListener("change",updateUploadSummary));
$('#original-input').addEventListener('change',event=>{addOriginals([...event.target.files]);event.target.value='';});
$('#original-list').addEventListener('click',event=>{
  const preview=event.target.closest('[data-preview-original]');if(preview){const item=state.originals[Number(preview.dataset.previewOriginal)];showPreview(item.url,(item.pdf?'PDF内部第1页 · ':'')+item.file.name);return;}
  if(uploadLocked())return;
  const retry=event.target.closest('[data-preview]');
  if(retry){queuePreview(state.originals[Number(retry.dataset.preview)]);renderOriginals(false);return;}
  const remove=event.target.closest('[data-remove-original]');if(!remove)return;
  const i=Number(remove.dataset.removeOriginal),item=state.originals[i];discardPhoto(item);state.originals.splice(i,1);
  state.files.forEach(file=>{if(file.source===i){file.source=null;file.sourcePage=1;}else if(Number.isInteger(file.source)&&file.source>i)file.source--;});
  state.submitKey='';renderOriginals();
});
$('#material-mapping').addEventListener('change',event=>{
  if(uploadLocked())return;
  const file=event.target.dataset.sourceFile,page=event.target.dataset.sourcePage;
  if(file!==undefined){state.files[Number(file)].source=event.target.value===''?null:Number(event.target.value);state.files[Number(file)].sourcePage=1;renderMapping();}
  if(page!==undefined){state.files[Number(page)].sourcePage=Number(event.target.value);renderMapping();}
  state.submitKey='';
});
$('#material-mapping').addEventListener('click',event=>{const button=event.target.closest('[data-mapping-preview]');if(button){const item=state.files[Number(button.dataset.mappingPreview)],source=state.originals[item.source];showPreview(source.pages[item.sourcePage-1].preview,`PDF内部第${item.sourcePage}页 · ${source.file.name}`);}});
$("#dropzone").addEventListener("dragover",event=>event.preventDefault());
$("#dropzone").addEventListener("drop",event=>{event.preventDefault();addPhotos([...event.dataTransfer.files]);});
$("#photo-list").addEventListener("click",event=>{
  const view=event.target.closest('[data-view-photo]');if(view){const item=state.files[Number(view.dataset.viewPhoto)];showPreview(item.url,`作业第${Number(view.dataset.viewPhoto)+1}页 · ${item.file.name}`);return;}
  if(uploadLocked())return;
  const retry=event.target.closest('[data-preview]');
  if(retry){queuePreview(state.files[Number(retry.dataset.preview)]);renderPhotos(false);return;}
  const remove=event.target.closest('[data-remove-photo]'),move=event.target.closest('[data-move-photo]');
  if(!remove&&!move)return; // Preserve the native details toggle; only rebuild after a real edit.
  if(remove){const i=Number(remove.dataset.removePhoto);discardPhoto(state.files[i]);state.files.splice(i,1);}
  if(move){const i=Number(move.dataset.movePhoto),j=i+Number(move.dataset.direction);[state.files[i],state.files[j]]=[state.files[j],state.files[i]];}
  $('#photo-list').querySelectorAll('.photo-actions[open]').forEach(menu=>menu.open=false);
   state.submitKey="";renderPhotos();
});
$("#upload-form").addEventListener("input",()=>{if(!uploadLocked())state.submitKey="";});
async function submitUpload(event) {
  event.preventDefault();if(state.uploading||state.submission?.checking)return;
  if(!state.files.length){toast("请先选择作业照片");return;}
  if(!state.apiConfigured){toast("请先在 .env 填写密钥并重启服务");return;}
  const student=state.students.find(s=>s.id===$("#student-select").value);
  if(!student){toast("请选择学生");return;}
  const mapped=state.files.filter(x=>Number.isInteger(x.source));
  if(!state.submission) {
    if(state.originals.length&&!mapped.length){toast('请选择至少一张作业对应的原题，或移除未使用的原题文件');return;}
    if(state.originals.some(x=>x.pdf&&!x.pageCount)){toast('请先完成 PDF 预览，或移除预览失败的原题');return;}
    if(state.originals.reduce((sum,x)=>sum+(x.pdf?x.pageCount:1),0)>10){toast('原题展开后超过10页，请减少文件');return;}
    if(!confirm(`确认提交${student.name}的作业？\n${$('#assignment-day').value} · ${state.files.length}张作业 · ${mapped.length}张有原题对照`))return;
    state.submitKey ||= createSubmitKey();
    const form=new FormData();form.append('student_id',student.id);form.append('day',$('#assignment-day').value);form.append('reference',$('#reference').value);form.append('submit_key',state.submitKey);
    state.files.forEach(x=>form.append('files',x.file));state.originals.forEach(x=>form.append('original_files',x.file));
    form.append('material_map',JSON.stringify(state.files.map(x=>Number.isInteger(x.source)?{file_index:x.source,page:state.originals[x.source].pdf?x.sourcePage:1}:null)));
    state.submission={key:state.submitKey,form,uncertain:false,checking:false};
  } else if(!confirm('使用完全相同的照片、学生、日期和提交键重试？已受理时会返回原任务，不会另建一份。'))return;
  const submission=state.submission,ctx=requestContext();
  state.uploading=true;updateUploadState();showUploadProgress('开始上传，请保持页面打开…',0);
  try{const job=await uploadWithProgress(submission.form);await completeUpload(job,submission,ctx);}
  catch(error){
    if(state.submission!==submission)return;
    const rejected=error.status>=400&&error.status<500&&error.status!==401;
    if(rejected&&!submission.uncertain)state.submission=null;
    else submission.uncertain=true;
    toast(error.message);showUploadProgress(error.message);
  } finally {if(state.submission===submission||!state.submission){state.uploading=false;updateUploadState();}}
}
$("#upload-form").addEventListener("submit",event=>submitUpload(event).catch(error=>toast(`提交未完成：${error.message}`)));
$("#review-view").addEventListener("input",event=>{
  if(event.target.id==="feedback")state.feedbackDirty=true;else if(event.target.matches("input,textarea,select"))state.dirty=true;
  if(event.target.dataset.field){
    updateTextPreview(event.target);
    const card=event.target.closest('[data-question]');
    markQuestionChanged(Number(card.dataset.question),event.target.dataset.field,event.target.value);
    updateQuestionSummary(collectReview().result.questions);
  }else if(event.target.dataset.warningText){
    const text=event.target.dataset.warningText,value=event.target.value;
    $$('[data-warning-index]').filter(select=>select.dataset.warningText===text).forEach(select=>select.value=value);
    if(value==='on_confirm')delete state.job.result.warning_states[text];else state.job.result.warning_states[text]=value;
    state.job.result.note_links['warning:'+text].checked=false;
    updateScopedReview();
  }else if(event.target.closest('[data-note-key]')){
    const result=collectReview().result,row=event.target.closest('[data-note-key]');
    result.note_links[row.dataset.noteKey].checked=false;
    state.job.result.note_links=result.note_links;state.job.result.warning_states=result.warning_states;
    row.querySelector('.note-question-links').hidden=result.note_links[row.dataset.noteKey].scope!=='questions';
    updateScopedReview();
  }
  if(['warnings','observations'].includes(event.target.id)){
    const result=collectReview().result;state.job.result.note_links=result.note_links;state.job.result.warning_states=result.warning_states;
    state.job.result.observations=result.observations;state.job.result.warnings=result.warnings;
    $('#note-review-list').innerHTML=noteEditorHTML(result);updateScopedReview();
  }
  updateReviewActions();
});
$("#review-view").addEventListener("change",event=>{
  if(event.target.dataset.field==="status"){
    const card=event.target.closest('[data-question]');card.querySelector('summary .badge').outerHTML=badge(event.target.value);
  }
  updateReviewActions();
});
$("#review-view").addEventListener("pointerdown",event=>{
  if(event.target.closest('[data-math-symbol]'))event.preventDefault();
});
$("#review-view").addEventListener("click",async event=>{
  try{
    const symbol=event.target.closest('[data-math-symbol]');if(symbol){insertMathSymbol(symbol);return;}
    const note=event.target.closest('[data-edit-note]');if(note){$('#review-records').open=true;const row=$$('[data-note-key]').find(row=>row.dataset.noteKey===note.dataset.editNote);row?.scrollIntoView({block:'center'});row?.querySelector('select')?.focus();return;}
    const add=event.target.closest('[data-add-question]');if(add){if(state.actionPending||busyStates.has(state.job.status))return;$('#question-page').innerHTML=state.job.photos.map(p=>`<option value="${p.page}">第${p.page}页</option>`).join('');$('#question-number').value='';$('#question-dialog').showModal();return;}
    const remove=event.target.closest('[data-delete-question]');if(remove){if(state.actionPending||busyStates.has(state.job.status))return;if(state.job.result.questions.length===1){toast('至少保留一道题；无法识别的内容可标为无法判定');return;}if(confirm('删除这条题目批改记录？作业照片会保留，保存前不会写入服务器。'))editQuestionList(questions=>questions.splice(Number(remove.dataset.deleteQuestion),1));return;}
    const button=event.target.closest('[data-action]');if(button){await action(button.dataset.action,button);return;}
    const original=event.target.closest('[data-original-id]');if(original){const index=state.job.materials.findIndex(m=>m.id===original.dataset.originalId);if(index>=0)await openImage(index,null,false,true);return;}
    const photo=event.target.closest('[data-image-page]');if(photo){await openImage(Number(photo.dataset.imagePage));return;}
    const q=event.target.closest('[data-image-question],[data-crop-question]');if(q){const i=Number(q.dataset.imageQuestion??q.dataset.cropQuestion);const page=state.job.result.questions[i].page;await openImage(page-1,i,q.dataset.cropQuestion!==undefined);}
  }catch(e){toast(e.message);}
});
$('#question-form').addEventListener('submit',event=>{
  event.preventDefault();if(state.actionPending||busyStates.has(state.job?.status))return;
  if(state.job.result.questions.length>=200){toast('一份作业最多200题');return;}
  const page=Number($('#question-page').value),number=$('#question-number').value.trim();
  if(!number||!state.job.photos.some(p=>p.page===page))return;
  editQuestionList(questions=>questions.push({page,number,question:'',student_answer:'',expected_answer:'',status:'uncertain',explanation:'',knowledge_point:'',bbox:null,bbox_source:'teacher',anchor_ids:[],source_match:'not_provided'}));
  $('#question-dialog').close();const card=$(`[data-question="${state.job.result.questions.length-1}"]`);card.scrollIntoView({block:'center'});card.querySelector('textarea').focus();
});
async function loadHistory(studentId,page=1) {
  const student=state.students.find(s=>s.id===studentId);if(!student)return;
  const ctx=requestContext(),serial=++state.historyRequest;state.history={studentId,page};
  const value=await api(`/api/jobs?filter=all&student_id=${encodeURIComponent(studentId)}&page=${page}&page_size=30`,{context:ctx});
  if(!contextCurrent(ctx,false)||state.route!=='#students'||serial!==state.historyRequest)return;
  if(!value.items.length&&page>1&&page>Math.ceil(value.total/30))return loadHistory(studentId,Math.max(1,Math.ceil(value.total/30)));
  $('#student-history').hidden=false;$('#student-history').innerHTML=`<div class="student-history-heading"><h2>${escapeHTML(student.name)}的作业记录</h2><button class="text-button" id="close-history">收起</button></div><div class="job-grid">${value.items.length?value.items.map(jobCard).join(''):'<div class="empty-state"><p class="muted">尚未关联作业。</p></div>'}</div><div class="pagination">${pagination(page,value.total,'data-history-page')}</div>`;
}
$('#students-list').addEventListener('click',async event=>{
  try {
    const history=event.target.closest('[data-student-history]');
    if(history){await loadHistory(history.dataset.studentHistory);if(state.route==='#students')$('#student-history').scrollIntoView({behavior:'smooth'});return;}
    const remove=event.target.closest('[data-delete-student]');
    if(remove&&confirm('删除学生档案及其全部作业、照片和历史记录？此操作不能撤销。')){
      const ctx=requestContext();await api(`/api/students/${remove.dataset.deleteStudent}`,{method:'DELETE',context:ctx});
      if(!contextCurrent(ctx,false))return;await loadStudents();await loadJobs();$('#student-history').hidden=true;toast('档案已删除');
    }
  }catch(error){toast(error.message);}
});
$('#student-history').addEventListener('click',event=>{
  if(event.target.id==='close-history'){state.history=null;state.historyRequest++;$('#student-history').hidden=true;return;}
  const button=event.target.closest('[data-history-page]');if(button&&!button.disabled&&state.history)loadHistory(state.history.studentId,Number(button.dataset.historyPage)).catch(e=>toast(e.message));
});
$$('[data-close]').forEach(button=>button.addEventListener("click",()=>$("#"+button.dataset.close).close()));
$("#zoom-in").addEventListener("click",()=>{zoom=Math.min(4,zoom+.5);$("#image-stage").style.width=`${zoom*100}%`;sizeCanvas();if(!cropEnabled)focusRegion();});
$("#zoom-out").addEventListener("click",()=>{zoom=Math.max(1,zoom-.5);$("#image-stage").style.width=`${zoom*100}%`;sizeCanvas();if(!cropEnabled)focusRegion();});
async function imageOperation(kind) {
  if(state.actionPending||busyStates.has(state.job?.status)||state.dirty||state.feedbackDirty||imageIsOriginal)return;
  if(kind!=='locate'&&(!cropSelection||imageQuestion===null))return;
  const ctx=requestContext(),photoId=imagePhoto.id,index=imageQuestion;
  const bbox=cropSelection?{...cropSelection,width:Math.min(cropSelection.width,1-cropSelection.x),height:Math.min(cropSelection.height,1-cropSelection.y)}:null;
  const body=kind==='locate'?{revision:state.job.revision,photo_id:photoId}:{revision:state.job.revision,photo_id:photoId,question_index:index,...(kind==='location'?{bbox}:bbox)};
  state.actionPending=true;updateReviewActions();renderRegions();
  $('#crop-submit').disabled=true;$('#location-submit').disabled=true;
  try {
    const job=await api(`/api/jobs/${ctx.jobId}/${kind}`,{method:kind==='location'?'PUT':'POST',body:JSON.stringify(body),timeout:kind==='location'?30000:240000,context:ctx});
    if(!applyJob(job,ctx))return;
    renderReview();
    if(kind==='crop'){$('#image-dialog').close();toast(job.result.questions.some(needsQuestionReview)?'重识别已更新，请处理剩余无法判定的题目':'重识别已有判定，可以直接生成回复');}
    else {selectImageQuestion(index);toast(kind==='location'?'位置已保存，没有调用 API':'本页位置已更新，请核对，老师标记已保留');}
  } catch(error) {
    if(contextCurrent(ctx)) {
      try {const job=await api(`/api/jobs/${ctx.jobId}`,{context:ctx});if(applyJob(job,ctx))renderReview();}catch{/* Keep the previous answers; never retry a paid operation automatically. */}
      toast(error.message);
    }
  } finally {
    if(contextCurrent(ctx,false)){state.actionPending=false;updateReviewActions();if($('#image-dialog').open){renderRegions();$('#crop-submit').disabled=busyStates.has(state.job.status);$('#location-submit').disabled=busyStates.has(state.job.status);}}
  }
}
$('#page-locate').addEventListener('click',()=>imageOperation('locate'));
$("#crop-toggle").addEventListener("click",toggleCrop);
$("#full-image").addEventListener("load",()=>{if(!state.job||!$('#image-dialog').open)return;sizeCanvas();if(!cropEnabled)focusRegion();});
$("#image-question-select").addEventListener('change',event=>selectImageQuestion(Number(event.target.value)));
$("#question-regions").addEventListener('click',event=>{const box=event.target.closest('[data-region-question]');if(box)selectImageQuestion(Number(box.dataset.regionQuestion));});
$("#crop-canvas").addEventListener("pointerdown",event=>{if(!cropEnabled||state.actionPending)return;cropStart=pointerPosition(event);event.target.setPointerCapture(event.pointerId);event.preventDefault();});
$("#crop-canvas").addEventListener("pointermove",event=>{if(!cropStart)return;const end=pointerPosition(event);cropSelection={x:Math.min(cropStart.x,end.x),y:Math.min(cropStart.y,end.y),width:Math.abs(cropStart.x-end.x),height:Math.abs(cropStart.y-end.y)};drawSelection();});
$("#crop-canvas").addEventListener("pointerup",()=>{cropStart=null;const hidden=!cropSelection||cropSelection.width<.01||cropSelection.height<.01;$("#crop-submit").hidden=hidden;$("#location-submit").hidden=hidden;});
$("#crop-canvas").addEventListener("pointercancel",()=>{cropStart=null;});
$('#location-submit').addEventListener('click',()=>imageOperation('location'));
$('#crop-submit').addEventListener('click',()=>imageOperation('crop'));
window.addEventListener("hashchange",()=>route().catch(e=>toast(e.message)));
window.addEventListener("beforeunload",event=>{if(state.dirty||state.feedbackDirty||state.uploading||state.submission||state.actionPending){event.preventDefault();event.returnValue="";}});
async function poll() {
  if(!state.csrf||document.hidden||state.pollInFlight)return;
  state.pollInFlight=true;const ctx=requestContext();
  try{
    const keepReply=state.feedbackDirty&&busyStates.has(state.job?.status),reply=keepReply?$('#feedback')?.value:null;
    if(state.route.startsWith("#review/")&&state.job&&!state.actionPending&&!state.dirty&&(!state.feedbackDirty||keepReply)&&!$('dialog[open]')){
      const job=await api(`/api/jobs/${ctx.jobId}`,{context:ctx});
      if(contextCurrent(ctx)&&!state.actionPending&&!state.dirty&&(!state.feedbackDirty||keepReply)&&!$('dialog[open]')){
        state.progressCheck={jobId:job.id,checkedAt:Date.now(),failed:false};
        if((job.status!==state.job.status||job.revision!==state.job.revision||job.updated!==state.job.updated)&&applyJob(job,ctx)){
          renderReview();if(keepReply&&state.feedbackDirty){$('#feedback').value=reply;updateReviewActions();}
        }
        updateProcessingProgress();
      }
    }
    if(contextCurrent(ctx,false)&&state.route==="#queue")await loadJobs();
  }catch(e){if(contextCurrent(ctx,false)&&state.csrf){
    if(contextCurrent(ctx)&&['queued','processing'].includes(state.job?.status)){
      state.progressCheck={jobId:ctx.jobId,checkedAt:state.progressCheck?.checkedAt||Date.now(),failed:true};updateProcessingProgress();
    }else toast(e.message);
  }}
  finally{state.pollInFlight=false;}
}
document.addEventListener("visibilitychange",()=>{if(!document.hidden)poll();});
setInterval(poll,5000);
setInterval(updateProcessingProgress,1000);
start().catch(()=>{if(!state.csrf)showLogin();});
})();
