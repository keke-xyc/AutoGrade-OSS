// Offline review workflow checks against the actual app functions; no browser or API access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
const AutoGradeReview = require('../static/review-priority.js');
const busyStates = new Set(['queued','processing','feedback_queued','feedbacking','cropping','locating','judging']);
const drain = () => new Promise(resolve => setImmediate(resolve));

function element(value = '') {
  const classes = new Set();
  return {value, disabled:false, readOnly:false, textContent:'', checked:false, dataset:{},
    focus(){assert.equal(this.disabled,false,'selection must enable the textarea before focusing');this.focused=true;},
    select(){assert.equal(this.disabled,false,'cannot select disabled text');this.selected=true;},
    setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;},
    classList:{toggle(name, enabled) {if (enabled) classes.add(name); else classes.delete(name);}, contains:name=>classes.has(name)}};
}
function job() {
  return {id:'offline-review', status:'review', revision:5, feedback_revision:5, reviewed:true,
    feedback:'已保存的回复', teacher_notes:'', result:{questions:[{question:'2+3',student_answer:'5'}], observations:[], warnings:[]}};
}
function harness(approve=()=>true) {
  const state = {job:job(), route:'#review/offline-review', generation:0, authEpoch:0,
    dirty:false, feedbackDirty:false, actionPending:false};
  const buttons = Object.fromEntries(['save-all','confirm','copy','save-review','save-feedback','generate','delete','judge-text'].map(name=>[name,element()]));
  buttons['judge-text'].dataset.questionIndex='0';
  const nodes = Object.fromEntries(['feedback','reviewed','observations','warnings','teacher-notes','review-action-title','save-indicator','review-view','notes-checked','notes-review-notice','notes-check-label','notes-changes','question-summary','question-heading-counts'].map(name=>['#'+name,element()]));
  nodes['#review-view'].dataset.jobId=state.job.id;
  nodes['#feedback'].value=state.job.feedback; nodes['#reviewed'].checked=true;
  const mark=element(),bar=element();
  bar.querySelector=selector=>selector==='[data-primary-review]'?buttons.confirm:selector==='.review-status-mark'?mark:buttons[selector.match(/data-action="([^"]+)"/)[1]];
  nodes['.review-actions']=bar;
  const questionField=element('2+3');questionField.dataset.field='question';
  const card={dataset:{question:'0'},querySelectorAll:()=>[questionField],querySelector:()=>null};
  const warningSelect=element('pending');warningSelect.dataset.warningText='旧疑问';
  const controls=[...Object.values(buttons),...Object.values(nodes).filter(node=>node!==bar),questionField];
  const requests=[],messages=[];
  let implementation,renderCount=0;
  const context=vm.createContext({state,busyStates,AutoGradeReview,structuredClone,
    $:selector=>selector==='#review-view [data-action="generate"]'?buttons.generate:selector==='#review-view [data-action="save-feedback"]'?buttons['save-feedback']:nodes[selector],
    $$:selector=>selector==='[data-question]'?[card]:selector==='[data-warning-index]'?[warningSelect]:selector.startsWith('#review-view [data-action],')?controls:[],
    api:async(route,options)=>{const request={route,method:options.method,body:options.body?JSON.parse(options.body):undefined};requests.push(request);return implementation(request);},
    renderReview:()=>{renderCount++;nodes['#feedback'].value=state.job.feedback;nodes['#reviewed'].checked=state.job.reviewed;context.updateReviewActions();},
    toast:message=>messages.push(message),loadJobs:async()=>{},confirm:approve,
    navigator:{clipboard:{writeText:async()=>{}}},document:{execCommand:()=>false},location:{hash:''}});
  const helperStart=source.indexOf('function requestContext('),helperEnd=source.indexOf('function snapshotReview(',helperStart);
  assert.ok(helperStart>=0&&helperEnd>helperStart,'request identity helpers must exist');
  vm.runInContext(source.slice(helperStart,helperEnd),context);
  for (const [begin,end] of [['function updateReviewActions(', 'function renderReview('],['function collectReview(', 'let zoom=']]) {
    const start=source.indexOf(begin),stop=source.indexOf(end,start);
    assert.ok(start>=0&&stop>start,'review function boundaries must exist');
    vm.runInContext(source.slice(start,stop),context);
  }
  return {state,buttons,nodes,bar,controls,context,requests,messages,questionField,warningSelect,
    setAPI:fn=>implementation=fn, renderCount:()=>renderCount};
}

