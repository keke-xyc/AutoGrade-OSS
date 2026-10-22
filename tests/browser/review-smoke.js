// Real Chromium smoke test of the production HTML/CSS/JS with synthetic homework.
// Network calls are intercepted; no teacher records, database, or paid model API is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..', '..');
const shots = path.join(root, 'test-results', 'browser');
const contentTypes = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'};

const job = {
  id:'offline-review', student_name:'小明', grade:'四年级', day:'2026-10-18',
  status:'review', revision:4, feedback_revision:4, reviewed:false,
  error:null, teacher_notes:'', feedback:'', evidence:[], calls:[],
  photos:[{id:'photo1',page:1,recognized:true,material_id:null}],
  materials:[], result:{
    questions:[
      {id:'q1',number:'1',page:1,question:'2+3',student_answer:'5',expected_answer:'5',status:'correct',explanation:'计算正确',knowledge_point:'加法',reviewed:false,judgment_pending:false},
      {id:'q2',number:'2',page:1,question:'9÷3',student_answer:'2',expected_answer:'3',status:'incorrect',explanation:'商计算错误',knowledge_point:'除法',reviewed:false,judgment_pending:false},
      {id:'q3',number:'3',page:1,question:'4+7',student_answer:'',expected_answer:'11',status:'blank',explanation:'未见作答',knowledge_point:'加法',reviewed:false,judgment_pending:false},
      {id:'q4',number:'4',page:1,question:'3/5+1/5',student_answer:'字迹不清',expected_answer:'4/5',status:'uncertain',explanation:'看不清',knowledge_point:'分数',reviewed:false,judgment_pending:false}
    ],
    observations:[],warnings:[],note_links:{},warning_states:{},image_notes:[],notes_pending:false
  }
};

const server = http.createServer(async(req,res)=>{
  const url = new URL(req.url, 'http://localhost');
  if(!url.pathname.startsWith('/static/')){res.writeHead(404);res.end();return;}
  const file = path.resolve(root, '.'+url.pathname);
  if(!file.startsWith(path.join(root,'static')+path.sep)){res.writeHead(403);res.end();return;}
  try {
    const data = await fs.readFile(file);
    res.writeHead(200,{'content-type':contentTypes[path.extname(file)]||'application/octet-stream'});
    res.end(data);
  } catch {res.writeHead(404);res.end();}
});

const listen = () => new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close = () => new Promise(resolve=>server.close(resolve));
async function run() {
  await fs.mkdir(shots,{recursive:true}); await listen();
  const browser = await chromium.launch({headless:true});
  const errors=[];
  try {
    for(const size of [{width:390,height:844,name:'mobile'},{width:1280,height:900,name:'desktop'}]) {
      const page = await browser.newPage({viewport:{width:size.width,height:size.height},deviceScaleFactor:1});
      page.on('pageerror',error=>errors.push(size.name+': '+error.message));
      await page.route('**/api/**',route=>{
        const endpoint=new URL(route.request().url()).pathname;
        const body=endpoint==='/api/me'?{user:{user_id:'offline',display_name:'演示老师',username:'teacher',is_admin:false,must_change_password:false},csrf:'offline',api_configured:true}:
          endpoint==='/api/students'?[]:
          endpoint==='/api/jobs'?{items:[],total:0,counts:{pending:1,needs_attention:1,processing:0,confirmed_today:0}}:
          endpoint==='/api/jobs/offline-review'?job:null;
        return route.fulfill({status:body===null?404:200,contentType:'application/json',body:JSON.stringify(body??{detail:'Browser fixture does not issue paid API requests'})});
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/static/index.html#review/offline-review`);
      await page.locator('.review-actions').waitFor({timeout:30000});
      assert.equal(await page.locator('#question-attention .question-card').count(),1,'ambiguous question is first');
      assert.equal(await page.locator('.review-corrections .question-card').count(),2,'incorrect and blank questions are prominent');
      assert.equal(await page.locator('.other-questions').evaluate(node=>node.open),false,'routine questions stay collapsed');
      assert.equal((await page.locator('[data-primary-review]').textContent()).trim(),'处理题目');
      const first = page.locator('[data-question="3"]');
      assert.equal(await first.evaluate(node=>node.open),true,'uncertain question is initially expanded');
      const more = first.locator('.question-more');
      assert.equal(await more.evaluate(node=>node.open),false,'dangerous actions are initially tucked away');
      await more.locator(':scope > summary').click();
      assert.equal(await first.locator('[data-delete-question]').isVisible(),true,'delete remains discoverable');
      if(size.name==='mobile') {
        const area=await page.locator('.review-action-buttons').boundingBox();
        const primary=await page.locator('[data-primary-review]').boundingBox();
        assert(primary.width>=area.width*0.78,'mobile primary button should use most of the footer width');
      }
      await page.screenshot({path:path.join(shots,`review-${size.name}.png`),fullPage:true});
      const routine=page.locator('.other-questions');
      await routine.locator(':scope > summary').click();
      const editable=page.locator('[data-question="0"]');
      await editable.locator(':scope > summary').click();
      assert.equal(await editable.locator('[data-action="judge-text"]').isVisible(),false,'no needless rejudging control before edits');
      const answer=editable.locator('[data-field="student_answer"]');
      const modeToggle=answer.locator('..').locator('.math-text-toggle');
      await modeToggle.waitFor({state:'visible',timeout:8000});
      await modeToggle.click(); // Exercise the teacher-visible '文字输入' route, not a hidden MathLive source.
      await answer.fill('7');
      const rejudge = editable.locator('[data-action="judge-text"]');
      try {await rejudge.waitFor({state:'visible',timeout:5000});}
      catch(error) {
        console.error('Rejudge diagnostics:',await editable.evaluate(card=>({
          cardOpen:card.open,
          input:card.querySelector('[data-field="student_answer"]')?.outerHTML,
          button:card.querySelector('[data-action="judge-text"]')?.outerHTML,
          hint:card.querySelector('[data-judgment-hint]')?.outerHTML,
          status:card.querySelector('[data-question-review]')?.textContent,
          groupOpen:card.closest('.other-questions')?.open
        })));
        throw error;
      }
      await routine.locator(':scope > summary').click();
      await page.locator('[data-primary-review]').click();
      assert.equal(await routine.evaluate(node=>node.open),true,'primary action opens collapsed group');
      assert.equal(await editable.evaluate(node=>node.open),true,'edited question becomes active');
      assert.equal(await page.locator('#question-attention [data-pending-count]').textContent().then(s=>s.trim()),'2 题需要人工判断');
      await page.screenshot({path:path.join(shots,`review-edited-${size.name}.png`),fullPage:true});
      if(size.name==='mobile'){
        await page.evaluate(()=>document.documentElement.dataset.theme='dark');
        await page.screenshot({path:path.join(shots,'review-mobile-dark.png'),fullPage:true});
      }
      await page.close();
    }
    assert.deepEqual(errors,[],'no uncaught browser errors');
    console.log('Chromium review smoke: PASS');
  } finally {await browser.close();await close();}
}
run().catch(err=>{console.error(err);process.exitCode=1;server.close();});
