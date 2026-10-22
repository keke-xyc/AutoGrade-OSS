/* Read-only formatting. Stored text and editable fields are never rewritten. */
(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const needsPreview = value => /\\[a-zA-Z]+|\\[([]|\$[^$\n]+\$|\*\*[^\n]+\*\*|`[^`\n]+`/.test(value || '');
  function prose(value) {
    return escape(value).replace(/\*\*([^\n]+?)\*\*/g,'<strong>$1</strong>').replace(/`([^`\n]+)`/g,'<code>$1</code>');
  }
  function math(value) {
    try {
      const renderer = typeof module !== 'undefined' && module.exports ? require('./vendor/katex/katex.min.js') : window.katex;
      return `<span class="math-run">${renderer.renderToString(value, {output:'mathml',displayMode:false,throwOnError:true,trust:false,strict:'ignore',maxSize:5,maxExpand:100,macros:{}})}</span>`;
    } catch {
      return `<span class="math-fallback">${escape(value)}</span><span class="formula-error">（公式未能排版，请核对原文）</span>`;
    }
  }
  function bareLine(line) {
    if(!/\\[a-zA-Z]+/.test(line))return prose(line);
    // ponytail: legacy bare LaTeX has no boundaries; separate Chinese prose, use explicit delimiters for complex mixed text.
    if(/\\(?:text|begin)\s*\{/.test(line))return math(line);
    return line.split(/([\u3400-\u9fff，。；：！？]+)/).map(part => /\\[a-zA-Z]+/.test(part) ? part.split(/;\s*/).map(math).join('<br>') : prose(part)).join('');
  }
  function textHTML(value) {
    return String(value ?? '').split(/(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\n]+\$)/g).map(part => {
      if(part.startsWith('$$')&&part.endsWith('$$'))return math(part.slice(2,-2));
      if((part.startsWith('\\[')&&part.endsWith('\\]'))||(part.startsWith('\\(')&&part.endsWith('\\)')))return math(part.slice(2,-2));
      if(part.startsWith('$')&&part.endsWith('$')&&part.length>2)return math(part.slice(1,-1));
      return part.split('\n').map(bareLine).join('<br>');
    }).join('');
  }
  function formulaParts(value) {
    const input=typeof module!=='undefined'&&module.exports?require('./math-input.js'):window.AutoGradeMath;
    if(!input)return [];
    const parts=[];
    // ponytail: recognize elementary numeric expressions, not arbitrary prose or a full LaTeX grammar.
    const pattern=/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\n]+\$|[=+\-−(\[<>]*[ \t]*(?:\d+(?:\.\d+)?|\\[a-zA-Z]+)(?:\\[a-zA-Z]+|[\d \t{}()[\].+\-−×÷*/=<>又])*/g;
    for(const match of String(value??'').matchAll(pattern)){
      const raw=match[0];let text=raw.trim().replace(/[ (\[]+$/,'');
      for(const [open,close] of [['(',')'],['[',']']]){
        while(text.endsWith(close)&&text.split(close).length>text.split(open).length)text=text.slice(0,-1).trimEnd();
      }
      const start=match.index+raw.indexOf(text);
      if(!/[\\/×÷又=<>+−-]/.test(text)||/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(text)||/(?:https?:\/\/|www\.)\S*$/.test(String(value).slice(0,start)))continue;
      const unwrapped=text.startsWith('$$')?text.slice(2,-2):/^(?:\\\[|\\\()/.test(text)?text.slice(2,-2):text.startsWith('$')?text.slice(1,-1):text;
      const latex=input.toLatex(unwrapped);
      if(latex===null||!latex||math(latex).includes('formula-error'))continue;
      parts.push({start,end:start+text.length,latex});
    }
    return parts;
  }
  function mixedHTML(value,editable=false) {
    const text=String(value??'');let end=0,html='';
    for(const part of formulaParts(text)){
      html+=textHTML(text.slice(end,part.start));
      const rendered=math(part.latex);
      html+=editable?`<button type="button" class="math-edit" data-math-start="${part.start}" aria-label="编辑公式：${escape(text.slice(part.start,part.end))}">${rendered}</button>`:rendered;
      end=part.end;
    }
    return html+textHTML(text.slice(end));
  }
  const api={needsPreview,textHTML,formulaParts,mixedHTML};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else window.AutoGradeText=api;
})();
