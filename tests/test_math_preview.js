// Real local KaTeX and actual review functions; no model/network/browser.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const format=require('../static/math-preview.js');
const mathInput=require('../static/math-input.js');
assert.equal(mathInput.toLatex('9/8÷7/12'),String.raw`\frac{9}{8}\div \frac{7}{12}`);
for(const value of ['8又1/3','8 1/3'])assert.equal(mathInput.toLatex(value),String.raw`8\frac{1}{3}`);
for(const value of ['计算：9/8÷7/12','题干辨认不清','<img src=x>',String.raw`\href{https://x}{1}`])assert.equal(mathInput.toLatex(value),null);
assert.equal(mathInput.toLatex('1/2\n3/4'),null,'separate answer lines must not be merged into one expression');
assert.equal(mathInput.savedLatex(String.raw`\frac16\div8\frac13`),String.raw`\frac{1}{6}\div8又1/3`);
assert.equal(mathInput.savedLatex(String.raw`2-8\frac{1}{3}+8\times\frac13`),String.raw`2-8又1/3+8\times\frac{1}{3}`);
assert.equal(mathInput.savedLatex(String.raw`\frac{12}{25}\div\frac{3}{8}`),String.raw`\frac{12}{25}\div\frac{3}{8}`);
assert.equal(mathInput.savedLatex(String.raw`8\,\frac13`),'8又1/3');
assert.equal(mathInput.savedLatex(String.raw`1.8\frac13`),String.raw`1.8\frac{1}{3}`,'a decimal is not silently treated as an integer part');
const original=String.raw`(8888×\frac{1}{4}+4444×\frac{1}{3}-2222×\frac{1}{6})÷\frac{5}{6}-1500`;
const answer=String.raw`=(1111×2+1111×\frac{4}{3}-1111×\frac{1}{3})×\frac{6}{5}-1500; =[(2+\frac{4}{3}-\frac{1}{3})×1111]×\frac{6}{5}-1500`;
const mixedAnswer='= 3/2×15/4×13/50，经约分后末行写“1/4”';
const mixedExpected='117/80（即1.4625）';
for(const [text,count] of [[mixedAnswer,2],[mixedExpected,1],['原式=3/2×15/4×13/50=117/80，学生最后写1/4。',2],['第一步：1/2+1/3\n第二步：5/6',2]]){
  const parts=format.formulaParts(text);
  assert.equal(parts.length,count,text);
  for(const part of parts)assert.ok(text.slice(part.start,part.end).trim(),'source ranges must refer to the original text');
  assert.match(format.mixedHTML(text,true),/<mfrac>/);
  assert.equal((format.mixedHTML(text,true).match(/data-math-start=/g)||[]).length,count);
}
assert.match(format.mixedHTML(mixedAnswer,true),/经约分后末行写/);
assert.match(format.mixedHTML(mixedExpected,true),/即1\.4625/);
const annotation='117/80 (即1.4625)';
const annotationPart=format.formulaParts(annotation)[0];
assert.equal(annotation.slice(annotationPart.start,annotationPart.end),'117/80','annotation parentheses remain outside the editable formula');
for(const [text,formula] of [['(即117/80)','117/80'],['结果为(1/2+1/3)','(1/2+1/3)']]){
  const part=format.formulaParts(text)[0];
  assert.equal(text.slice(part.start,part.end),formula,'only formula parentheses belong to the editable range');
}
for(const text of ['2026-10-06','2026/10/06','https://example.com/3/8','第1页：共22题'])assert.equal(format.formulaParts(text).length,0,'dates, URLs and page counts are not formula edits');
for(const text of ['<img src=1/2 onerror=alert(1)>',String.raw`$\href{javascript:alert(1)}{1/2}$`])assert.doesNotMatch(format.mixedHTML(text,true),/<(?:script|img|a)\b/i);
for(const text of [original,answer,String.raw`计算：$\frac{1}{2}+\frac{1}{3}$，请约分。`,String.raw`\(\sqrt{9}+x^2\)`,String.raw`$$\frac{1}{\frac{2}{3}}$$`]){
  assert.equal(format.needsPreview(text),true);
  const html=format.textHTML(text);assert.match(html,/<math /);assert.doesNotMatch(html,/公式未能排版/);
}
assert.match(format.textHTML(original),/<mfrac>/);
assert.match(format.textHTML(String.raw`答案是\frac{1}{2}。`),/^答案是.*<mfrac>.*。$/);
assert.match(format.textHTML('**计算过程**\n继续核对'),/<strong>计算过程<\/strong><br>继续核对/);
assert.match(format.textHTML(String.raw`\frac{1}{`),/公式未能排版/);
assert.match(format.textHTML(String.raw`\def\a{\a}\a`),/公式未能排版/);
for(const input of ['<img src=x onerror=alert(1)>',String.raw`$\href{javascript:alert(1)}{x}$`,String.raw`$\includegraphics{https://example.com/x}$`]){
  assert.doesNotMatch(format.textHTML(input),/<(?:script|img|a)\b/i);
}
const source=fs.readFileSync(require.resolve('../static/app.js'),'utf8');
function actual(name){const start=source.indexOf(`function ${name}(`);assert.ok(start>=0);return source.slice(start,source.indexOf('\n}',start)+2);}
const context=vm.createContext({AutoGradeText:format,structuredClone,Event});
vm.runInContext(source.split('\n').find(line=>line.startsWith('const escapeHTML =')),context);
for(const name of ['reviewTextField','insertMathSymbol','updateTextPreview','collectReview'])vm.runInContext(actual(name),context);
const field=context.reviewTextField('question','原题',original);
assert.match(field,/<mfrac>/);assert.match(field,/<details class="math-source"><summary>编辑文字/);
assert.ok(field.includes(`>${original}</textarea>`),'the source must not be converted or reformatted');
assert.doesNotMatch(context.reviewTextField('expected_answer','参考答案','2499.6'),/<details/);
for(const name of ['question','student_answer','expected_answer'])assert.equal((context.reviewTextField(name,'题目','9/8').match(/data-math-symbol=/g)||[]).length,10);
assert.doesNotMatch(context.reviewTextField('explanation','说明','提示'),/data-math-symbol/);
context.AutoGradeMath=mathInput;
assert.doesNotMatch(context.reviewTextField('question','原题',original),/<details|math-preview/,'pure expressions use one visual editor');
assert.match(context.reviewTextField('question','原题','题目：'+original),/<details/,'prose keeps its original text editor');
for(const [name,text] of [['student_answer',mixedAnswer],['expected_answer',mixedExpected],['explanation','学生最后写1/4，正确结果为117/80。']]){
  const html=context.reviewTextField(name,'说明',text);
  assert.match(html,/math-mixed-input/);assert.match(html,/data-math-start=/);assert.match(html,/<mfrac>/);
  assert.ok(html.includes(`>${text}</textarea>`),'mixed fields must keep the complete source unchanged');
}
assert.match(field,/data-math-symbol="&lt;"/);
const editor={value:'9/8x7/12',selectionStart:3,selectionEnd:4,disabled:false,events:[],
  matches(){return this.disabled;},setRangeText(text,start,end,mode){assert.equal(mode,'end');this.value=this.value.slice(0,start)+text+this.value.slice(end);this.selectionStart=this.selectionEnd=start+text.length;},
  focus(){this.focused=true;},dispatchEvent(event){this.events.push(event);}};
