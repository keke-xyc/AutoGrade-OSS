/* MathLive is local and pinned; textareas remain the saved source of truth. */
(() => {
  function toLatex(value) {
    let text=String(value??'').trim().replace(/^\$([^$]*)\$$/,'$1').replace(/^\\\((.*)\\\)$/s,'$1');
    // ponytail: only pure elementary expressions; prose and unknown commands stay in the text editor.
    if(/[\r\n]/.test(text)||/[^\d\sa-zA-Z\\{}()[\].,+\-−×÷*/=<>又]/.test(text)||/[a-zA-Z]/.test(text.replace(/\\(?:frac|times|div|left|right|cdot|mathrm|,)/g,'')))return null;
    return text.replace(/(?<![\d./])(\d+)\s*(?:又|\s)\s*(\d+)\s*\/\s*(\d+)/g,'$1\\frac{$2}{$3}')
      .replace(/(\d+)\s*\/\s*(\d+)/g,'\\frac{$1}{$2}')
      .replace(/×|\*/g,'\\times ').replace(/÷/g,'\\div ').replace(/−/g,'-');
  }
  function savedLatex(value) {
    const fractions=value.replace(/\\frac\s*(?:\{([^{}]*)\}|(\d))\s*(?:\{([^{}]*)\}|(\d))/g,(_,a,b,c,d)=>`\\frac{${a??b}}{${c??d}}`);
    // A mixed number is a sum. Explicit multiplication remains \times or \cdot.
    return fractions.replace(/(?<![\d.])(\d+)(?:\s|\\[,;! ])*\\frac\{(\d+)\}\{(\d+)\}/g,'$1又$2/$3');
  }
  function mountMixed(wrapper) {
    if(wrapper.dataset.mathBound)return;
    wrapper.dataset.mathBound='true';
    const source=wrapper.querySelector('textarea'),preview=wrapper.querySelector('.math-preview');
    wrapper.querySelector('label').htmlFor=source.id;
    let active=null;
    const render=()=>{
      active=null;
      preview.hidden=!AutoGradeText.needsPreview(source.value)&&AutoGradeText.formulaParts(source.value).length===0;
      preview.innerHTML=preview.hidden?'':AutoGradeText.mixedHTML(source.value,true);
      preview.querySelectorAll('[data-math-start]').forEach(button=>button.disabled=source.disabled);
    };
    preview.addEventListener('pointerdown',event=>{if(event.target.closest('[data-math-start]'))event.preventDefault();});
    preview.addEventListener('click',event=>{
      const button=event.target.closest('[data-math-start]');
      if(!button||source.disabled||button.matches(':disabled'))return;
      let start=Number(button.dataset.mathStart);
      if(active&&start>active.start)start+=active.end-active.originalEnd;
      if(active)render();
      const part=AutoGradeText.formulaParts(source.value).find(p=>p.start===start);
      if(!part)return;
      const target=preview.querySelector(`[data-math-start="${start}"]`),field=new MathfieldElement();
      field.value=part.latex;field.className='math-inline-field';field.setAttribute('aria-label','编辑公式');
      // Manage this transient editor explicitly; auto refocus can reopen a keyboard the user closed.
      field.mathVirtualKeyboardPolicy='manual';field.smartFence=true;field.mathModeSpace='\\,';
      target.replaceWith(field);field.menuItems=[];field.inlineShortcuts={};
      const editing=active={start,end:part.end,originalEnd:part.end};
      field.addEventListener('input',event=>{
        event.stopPropagation();
        if(active!==editing)return;
        const value=savedLatex(field.getValue('latex-expanded'));
        source.value=source.value.slice(0,active.start)+value+source.value.slice(active.end);
        active.end=active.start+value.length;
        source.dispatchEvent(new Event('input',{bubbles:true}));
      });
      // MathLive briefly blurs while opening its keyboard, then restores focus.
      field.addEventListener('focusout',()=>requestAnimationFrame(()=>{
        if(active===editing&&!field.hasFocus()){
          render();
          if(!(document.activeElement instanceof MathfieldElement))mathVirtualKeyboard.hide();
        }
      }));
      field.focus();
      if(window.matchMedia?.('(pointer:coarse)').matches)mathVirtualKeyboard.show();
    });
  }
  function mount(root) {
    if(!window.MathfieldElement)return;
    MathfieldElement.fontsDirectory='/static/vendor/mathlive/fonts';
    MathfieldElement.soundsDirectory=null;
    MathfieldElement.locale='zh-cn';
    mathVirtualKeyboard.editToolbar='none';
    mathVirtualKeyboard.layouts={rows:[
      ['7','8','9','+','-','\\div'],
      ['4','5','6','(',')','\\times'],
      ['1','2','3','<','>','='],
      ['0','.',{label:'分数',class:'small',insert:'\\frac{#?}{#?}'},{label:'带分数',class:'small',insert:'#?\\frac{#?}{#?}',width:2},{label:'下一格',class:'small',command:'moveToNextPlaceholder'}],
      ['[left]','[right]','[undo]',{label:'[backspace]',width:1},{label:'[hide-keyboard]',width:2}]
    ]};
    root.querySelectorAll('.math-mixed-input').forEach(wrapper=>{if(wrapper.closest('.question-card').open)mountMixed(wrapper);});
    root.querySelectorAll('.math-input').forEach(wrapper=>{
      if(wrapper.closest('.math-mixed-input'))return;
      if(wrapper.querySelector('math-field')||!wrapper.closest('.question-card').open)return;
      const source=wrapper.querySelector('textarea'),latex=toLatex(source.value);
      const field=new MathfieldElement();
      field.value=latex??'';field.setAttribute('aria-label',source.previousElementSibling?.textContent||'数学算式');
      field.id=source.id+'-math';source.previousElementSibling.htmlFor=latex===null?source.id:field.id;
      field.mathVirtualKeyboardPolicy='auto';field.smartFence=true;field.mathModeSpace='\\,';
      source.hidden=latex!==null;field.hidden=latex===null;wrapper.querySelector('.math-symbols').hidden=latex!==null;
      wrapper.insertBefore(field,source);
      field.menuItems=[];field.inlineShortcuts={};
      field.readOnly=source.disabled;
      const toggle=document.createElement('button');toggle.type='button';toggle.className='text-button math-text-toggle';toggle.textContent=latex===null?'公式输入':'文字输入';
      toggle.disabled=source.disabled;
      toggle.addEventListener('click',()=>{
        const textMode=source.hidden;
        if(!textMode){const next=toLatex(source.value);if(next===null){source.setCustomValidity('公式输入仅支持算式，请先去掉文字说明。');source.reportValidity();source.setCustomValidity('');return;}field.value=next;}
        source.hidden=!textMode;field.hidden=textMode;toggle.textContent=textMode?'公式输入':'文字输入';
        wrapper.querySelector('label').htmlFor=textMode?source.id:field.id;
        wrapper.querySelector('.math-symbols').hidden=!textMode;
        (textMode?source:field).focus();
      });
      wrapper.append(toggle);
      field.addEventListener('input',event=>{
        event.stopPropagation();
        source.value=savedLatex(field.getValue('latex-expanded'));
        source.dispatchEvent(new Event('input',{bubbles:true}));
      });
    });
    root.querySelectorAll('.question-card').forEach(card=>{
      if(card.dataset.mathBound)return;
      card.dataset.mathBound='true';
      card.addEventListener('toggle',()=>{if(card.open)mount(card);});
    });
  }
  const api={toLatex,savedLatex,mount};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else window.AutoGradeMath=api;
})();