async function main() {
  // Actual cards: unknown questions first, other results in native closed details.
  const layout=harness();layout.state.job.photos=[];
  Object.assign(layout.context,{AutoGradeReview,escapeHTML:s=>String(s??''),badge:s=>s,regionSources:{},labels:{correct:'正确',incorrect:'错误',blank:'未作答',uncertain:'无法判定'},reviewTextField:()=>''});
  const questionStart=source.indexOf('function questionHTML(');
  vm.runInContext(source.slice(questionStart,source.indexOf('\n}',questionStart)+2),layout.context);
  const list=[{id:'q0',page:1,number:'1',status:'correct',reviewed:false},{id:'q1',page:1,number:'2',status:'uncertain',reviewed:false},{id:'q2',page:1,number:'3',status:'incorrect',reviewed:false},{id:'q3',page:1,number:'4',status:'blank',reviewed:false}];
  const html=layout.context.questionListHTML(list);
  assert.ok(html.indexOf('data-question="1"')<html.indexOf('data-question="2"'),'exceptions appear ahead of model-marked errors');
  assert.match(html,/<details class="question-card" data-question="1" open>/);
  assert.match(html,/<details class="other-questions">/);
  assert.match(html, /review-corrections/);
  assert.match(html, /data-pending-count/);

  assert.match(html, /更多题目操作/);
  assert.match(html, /重新判题（1次 API）/);
  for(const i of [0,2,3])assert.doesNotMatch(html,new RegExp(`data-question="${i}" open`));
  list[1].status='correct';assert.match(layout.context.questionListHTML(list),/没有必须人工处理的题目/);
  assert.match(layout.context.questionListHTML(list),/data-review-ready/);
  list[1].judgment_pending=true;assert.equal(layout.context.needsQuestionReview(list[1]),true);
  list[1].reviewed=true;assert.equal(layout.context.needsQuestionReview(list[1]),false);
  layout.context.AutoGradeText={textHTML:text=>text};
  const extra={questions:[],warnings:['可能漏题'],observations:[],note_links:{}};
  assert.match(layout.context.generalWarningsHTML(extra),/<details class="general-warning-list">/);
  assert.match(layout.context.generalWarningsHTML(extra),/可能漏题/,'unknown coverage warnings stay available without forcing extra confirmation');

  const states=[
    {name:'not reviewed',checked:false,confirmDisabled:true,copyDisabled:true,saveDisabled:true,phase:'review'},
    {name:'empty reply',feedback:'  ',confirmDisabled:true,copyDisabled:true,saveDisabled:true,phase:'review'},
    {name:'outdated reply',stale:true,confirmDisabled:true,copyDisabled:true,saveDisabled:true,phase:'unsaved'},
    {name:'ready to archive',confirmDisabled:false,copyDisabled:true,saveDisabled:true,phase:'ready'},
    {name:'archived',status:'confirmed',confirmDisabled:true,copyDisabled:false,saveDisabled:true,phase:'archived'},
    {name:'archived with outdated reply',status:'confirmed',stale:true,confirmDisabled:true,copyDisabled:true,saveDisabled:true,phase:'unsaved'},
    {name:'unsaved review',status:'confirmed',dirty:true,confirmDisabled:true,copyDisabled:true,saveDisabled:false,phase:'unsaved'},
    {name:'edited reply',feedbackDirty:true,stale:true,confirmDisabled:false,copyDisabled:true,saveDisabled:false,phase:'unsaved'},
    {name:'both edits',dirty:true,feedbackDirty:true,confirmDisabled:false,copyDisabled:true,saveDisabled:false,phase:'unsaved'},
    {name:'pending action',pending:true,confirmDisabled:true,copyDisabled:true,saveDisabled:true,phase:'pending'}
  ];
  for (const expected of states) {
    const h=harness();
    h.nodes['#reviewed'].checked=expected.checked??true;
    h.nodes['#feedback'].value=expected.feedback??'老师核对过的回复';
    h.state.job.status=expected.status??'review';
    if (expected.stale) h.state.job.feedback_revision=4;
    h.state.dirty=!!expected.dirty;h.state.feedbackDirty=!!expected.feedbackDirty;h.state.actionPending=!!expected.pending;
    h.context.updateReviewActions();
    assert.equal(h.buttons.confirm.disabled,expected.confirmDisabled,expected.name+' confirm');
    assert.equal(h.buttons.copy.disabled,expected.copyDisabled,expected.name+' copy');
    assert.equal(h.buttons['save-all'].disabled,expected.saveDisabled,expected.name+' save');
    assert.equal(h.bar.dataset.phase,expected.phase,expected.name+' phase');
    assert.equal(h.buttons['save-all'].hidden,!h.state.dirty&&!h.state.feedbackDirty,expected.name+' save visibility');
    assert.equal(h.buttons.copy.hidden,expected.phase!=='archived',expected.name+' copy visibility');
    assert.equal(h.buttons.confirm.hidden,expected.phase==='archived',expected.name+' primary visibility');
    if (expected.status==='confirmed'&&!expected.dirty&&!expected.feedbackDirty&&!expected.stale) {
      assert.equal(h.buttons.confirm.textContent,'已归档');
      assert.equal(h.buttons.copy.classList.contains('primary'),true);
    } else {
      assert.equal(h.buttons.confirm.textContent,'确认归档');
      assert.equal(h.buttons.confirm.classList.contains('primary'),true);
    }
    if (expected.pending) assert.ok(h.controls.every(control=>control.disabled),'pending must lock every action and field');
  }
  for (const status of busyStates) {
    const h=harness();h.state.job.status=status;h.context.updateReviewActions();
    assert.ok(h.controls.every(control=>control.disabled),status+' must lock every action and field');
  }

  const notes=harness();notes.state.job.result.notes_pending=true;
  notes.context.updateReviewActions();
  assert.equal(notes.buttons.generate.disabled,true);assert.equal(notes.buttons['save-feedback'].disabled,true);assert.equal(notes.buttons.confirm.disabled,true);
  assert.equal(notes.nodes['#reviewed'].disabled,true,'notes acknowledgment must precede final review');
  assert.equal(notes.nodes['#review-action-title'].textContent,'还有记录待核对');
  notes.nodes['#notes-checked'].checked=true;notes.context.updateReviewActions();
  assert.equal(notes.buttons.generate.disabled,false);assert.equal(notes.nodes['#reviewed'].disabled,false);
  notes.state.job.result.warnings=['旧疑问'];notes.nodes['#warnings'].value='旧疑问';
  notes.warningSelect.value='resolved';
  const body=notes.context.collectReview();
  assert.equal(body.notes_checked,true);assert.equal(body.result.warning_states['旧疑问'],'resolved');
  notes.nodes['#notes-checked'].checked=false;notes.nodes['#reviewed'].checked=false;
  notes.context.updateQuestionSummary([{status:'correct'},{status:'uncertain'}]);
  assert.equal(notes.nodes['#question-summary'].textContent,'2题 · 1题正确 · 0题错误 · 0题未作答 · 1题无法判定');
  assert.equal(notes.nodes['#question-heading-counts'].textContent,'0题错误 · 1题待判断');
  notes.state.dirty=true;
  await assert.rejects(notes.context.action('generate',notes.buttons.generate),/相关观察与疑问/);
  assert.equal(notes.requests.length,0,'unacknowledged notes must not start a billable feedback request');

  // Unreviewed model-marked errors must require an explicit teacher decision
  // before a billable feedback request or a write can begin.
  const declined=harness(()=>false);
  declined.state.job.result.questions=[{id:'q1',page:1,number:'1',question:'5-2',student_answer:'4',status:'incorrect',reviewed:false,judgment_pending:false}];
  await declined.context.action('generate',declined.buttons.generate);
  assert.equal(declined.requests.length,0,'declining the batch acceptance must not save or call the paid API');
  assert.equal(declined.state.actionPending,false,'declining must release the action lock');

  // A single edit preserves confirmations and resolved issues on unrelated questions.
  const scoped=harness();
  scoped.state.job.result.questions=[1,2,3,4].map(i=>({id:'q'+i,page:1,number:String(i),question:i+'+1',student_answer:String(i+1),status:'correct',reviewed:true,judgment_pending:false}));
  scoped.state.job.result.observations=['第4题可见步骤'];scoped.nodes['#observations'].value='第4题可见步骤';
  scoped.state.job.result.warnings=['第1题已核对','第3或第4题归属待核对'];scoped.nodes['#warnings'].value=scoped.state.job.result.warnings.join('\n');
  scoped.state.job.result.warning_states={'第1题已核对':'resolved','第3或第4题归属待核对':'resolved'};
  scoped.state.job.result.note_links={
    'observation:第4题可见步骤':{scope:'questions',question_ids:['q4'],checked:true},
    'warning:第1题已核对':{scope:'questions',question_ids:['q1'],checked:true},
    'warning:第3或第4题归属待核对':{scope:'questions',question_ids:['q3','q4'],checked:true}
  };
  scoped.context.markQuestionChanged(3,'student_answer');
  assert.deepEqual(scoped.state.job.result.questions.map(q=>q.reviewed),[true,true,true,false]);
  assert.equal(scoped.state.job.result.questions[3].judgment_pending,true);
  assert.equal(scoped.state.job.result.note_links['warning:第1题已核对'].checked,true);
  assert.equal(scoped.state.job.result.warning_states['第1题已核对'],'resolved');
  assert.equal(scoped.state.job.result.note_links['warning:第3或第4题归属待核对'].checked,false);
  assert.equal(scoped.nodes['#reviewed'].checked,false);scoped.context.updateReviewActions();
  assert.equal(scoped.buttons.generate.disabled,true,'changed answers must be rejudged or explicitly adopted');
  assert.equal(scoped.buttons.confirm.textContent,'处理题目','sticky primary action matches the current workflow');
  assert.equal(scoped.buttons.confirm.dataset.action,'focus-question');assert.equal(scoped.buttons.confirm.disabled,false);
  const attentionCard=element(),attentionSummary=element(),attentionGroup=element();
  attentionCard.closest=selector=>{assert.equal(selector,'.other-questions');return attentionGroup;};
  attentionCard.scrollIntoView=options=>{assert.equal(options.block,'start');attentionCard.scrolled=true;};
  attentionCard.querySelector=selector=>{assert.equal(selector,'summary');return attentionSummary;};
  scoped.nodes['[data-question="3"]']=attentionCard;
  scoped.state.dirty=true;
  await scoped.context.action('focus-question',scoped.buttons.confirm);
  assert.equal(attentionGroup.open,true);assert.equal(attentionCard.open,true);assert.equal(attentionCard.scrolled,true);assert.equal(attentionSummary.focused,true);
  assert.equal(scoped.state.dirty,true);assert.equal(scoped.state.actionPending,false);
  assert.equal(scoped.requests.length,0,'locating a pending question must preserve edits without making an API request');
  await assert.rejects(scoped.context.action('generate',scoped.buttons.generate),/重新判题/);
  assert.equal(scoped.requests.length,0,'unhandled changes cannot start a feedback call');
  const scopedButton=element();scopedButton.dataset.confirmQuestion='3';
  scoped.state.feedbackDirty=true;scoped.nodes['#feedback'].value='老师的待保存回复';
  scoped.setAPI(async request=>{assert.equal(request.method,'PUT');return {...scoped.state.job,revision:6,reviewed:true,result:{...request.body.result,questions:request.body.result.questions.map(q=>({...q,reviewed:true,judgment_pending:false})),notes_pending:false}};});
  await scoped.context.action('confirm-question',scopedButton);
  assert.deepEqual(scoped.requests[0].body.confirm_questions,['q4']);
  assert.deepEqual(scoped.requests[0].body.confirm_notes,['warning:第3或第4题归属待核对']);
  assert.deepEqual(scoped.requests[0].body.resolve_notes,['warning:第3或第4题归属待核对']);
  assert.equal(scoped.requests[0].body.result.note_links['observation:第4题可见步骤'].superseded,true);
  assert.equal(scoped.nodes['#feedback'].value,'老师的待保存回复');

  // Final confirmation saves exactly the pending question, acknowledges unknown records without
  // guessing their meaning, and only then makes one billable feedback request.
  const combined=harness();
  combined.state.job.result.questions=[{id:'q1',page:1,number:'1',question:'2+3',student_answer:'6',status:'incorrect',reviewed:false},{id:'q2',page:1,number:'2',status:'correct',reviewed:true}];
  combined.state.job.result.warnings=['本题字迹不清','另一页可能缺失'];combined.nodes['#warnings'].value=combined.state.job.result.warnings.join('\n');
  combined.state.job.result.note_links={'warning:本题字迹不清':{scope:'questions',question_ids:['q1'],checked:false},'warning:另一页可能缺失':{scope:'unassigned',question_ids:[],checked:false}};
  combined.warningSelect.dataset.warningText='本题字迹不清';combined.warningSelect.value='on_confirm';
  combined.state.job.result.notes_pending=true;combined.state.job.reviewed=false;combined.nodes['#reviewed'].checked=false;
  combined.state.dirty=true;
  combined.setAPI(async request=>{
    if(request.method==='PUT')return {...combined.state.job,revision:6,reviewed:true,result:{...request.body.result,questions:request.body.result.questions.map(q=>({...q,reviewed:true})),notes_pending:false}};
    return {...combined.state.job,status:'feedback_queued'};
  });
  await combined.context.action('generate',combined.buttons.generate);
  assert.deepEqual(combined.requests.map(r=>r.method||'GET'),['PUT','POST','GET']);
  assert.deepEqual(combined.requests[0].body.confirm_questions,['q1']);
  assert.deepEqual(combined.requests[0].body.resolve_notes,['warning:本题字迹不清']);
  assert.deepEqual(combined.requests[0].body.confirm_notes,['warning:本题字迹不清','warning:另一页可能缺失']);
  assert.deepEqual(combined.requests[1].body,{revision:6});
  const plan=combined.context.confirmationPlan;
  const copy=structuredClone(combined.state.job.result);copy.questions.forEach(q=>q.reviewed=false);
  copy.note_links['warning:本题字迹不清'].question_ids=['q1','q2'];
  assert.deepEqual(Array.from(plan(copy,['q1']).resolve),[],'multi-question issue waits for other confirmations');
  copy.questions[1].status='uncertain';assert.deepEqual(Array.from(plan(copy,['q1','q2'],true).resolve),[]);
  copy.questions[1].status='correct';copy.warning_states={'本题字迹不清':'needs_photo'};
  assert.deepEqual(Array.from(plan(copy,['q1','q2'],true).resolve),[]);
  copy.warning_states={'本题字迹不清':'pending'};assert.deepEqual(Array.from(plan(copy,['q1','q2'],true).resolve),[],'explicitly retained doubt stays retained');
  copy.warning_states={};copy.questions.forEach(q=>q.reviewed=true);
  const handled=plan(copy,[],true);assert.deepEqual(Array.from(handled.resolve),['warning:本题字迹不清']);
  assert.deepEqual(Array.from(handled.questions),['q1'],'a new explicitly linked issue can be resolved without reopening unrelated questions');
  const failedCombined=harness();failedCombined.state.job.result.questions=[{id:'q1',status:'correct',reviewed:false}];
  failedCombined.setAPI(async()=>{throw new Error('offline save conflict');});
  await assert.rejects(failedCombined.context.action('generate',failedCombined.buttons.generate),/save conflict/);
  assert.equal(failedCombined.requests.length,1,'a failed confirmation never triggers the billable request');

  // Keep both responses pending to catch duplicate clicks and premature DOM rerendering.
  const h=harness(),edited='老师正在编辑的回复';
  h.state.dirty=true;h.state.feedbackDirty=true;h.nodes['#feedback'].value=edited;
  let resolveReview,resolveFeedback;
  h.setAPI(request=>new Promise(resolve=>{if(request.route.endsWith('/review'))resolveReview=resolve;else resolveFeedback=resolve;}));
  const saving=h.context.action('save-all',h.buttons['save-all']);
  assert.equal(h.requests.length,1);assert.equal(h.state.actionPending,true);
  assert.ok(h.controls.every(control=>control.disabled));
  await h.context.action('save-all',h.buttons['save-all']);
  assert.equal(h.requests.length,1,'a duplicate action must not make another request');
  resolveReview({...job(),revision:6,feedback_revision:null});await drain();
  assert.deepEqual(h.requests.map(request=>request.route),['/api/jobs/offline-review/review','/api/jobs/offline-review/feedback']);
  assert.deepEqual(h.requests[1].body,{revision:6,feedback:edited});
  assert.equal(h.nodes['#feedback'].value,edited,'review save must retain the edited reply');
  assert.equal(h.renderCount(),0,'save-all must not rerender between review and reply saves');
  assert.equal(h.state.actionPending,true);assert.ok(h.controls.every(control=>control.disabled));
  resolveFeedback({...job(),revision:7,feedback_revision:7,feedback:edited});await saving;
  assert.equal(h.renderCount(),1);assert.equal(h.state.job.feedback,edited);
  assert.equal(h.nodes['#feedback'].value,edited);
  assert.equal(h.state.dirty,false);assert.equal(h.state.feedbackDirty,false);assert.equal(h.state.actionPending,false);
  assert.equal(h.buttons.confirm.disabled,false);assert.equal(h.buttons['save-all'].disabled,true);

  const preserved=harness();preserved.state.dirty=true;preserved.state.feedbackDirty=true;preserved.nodes['#feedback'].value=edited;
  preserved.setAPI(async()=>({...job(),revision:6,feedback_revision:null}));
  await preserved.context.saveReview();
  assert.equal(preserved.renderCount(),1);
  assert.equal(preserved.nodes['#feedback'].value,edited,'individual review save must retain unsaved reply text after rendering');
  assert.equal(preserved.state.feedbackDirty,true);

  const failed=harness();failed.state.dirty=true;failed.state.feedbackDirty=true;failed.nodes['#feedback'].value=edited;
  failed.setAPI(async request=>{if(request.route.endsWith('/review'))return {...job(),revision:6,feedback_revision:null};throw new Error('offline reply save failure');});
  await assert.rejects(failed.context.action('save-all',failed.buttons['save-all']),/offline reply save failure/);
  assert.equal(failed.state.actionPending,false,'failed save must release the action lock');
  assert.equal(failed.state.dirty,false);assert.equal(failed.state.feedbackDirty,true);
  assert.equal(failed.nodes['#feedback'].value,edited,'failed reply save must preserve editable text');
  assert.equal(failed.buttons['save-all'].disabled,false);

  const judging=harness();judging.state.dirty=true;judging.state.feedbackDirty=true;
  judging.questionField.value='3/8÷9/13';judging.nodes['#feedback'].value=edited;
  let saveFirst,judgeNext;
  judging.setAPI(request=>new Promise(resolve=>{if(request.method==='PUT')saveFirst=resolve;else judgeNext=resolve;}));
  const judgment=judging.context.action('judge-text',judging.buttons['judge-text']);
  assert.equal(judging.requests.length,1);assert.equal(judging.requests[0].body.result.questions[0].question,'3/8÷9/13');
  await judging.context.action('judge-text',judging.buttons['judge-text']);assert.equal(judging.requests.length,1);
  saveFirst({...job(),revision:6,feedback_revision:null});await drain();
  assert.deepEqual(judging.requests.map(r=>r.route),['/api/jobs/offline-review/review','/api/jobs/offline-review/judge-text']);
  assert.deepEqual(judging.requests[1].body,{revision:6,question_index:0});
  assert.equal(judging.nodes['#feedback'].value,edited);assert.equal(judging.state.actionPending,true);
  judgeNext({...job(),revision:7,reviewed:false,feedback_revision:null});await judgment;
  assert.equal(judging.state.job.revision,7);assert.equal(judging.state.actionPending,false);
  assert.equal(judging.state.dirty,false);assert.equal(judging.state.feedbackDirty,true);
  assert.equal(judging.nodes['#feedback'].value,edited);assert.equal(judging.nodes['#reviewed'].checked,false);
  assert.equal(judging.buttons.confirm.disabled,true);
  const direct=harness();direct.context.confirm=()=>{throw new Error('the explicit paid button does not need a second dialog');};
  direct.setAPI(async()=>({...job(),revision:6}));
  await direct.context.action('judge-text',direct.buttons['judge-text']);assert.equal(direct.requests.length,1);
  const blank=harness();blank.questionField.value=' ';
  await assert.rejects(blank.context.action('judge-text',blank.buttons['judge-text']),/完整题干/);assert.equal(blank.requests.length,0);
  const uncertain=harness();uncertain.state.feedbackDirty=true;uncertain.nodes['#feedback'].value=edited;
  uncertain.setAPI(async request=>{if(request.method==='POST')throw new Error('offline judgment timeout');return {...job(),status:'judging'};});
  await assert.rejects(uncertain.context.action('judge-text',uncertain.buttons['judge-text']),/offline judgment timeout/);
  assert.deepEqual(uncertain.requests.map(r=>r.method||'GET'),['POST','GET']);
  assert.equal(uncertain.state.job.status,'judging');assert.equal(uncertain.nodes['#feedback'].value,edited);
  assert.equal(uncertain.state.actionPending,false);assert.equal(uncertain.buttons['judge-text'].disabled,true);
  const late=harness();let lateResult;late.setAPI(()=>new Promise(resolve=>lateResult=resolve));
  const stale=late.context.action('judge-text',late.buttons['judge-text']);
  late.state.generation++;late.state.job={...job(),id:'other-job'};late.state.route='#review/other-job';
  lateResult({...job(),revision:7});await stale;
  assert.equal(late.state.job.id,'other-job');assert.equal(late.state.actionPending,true);assert.equal(late.renderCount(),0);
  const modern=harness();modern.state.job.status='confirmed';let clipboardText;
  modern.context.navigator.clipboard.writeText=async text=>clipboardText=text;
  await modern.context.action('copy',modern.buttons.copy);
  assert.equal(clipboardText,modern.state.job.feedback);assert.equal(modern.nodes['#feedback'].selected,undefined);
  assert.match(modern.messages.at(-1),/回复已复制/);assert.equal(modern.state.actionPending,false);
  for(const unavailable of ['absent','rejected']){
    const fallback=harness();fallback.state.job.status='confirmed';let calls=0;
    fallback.context.navigator.clipboard=unavailable==='absent'?undefined:{writeText:async()=>{throw new Error('NotAllowedError');}};
    fallback.context.document.execCommand=command=>{
      calls++;assert.equal(command,'copy');assert.equal(fallback.nodes['#feedback'].disabled,false);
      assert.equal(fallback.nodes['#feedback'].readOnly,true);assert.equal(fallback.nodes['#feedback'].selected,true);
      assert.equal(fallback.nodes['#feedback'].selectionEnd,fallback.state.job.feedback.length);return true;
    };
    const copying=fallback.context.action('copy',fallback.buttons.copy);
    if(unavailable==='absent')assert.equal(calls,1,'HTTP fallback must execute synchronously in the user click');
    await copying;assert.equal(calls,1);assert.match(fallback.messages.at(-1),/回复已复制/);
    assert.equal(fallback.nodes['#feedback'].disabled,false);assert.equal(fallback.nodes['#feedback'].readOnly,false);
    assert.equal(fallback.requests.length,0,'copying must not call the server or model');
  }
  for(const failure of ['returns false','throws','unsupported']){
    const manual=harness();manual.state.job.status='confirmed';manual.context.navigator.clipboard=undefined;
    manual.context.document.execCommand=failure==='unsupported'?undefined:()=>{if(failure==='throws')throw new Error('copy restricted');return false;};
    await manual.context.action('copy',manual.buttons.copy);
    assert.match(manual.messages.at(-1),/已选中回复/);assert.doesNotMatch(manual.messages.at(-1),/回复已复制/);
    assert.equal(manual.nodes['#feedback'].disabled,false);assert.equal(manual.nodes['#feedback'].focused,true);
    assert.equal(manual.nodes['#feedback'].selected,true);assert.equal(manual.nodes['#feedback'].selectionStart,0);
    assert.equal(manual.nodes['#feedback'].selectionEnd,manual.state.job.feedback.length);
    assert.equal(manual.state.feedbackDirty,false);assert.equal(manual.nodes['#feedback'].value,manual.state.job.feedback);
  }
  for(const invalid of ['stale','draft','not archived']){
    const blocked=harness();blocked.state.job.status='confirmed';let writes=0;
    blocked.context.navigator.clipboard.writeText=async()=>writes++;
    if(invalid==='stale')blocked.state.job.feedback_revision=null;
    else if(invalid==='draft')blocked.state.feedbackDirty=true;
    else blocked.state.job.status='review';
    await assert.rejects(blocked.context.action('copy',blocked.buttons.copy));assert.equal(writes,0);
  }
  const lateCopy=harness();lateCopy.state.job.status='confirmed';let rejectCopy,legacyCalls=0;
  lateCopy.context.navigator.clipboard.writeText=()=>new Promise((resolve,reject)=>rejectCopy=reject);
  lateCopy.context.document.execCommand=()=>{legacyCalls++;return true;};
  const pendingCopy=lateCopy.context.action('copy',lateCopy.buttons.copy);
  lateCopy.state.generation++;lateCopy.state.job={...job(),id:'other-job'};lateCopy.state.route='#review/other-job';
  rejectCopy(new Error('permission denied'));await pendingCopy;
  assert.equal(legacyCalls,0,'late failures must not select or copy the newly opened job');
  assert.equal(lateCopy.nodes['#feedback'].selected,undefined);assert.equal(lateCopy.messages.length,0);
  console.log('Review actions, ordered saves, async guards and secure/HTTP/denied/manual clipboard paths: OK');
}
const deadline=setTimeout(()=>{console.error('Review regression did not finish; a save remained pending.');process.exit(1);},10000);
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(deadline));