const symbolButton={dataset:{mathSymbol:'÷'},disabled:false,matches(){return this.disabled;},closest:()=>({querySelector:()=>editor})};
context.insertMathSymbol(symbolButton);
assert.equal(editor.value,'9/8÷7/12');assert.equal(editor.selectionStart,4);assert.equal(editor.selectionEnd,4);
assert.equal(editor.focused,true);assert.equal(editor.events.length,1);assert.equal(editor.events[0].type,'input');assert.equal(editor.events[0].bubbles,true);
editor.selectionStart=editor.selectionEnd=3;symbolButton.dataset.mathSymbol='(';
context.insertMathSymbol(symbolButton);assert.equal(editor.value,'9/8(÷7/12');assert.equal(editor.selectionStart,4);
for(const target of [editor,symbolButton]){target.disabled=true;context.insertMathSymbol(symbolButton);target.disabled=false;}
assert.equal(editor.value,'9/8(÷7/12');assert.equal(editor.events.length,2,'locked controls cannot modify a draft');
const preview={hidden:true,innerHTML:''};
const input={value:String.raw`\frac{3}{8}`,dataset:{field:'question'},closest:()=>({querySelector:()=>preview})};
context.updateTextPreview(input);assert.match(preview.innerHTML,/<mfrac>/);assert.equal(preview.hidden,false);
assert.equal(input.value,String.raw`\frac{3}{8}`);
input.value='普通文字';context.updateTextPreview(input);assert.equal(preview.hidden,true);
const question={page:1,number:'1',question:original,student_answer:answer,expected_answer:'2499.6',explanation:String.raw`应先算$2+\frac{4}{3}-\frac{1}{3}=3$。`,status:'incorrect'};
const nodes={'#review-view':{dataset:{jobId:'offline'}},'#observations':{value:''},'#warnings':{value:''},'#teacher-notes':{value:''},'#reviewed':{checked:false}};
context.state={job:{id:'offline',revision:1,result:{questions:[question],observations:[],warnings:[]}},route:'#review/offline'};
context.$=selector=>nodes[selector];
context.$$=selector=>selector==='[data-question]'?[{dataset:{question:'0'},querySelectorAll:()=>Object.entries(question).filter(([key])=>!['page','number'].includes(key)).map(([key,value])=>({dataset:{field:key},value}))}]:[];
assert.equal(JSON.stringify(context.collectReview().result.questions[0]),JSON.stringify(question),'save must retain every original formula string');
// A keyboard toggle may blur and refocus MathLive during the same interaction.
const frames=[];let inlineField=null,repaints=0;
class MockMathfield {
  constructor(){this.listeners={};this.focused=false;}
  setAttribute(){}
  addEventListener(type,handler){this.listeners[type]=handler;}
  focus(){this.focused=true;}
  hasFocus(){return this.focused;}
}
const mixedSource={id:'keyboard-source',value:'1/2（参考）',disabled:false};
const mixedPreview={addEventListener(type,handler){this[type]=handler;},querySelector(){return{replaceWith(field){inlineField=field;}};},querySelectorAll(){return[];},set innerHTML(value){repaints++;}};
const mixedWrapper={dataset:{},closest(){return{open:true};},querySelector(selector){return selector==='textarea'?mixedSource:selector==='label'?{}:mixedPreview;}};
let keyboardHides=0;
const keyboardContext=vm.createContext({window:{MathfieldElement:MockMathfield},document:{activeElement:null},MathfieldElement:MockMathfield,mathVirtualKeyboard:{hide(){keyboardHides++;}},AutoGradeText:format,requestAnimationFrame:callback=>frames.push(callback)});
vm.runInContext(fs.readFileSync(require.resolve('../static/math-input.js'),'utf8'),keyboardContext);
keyboardContext.window.AutoGradeMath.mount({querySelectorAll:selector=>selector==='.math-mixed-input'?[mixedWrapper]:[]});
mixedPreview.click({target:{closest:()=>({dataset:{mathStart:'0'},matches:()=>false})}});
inlineField.focused=false;inlineField.listeners.focusout();
assert.equal(repaints,0,'a transient blur must not remove the editor immediately');
inlineField.focused=true;frames.shift()();
assert.equal(repaints,0,'keyboard refocus must preserve the live editor');
assert.equal(keyboardHides,0,'transient keyboard focus must not close the keyboard');
inlineField.focused=false;inlineField.listeners.focusout();frames.shift()();
assert.equal(repaints,1,'leaving the editor must restore the preview');
assert.equal(keyboardHides,1,'leaving all math fields must close the keyboard');
assert.equal(mixedSource.value,'1/2（参考）','focus transitions must not rewrite an answer');
console.log('Formula fractions, mixed text, safe failures, injection guards, edit previews and unchanged save payload: OK');
