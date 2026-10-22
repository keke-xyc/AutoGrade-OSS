// Offline checks for selection, preview queues and submission recovery; no browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8');
const AutoGradeWorkspace = require('../static/workspace-ui.js');
const drain = () => new Promise(resolve=>setImmediate(resolve));
const response = {ok:true,blob:async()=>new Blob(['small JPEG'])};

function harness() {
  const pending=[],revoked=[],messages=[],timers=new Map(),nodes=new Map(),drawn=[],xhrs=[],requests=[];
  const state={files:[],originals:[],csrf:'offline-test',authEpoch:0,generation:0,dirty:false,
    feedbackDirty:false,actionPending:false,submission:null};
  let timerId=0,urlId=0,decode=async()=>({width:3000,height:4000,close(){}}),implementation=async()=>({id:null});
  const node=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{value:'',hidden:false,textContent:'',disabled:false,events:{},
      close(){},removeAttribute(name){delete this[name];},addEventListener(name,handler){this.events[name]=handler;}});
    return nodes.get(selector);
  };
  class OfflineXHR {
    constructor(){this.upload={};this.headers={};this.status=0;this.responseText='';xhrs.push(this);}
    open(method,url){this.method=method;this.url=url;}
    setRequestHeader(name,value){this.headers[name]=value;}
    send(form){this.form=form;}
    abort(){this.onabort?.();}
  }
  const context=vm.createContext({state,AutoGradeWorkspace,FormData,AbortController,Blob,XMLHttpRequest:OfflineXHR,
    location:{hash:'#upload'},confirm:()=>true,crypto:require('node:crypto').webcrypto,
    URL:{createObjectURL:()=>`blob:offline-${++urlId}`,revokeObjectURL:url=>revoked.push(url)},
    escapeHTML:value=>String(value).replace(/</g,'&lt;'),$:node,
    $$:selector=>selector.startsWith('#upload-form')?['#student-select','#assignment-day','#reference','#submit-upload'].map(node):[],
    document:{createElement:()=>({width:0,height:0,getContext:()=>({drawImage:(_image,_x,_y,w,h)=>drawn.push([w,h])}),toBlob:callback=>callback(new Blob(['local JPEG']))})},
    createImageBitmap:file=>decode(file),snapshotReview:()=>null,
    setTimeout:(callback,ms)=>{const id=++timerId;timers.set(id,{callback,ms});return id;},clearTimeout:id=>timers.delete(id),
    toast:message=>messages.push(message),showLogin:()=>node('#login-screen').hidden=false,
    renderPhotos:()=>{},renderOriginals:()=>{},renderMapping:()=>{},
    loadJobs:async()=>{},api:async(url,options={})=>{requests.push({url,options});return implementation(url,options);},
    fetch:(url,options)=>new Promise((resolve,reject)=>{
      pending.push({url,resolve,reject,options});
      options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})));
    })});
  const helperStart=source.indexOf('function requestContext('),helperEnd=source.indexOf('async function api(',helperStart);
  vm.runInContext(source.slice(helperStart,helperEnd),context);
  vm.runInContext(source.slice(source.indexOf('function fileKind('),source.indexOf('function renderPhotos(')),context);
  vm.runInContext(source.slice(source.indexOf('function uploadLocked('),source.indexOf('function questionHTML(')),context);
  const submitStart=source.indexOf('async function submitUpload(');
  vm.runInContext(source.slice(submitStart,source.indexOf('$("#review-view").addEventListener("input",',submitStart)),context);
  return {state,pending,revoked,messages,drawn,xhrs,requests,context,node,timers,setDecode:fn=>decode=fn,setAPI:fn=>implementation=fn,
    fire(ms){const found=[...timers].find(([,timer])=>timer.ms===ms);assert.ok(found,`timer ${ms} must exist`);timers.delete(found[0]);found[1].callback();}};
}

