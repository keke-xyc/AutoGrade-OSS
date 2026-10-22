// Chromium smoke for queue and upload pages, using only synthetic data.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require('playwright');

const {deflateSync}=require('node:zlib');
// Deterministic valid PNGs, created in memory so browser screenshots have no broken-image noise.
function pngChunk(type,payload){
  const data=Buffer.concat([Buffer.from(type),payload]);
  let crc=0xffffffff;
  for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  const chunk=Buffer.alloc(data.length+8);
  chunk.writeUInt32BE(payload.length,0);data.copy(chunk,4);chunk.writeUInt32BE((crc^0xffffffff)>>>0,data.length+4);
  return chunk;
}
function worksheetPng(offset=0){
  const width=240,height=300,rowSize=1+width*4,pixels=Buffer.alloc(rowSize*height);
  for(let y=0;y<height;y++){
    const row=y*rowSize;pixels[row]=0;
    for(let x=0;x<width;x++){
      const start=row+1+x*4;
      const bar=[32,78,126,177,225,267].some(n=>y>=n&&y<n+3&&x>25&&x<(n%2?182:155));
      const answer=[55,101,150,200,247].some(n=>y>=n&&y<n+2&&x>42+offset*5&&x<110+offset*9);
      const tone=bar?95:answer?168:250;
      pixels[start]=tone;pixels[start+1]=tone;pixels[start+2]=tone;pixels[start+3]=255;
    }
  }
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(pixels)),pngChunk('IEND',Buffer.alloc(0))]);
}

