// Execute actual image mutation handlers with delayed responses; no browser or API.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8');
function code(name){const start=source.indexOf(`function ${name}(`);assert.ok(start>=0);return source.slice(source.lastIndexOf('\n',start)+1,source.indexOf('\n}',start)+2);}
function job(id='A',revision=5){return {id,revision,updated:revision,status:'review',result:{questions:[{status:'correct',reviewed:false}]}};}
function harness(){
  const state={job:job(),route:'#review/A',authEpoch:0,generation:0,actionPending:false,dirty:false,feedbackDirty:false};
  const nodes=new Map(),requests=[],rendered=[],messages=[];
  const node=s=>{if(!nodes.has(s))nodes.set(s,{disabled:false,open:s==='#image-dialog',close(){this.open=false;}});return nodes.get(s);};
  let implementation;
  const context=vm.createContext({state,imageIsOriginal:false,imagePhoto:{id:'photo-A'},imageQuestion:2,cropSelection:{x:.8,y:.9,width:.5,height:.3},busyStates:new Set(['cropping','locating']),
    $:node,updateReviewActions(){},renderRegions(){},renderReview(){rendered.push(state.job.id);},selectImageQuestion(){},toast:m=>messages.push(m),
    api:async(url,options={})=>{requests.push({url,...options});return implementation(url,options);}});
  for(const name of ['requestContext','contextCurrent','applyJob','needsQuestionReview','imageOperation','focusRegion'])vm.runInContext(code(name),context);
  return {state,node,context,requests,rendered,messages,setAPI:fn=>implementation=fn};
}
async function main(){
  for(const kind of ['location','crop','locate']){
    const h=harness();let resolve;h.setAPI(()=>new Promise(r=>resolve=r));
    const pending=h.context.imageOperation(kind);assert.equal(h.state.actionPending,true);
    await h.context.imageOperation(kind);assert.equal(h.requests.length,1,'duplicate image actions must share the operation lock');
    const request=h.requests[0],body=JSON.parse(request.body);
    assert.equal(request.url,`/api/jobs/A/${kind}`);assert.equal(request.method,kind==='location'?'PUT':'POST');
    assert.equal(body.revision,5);assert.equal(body.photo_id,'photo-A');
    if(kind!=='locate'){const box=kind==='location'?body.bbox:body;assert.ok(Math.abs(box.width-.2)<1e-8);assert.ok(Math.abs(box.height-.1)<1e-8);assert.equal(body.question_index,2);}
    resolve(job('A',6));await pending;assert.equal(h.state.job.revision,6);assert.equal(h.state.actionPending,false);
  }
  // A previous route response must neither replace B nor release B's operation lock.
  const late=harness();let finish;late.setAPI(()=>new Promise(r=>finish=r));
  const pending=late.context.imageOperation('crop');late.state.generation++;late.state.job=job('B');late.state.route='#review/B';
  finish(job('A',6));await pending;assert.equal(late.state.job.id,'B');assert.equal(late.state.actionPending,true);assert.deepEqual(late.rendered,[]);
  for(const flag of ['dirty','feedbackDirty','imageIsOriginal']){
    const h=harness();if(flag==='imageIsOriginal')h.context[flag]=true;else h.state[flag]=true;
    h.setAPI(()=>{throw new Error('read-only must not make a mutation');});await h.context.imageOperation('crop');assert.equal(h.requests.length,0);
  }
  // A failed paid request only reads the accepted state; it must never send POST twice.
  const failed=harness();failed.setAPI(async(url,options)=>{if(options.method)throw new Error('offline timeout');return job('A',6);});
  await failed.context.imageOperation('crop');assert.deepEqual(failed.requests.map(r=>r.method||'GET'),['POST','GET']);
  assert.equal(failed.state.job.revision,6);assert.equal(failed.state.actionPending,false);assert.equal(failed.messages.at(-1),'offline timeout');
  const left=harness();left.state.job=null;assert.doesNotThrow(()=>left.context.focusRegion(),'late image load after leaving review must be harmless');
  console.log('Image operation locks, bounded coordinates, late-response guards and paid-request recovery: OK');
}
const deadline=setTimeout(()=>{console.error('Image workflow did not finish; an unexpected request remained pending.');process.exit(1);},10000);
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearTimeout(deadline));