async function main() {
  const h=harness();
  // LAN HTTP exposes getRandomValues but not the secure-context-only randomUUID.
  for(const secureContext of [false,true]) {
  const lan=harness();if(!secureContext)lan.context.crypto={getRandomValues:values=>require('node:crypto').webcrypto.getRandomValues(values)};
  lan.state.apiConfigured=true;lan.state.students=[{id:'offline-student',name:'Offline student'}];
  lan.node('#student-select').value='offline-student';lan.node('#assignment-day').value='2026-10-04';
  lan.state.files.push({file:new File(['offline bytes'],'lan.jpg')});
  const submitting=lan.node('#upload-form').events.submit({preventDefault(){}});
  await drain();assert.equal(lan.xhrs.length,1,'confirming on LAN HTTP must start uploading');
  const firstKey=lan.xhrs[0].form.get('submit_key');assert.match(firstKey,/^[a-f0-9]{32}$/);
  assert.equal(lan.state.uploading,true);lan.xhrs[0].abort();await submitting;
  assert.equal(lan.state.submission.key,firstKey);assert.equal(lan.state.uploading,false);
  const retrying=lan.node('#upload-form').events.submit({preventDefault(){}});await drain();
  assert.equal(lan.xhrs[1].form,lan.xhrs[0].form,'retry must preserve exact original payload and key');
  lan.xhrs[1].status=200;lan.xhrs[1].responseText=JSON.stringify({id:'offline-lan-job'});lan.xhrs[1].onload();await retrying;
  assert.equal(lan.context.location.hash,'#review/offline-lan-job');assert.equal(lan.state.submission,null);
  }
  // Preparation failures also need visible feedback, before any XHR can exist.
  const preparation=harness();preparation.state.apiConfigured=true;preparation.state.students=[{id:'offline-student',name:'Offline student'}];
  preparation.node('#student-select').value='offline-student';
  const kept={file:new File(['kept'],'keep.jpg')};preparation.state.files.push(kept);
  preparation.context.crypto={getRandomValues(){throw new Error('offline random source failure');}};
  await preparation.node('#upload-form').events.submit({preventDefault(){}});
  assert.equal(preparation.xhrs.length,0);assert.equal(preparation.state.files[0],kept);
  assert.equal(preparation.state.submission,null);assert.ok(preparation.messages.at(-1).includes('提交未完成：offline random source failure'));
  for(const type of ['image/heic','image/heif','image/heic-sequence','image/heif-sequence'])
    assert.equal(h.context.fileKind({type,name:'download'}),'heif');
  assert.equal(h.context.fileKind({type:'',name:'IMG_001.HEIC'}),'heif');
  assert.equal(h.context.fileKind({type:'application/octet-stream',name:'original.HEIF'}),'heif');
  assert.equal(h.context.fileKind({type:'image/jpeg',name:'IMG_001.jpg'}),'image');
  assert.equal(h.context.fileKind({type:'',name:'original.PDF'}),'pdf');
  assert.equal(h.context.fileKind({type:'image/gif',name:'animation.gif'}),'');
  assert.equal(h.context.fileKind({type:'image/svg+xml',name:'vector.svg'}),'');

  const first={file:new File(['HEIF'],'a.heic')},second={file:new File(['HEIF'],'b.heif')};
  h.state.files.push(first,second);h.context.queuePreview(first);h.context.queuePreview(second);
  await drain();assert.equal(h.pending.length,1,'previews must be sequential');
  assert.equal(h.pending[0].options.body.get('file').name,'a.heic');
  h.state.files.splice(0,1);h.context.discardPhoto(first);await drain();
  assert.equal(h.pending.length,2);assert.equal(first.url,undefined);
  h.pending[1].resolve({ok:false,status:422,json:async()=>({detail:'图片损坏'})});await drain();
  assert.equal(second.previewError,'图片损坏');assert.ok(h.messages[0].includes('图片损坏'));
  h.context.queuePreview(second);await drain();assert.equal(h.pending.length,3);
  h.pending[2].resolve(response);await drain();assert.equal(second.url,'blob:offline-1');
  assert.ok(h.context.previewHTML(second,0).includes('<img'));
  h.context.discardPhoto(second);assert.deepEqual(h.revoked,['blob:offline-1']);
  const removed={file:new File(['HEIF'],'removed.heic')};
  h.state.files.push(removed);h.context.queuePreview(removed);h.state.files.pop();await drain();
  assert.equal(h.pending.length,3,'removed queued files must not upload');

  const pdf=harness(),material={file:new File(['PDF'],'original.pdf'),pdf:true};
  pdf.state.originals.push(material);pdf.context.queuePreview(material);await drain();
  assert.equal(pdf.pending[0].url,'/api/materials/preview');
  pdf.pending[0].resolve({ok:true,json:async()=>({page_count:2,pages:[{preview:'data:image/jpeg;base64,one'},{preview:'data:image/jpeg;base64,two'}]})});await drain();
  assert.equal(material.pageCount,2);assert.equal(material.pages.length,2);assert.equal(material.url,'data:image/jpeg;base64,one');

  const local=harness(),photo={file:new File(['JPG'],'photo.jpg',{type:'image/jpeg'})};
  let closed=0;local.setDecode(async()=>({width:3000,height:4000,close(){closed++;}}));
  local.state.files.push(photo);local.context.queuePreview(photo);await drain();
  assert.equal(local.pending.length,0,'ordinary image thumbnail must not use the server');
  assert.deepEqual(local.drawn,[[450,600]]);assert.equal(closed,1);assert.ok(photo.url);

  // A browser decoder that never finishes must not stall every following photo.
  const decoding=harness(),stuck={file:new File(['JPG'],'stuck.jpg',{type:'image/jpeg'})},following={file:new File(['HEIF'],'following.heic')};
  let finishDecode,lateClosed=0;decoding.setDecode(()=>new Promise(resolve=>finishDecode=resolve));
  decoding.state.files.push(stuck,following);decoding.context.queuePreview(stuck);decoding.context.queuePreview(following);await drain();
  decoding.fire(120000);await drain();assert.ok(stuck.previewError);assert.equal(decoding.pending.length,1);
  finishDecode({width:800,height:1200,close(){lateClosed++;}});await drain();assert.equal(lateClosed,1);
  decoding.pending[0].resolve(response);await drain();assert.ok(following.url);assert.equal(stuck.url,undefined);

  const expiry=harness(),expired={file:new File(['HEIF'],'expired.heic')};
  expiry.state.files.push(expired);expiry.context.queuePreview(expired);await drain();
  expiry.pending[0].resolve({ok:false,status:401,json:async()=>({detail:'请先登录'})});await drain();
  assert.equal(expiry.state.csrf,'');assert.equal(expiry.state.files[0],expired);assert.equal(expiry.state.authEpoch,1);

  const timeout=harness(),slow={file:new File(['HEIF'],'slow.heic')},next={file:new File(['HEIF'],'next.heic')};
  timeout.state.files.push(slow,next);timeout.context.queuePreview(slow);timeout.context.queuePreview(next);await drain();
  timeout.fire(120000);await drain();
  assert.equal(slow.previewPending,false);assert.ok(slow.previewError,'timed-out preview needs a visible retry state');
  assert.equal(timeout.pending.length,2,'timeout must release the serial preview queue');
  timeout.pending[1].resolve(response);await drain();assert.ok(next.url);

  const upload=harness(),chosen={file:new File(['actual retained bytes'],'retained.jpg'),url:'blob:retained'};
  upload.state.files.push(chosen);upload.state.submission={key:'unchanged-key'};
  upload.context.updateUploadState();assert.equal(upload.node('#student-select').disabled,true);
  assert.equal(upload.node('#submit-upload').disabled,false,'an uncertain upload must allow same-key retry');
  const form=new FormData();form.append('submit_key','unchanged-key');form.append('files',chosen.file);
  let transfer=upload.context.uploadWithProgress(form),rejected=assert.rejects(transfer,/中断/);
  assert.equal(upload.xhrs[0].timeout,1200000);assert.equal(upload.xhrs[0].headers['X-CSRF-Token'],'offline-test');
  upload.xhrs[0].upload.onprogress({lengthComputable:true,loaded:65,total:100});
  assert.equal(upload.node('#upload-meter').value,65);assert.equal(upload.node('#upload-meter').hidden,false);
  assert.match(upload.node('#upload-progress').textContent,/65%/);
  upload.xhrs[0].upload.onprogress({lengthComputable:false});
  assert.equal(upload.node('#upload-meter').value,undefined,'unknown byte count must remain indeterminate');
  upload.xhrs[0].abort();await rejected;
  assert.equal(upload.state.uploadXHR,null);assert.equal(upload.state.files[0],chosen);
  assert.equal(upload.state.submission.key,'unchanged-key');
  transfer=upload.context.uploadWithProgress(form);rejected=assert.rejects(transfer,/超时/);
  upload.xhrs[1].ontimeout();await rejected;assert.equal(upload.state.submission.key,'unchanged-key');
  transfer=upload.context.uploadWithProgress(form);rejected=assert.rejects(transfer,/中断/);
  upload.xhrs[2].upload.onload();upload.fire(300000);await rejected;
  assert.equal(upload.node('#upload-meter').value,undefined,'uploaded bytes do not measure image processing');
  assert.equal(upload.state.submission.key,'unchanged-key');

  upload.setAPI(async()=>({id:null}));await upload.context.checkSubmission();
  assert.equal(upload.requests.at(-1).url,'/api/submissions/unchanged-key');
  assert.equal(upload.state.submission.key,'unchanged-key','not-found lookup must not create a new key');
  assert.ok(upload.node('#upload-progress').textContent.includes('仍可能处理中'));
  upload.setAPI(async()=>({id:'accepted-original'}));await upload.context.checkSubmission();
  assert.equal(upload.context.location.hash,'#review/accepted-original');assert.equal(upload.state.submission,null);
  assert.equal(upload.node('#upload-meter').hidden,true);
  assert.equal(upload.state.files.length,0);assert.ok(upload.revoked.includes('blob:retained'));

  // Leaving an uncertain submission is explicit and keeps the editable selection.
  const recovery=harness(),retained={file:chosen.file,url:'blob:keep',source:0,sourcePage:2};
  recovery.state.files.push(retained);recovery.state.originals.push({file:new File(['PDF'],'keep.pdf'),pdf:true});
  const frozen={key:'uncertain-key',form};recovery.state.submission=frozen;recovery.state.submitKey=frozen.key;
  recovery.context.confirm=()=>false;await recovery.context.releaseSubmission();
  assert.equal(recovery.state.submission,frozen);assert.equal(frozen.checking,false);
  recovery.setAPI(async()=>{throw new Error('offline lookup failed');});recovery.context.confirm=()=>true;
  await recovery.context.releaseSubmission();assert.equal(recovery.state.submission,frozen);
  let lookup;recovery.setAPI(()=>new Promise(resolve=>lookup=resolve));
  const releasing=recovery.context.releaseSubmission();await recovery.context.releaseSubmission();
  assert.equal(recovery.requests.length,3,'release lookups must not overlap');
  recovery.state.generation++;lookup({id:null});await releasing;
  assert.equal(recovery.state.submission,frozen,'late lookup cannot release another route');
  recovery.setAPI(async()=>({id:null}));await recovery.context.releaseSubmission();
  assert.equal(recovery.state.submission,null);assert.equal(recovery.state.submitKey,'');
  assert.equal(recovery.state.files[0],retained);assert.equal(retained.sourcePage,2);
  assert.equal(recovery.state.originals.length,1);assert.deepEqual(recovery.revoked,[]);
  recovery.state.submission={key:'accepted-key'};recovery.setAPI(async()=>({id:'existing-job'}));
  recovery.context.confirm=()=>{throw new Error('accepted job must open without abandoning it');};
  await recovery.context.releaseSubmission();assert.equal(recovery.context.location.hash,'#review/existing-job');

  console.log('Local/HEIC/PDF previews, authentication, deadlines, XHR cancellation and idempotent submission lookup: OK');
}
const deadline=setTimeout(()=>{console.error('Upload regression did not finish; a queue or request remained pending.');process.exit(1);},10000);
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(deadline));