const root=path.resolve(__dirname,'../..');
const shots=path.join(root,'test-results/browser');
const contentTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'};
const mockJobs=[
  {id:'pending-1',student_name:'小明',grade:'四年级',day:'2026-10-18',status:'review',pages:2,error:null},
  {id:'done-2',student_name:'小红',grade:'五年级',day:'2026-10-17',status:'confirmed',pages:1,error:null},
  {id:'working-3',student_name:'小乐',grade:'三年级',day:'2026-10-18',status:'processing',pages:3,error:null}
];
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(!pathname.startsWith('/static/')){res.writeHead(404);res.end();return;}
  const file=path.resolve(root,'.'+pathname);
  if(!file.startsWith(path.join(root,'static')+path.sep)){res.writeHead(403);res.end();return;}
  try{
    const bytes=await fs.readFile(file);
    res.writeHead(200,{'content-type':contentTypes[path.extname(file)]||'application/octet-stream'});
    res.end(bytes);
  }catch{res.writeHead(404);res.end();}
});
const listen=()=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=()=>new Promise(resolve=>server.close(resolve));
async function test(){
  await fs.mkdir(shots,{recursive:true});await listen();
  const browser=await chromium.launch({headless:true});
  const errors=[],apiWrites=[];
  try{
    for(const size of [{width:320,height:568,name:'compact'},{width:390,height:844,name:'mobile'},{width:1280,height:900,name:'desktop'}]){
      const page=await browser.newPage({viewport:{width:size.width,height:size.height}});
      page.on('pageerror',e=>errors.push(size.name+': '+e.message));
      await page.route('**/api/**',route=>{
        const req=route.request(),url=new URL(req.url()),p=url.pathname;
        if(req.method()!=='GET')apiWrites.push(req.method()+' '+p);
        const response=p==='/api/me'?{user:{user_id:'offline',display_name:'演示老师',username:'teacher',is_admin:false,must_change_password:false},csrf:'offline',api_configured:true}:
          p==='/api/students'?[{id:'student-1',name:'小明',grade:'四年级'}]:
          p==='/api/jobs'?(url.searchParams.get('day_from')==='2027-01-01'?{items:[],total:0,counts:{pending:2,needs_attention:1,processing:1,confirmed_today:1}}:{items:mockJobs,total:mockJobs.length,counts:{pending:2,needs_attention:1,processing:1,confirmed_today:1}}):null;
        return route.fulfill({status:response===null?404:200,contentType:'application/json',body:JSON.stringify(response??{detail:'Not in offline fixture'})});
      });
      const base=`http://127.0.0.1:${server.address().port}/static/index.html`;
      await page.goto(base+'#queue');
      await page.locator('#jobs-list .job-card').first().waitFor();
      assert.equal(await page.locator('#jobs-list .job-card').count(),3,'shows all synthetic jobs');
      assert.equal(await page.locator('#jobs-list .job-card-footer a').first().textContent().then(s=>s.trim()),'继续复核 →');
      assert.equal(await page.locator('#job-filter-panel').evaluate(el=>el.open),false,'advanced filters start collapsed');
      await page.locator('#job-filter-panel>summary').click();
      await page.locator('#job-student-filter').selectOption('student-1');
      assert.equal(await page.locator('#job-filter-status').isVisible(),true,'applied filters remain visible while collapsed');
      await page.locator('#job-filter-panel>summary').click();
      assert.equal(await page.locator('#job-filter-panel').evaluate(el=>el.open),false);
      await page.screenshot({path:path.join(shots,`queue-${size.name}.png`),fullPage:true});
      // An empty filtered result should offer a reset, not suggest uploading a duplicate job.
      await page.locator('#job-filter-panel>summary').click();
      await page.locator('.date-filters>summary').click();
      await page.locator('#job-day-from').fill('2027-01-01');
      await page.locator('#jobs-list [data-clear-job-filters]').waitFor({state:'visible'});
      assert.match(await page.locator('#jobs-list').textContent(),/没有符合筛选条件/);
      await page.locator('[data-clear-job-filters]').click();
      await page.locator('#jobs-list .job-card').first().waitFor({state:'visible'});
      assert.equal(await page.locator('#jobs-list .job-card').count(),3);
      assert.equal(await page.locator('[data-filter="all"]').getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('#job-filter-status').isVisible(),false);
      await page.locator('#job-filter-panel>summary').click();
      await page.goto(base+'#upload');
      await page.locator('#student-select option[value="student-1"]').waitFor({state:'attached'});
      await page.locator('#student-select').selectOption('student-1');
      assert.equal(await page.locator('#upload-submit-title').textContent(),'等待选择照片');
      const image=worksheetPng();
      await page.locator('#photo-input').setInputFiles([{name:'first.png',mimeType:'image/png',buffer:image},{name:'second.png',mimeType:'image/png',buffer:worksheetPng(1)}]);
      await page.locator('#photo-count').filter({hasText:'已选择2张'}).waitFor();
      assert.equal(await page.locator('.photo-tile').count(),2);
      assert.equal(await page.locator('.photo-tile').first().locator('[data-remove-photo]').isVisible(),false,'deletion hidden until needed');
      await page.locator('.photo-tile').first().locator('.photo-actions>summary').click();
      assert.equal(await page.locator('.photo-tile').first().locator('[data-remove-photo]').isVisible(),true,'deletion still available');
      await page.locator('.photo-tile').first().locator('[data-move-photo][data-direction="1"]').click();
      assert.match(await page.locator('.photo-tile').first().locator('p').textContent(),/second.png/,'photo reorder still works');
      assert.match(await page.locator('#upload-submit-detail').textContent(),/小明/);
      await page.screenshot({path:path.join(shots,`upload-${size.name}.png`),fullPage:true});
      if(size.width<=390){
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
        assert(overflow<=2,'mobile upload should not have page-level horizontal overflow: '+overflow);
        if(size.name==='mobile'){
          await page.evaluate(()=>document.documentElement.dataset.theme='dark');
          await page.screenshot({path:path.join(shots,'upload-mobile-dark.png'),fullPage:true});
        }
      }
      await page.close();
    }
    assert.deepEqual(errors,[],'no uncaught browser exception');
    assert.deepEqual(apiWrites,[],'mock UI tests never submit files or call paid APIs');
    console.log('Workspace queue/upload Chromium smoke: PASS');
  }finally{await browser.close();await close();}
}
test().catch(e=>{console.error(e);process.exitCode=1;server.close();});
