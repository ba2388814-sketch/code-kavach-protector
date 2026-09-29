/* ============================================================
   কোড-কবচ প্রো — এ কে এম রেদওয়ান
   secure.js — main application logic (split from single-file build)
   ============================================================ */
(function(){
  const $ = id => document.getElementById(id);
  const input = $('input'), output = $('output');
  const inStat = $('inStat'), outStat = $('outStat'), savings = $('savings');
  const validateStat = $('validateStat');
  let lastPreviewUrl = null;
  const historyStore = []; // in-memory only, this session
  const SIZE_WARN_BYTES = 400 * 1024;

  // OPTIONAL: if you run a background keep-alive/health-check service for this tool
  // (e.g. a Render.com instance), set its URL here. Left unused by default — no
  // network calls are made unless you wire KEEPALIVE_URL up yourself below.
  const KEEPALIVE_URL = "https://code-kavach-redwan.onrender.com";
  // Example (disabled by default):
  // if (KEEPALIVE_URL) { fetch(KEEPALIVE_URL, {mode:'no-cors'}).catch(function(){}); }

  // ---------- unified save helper: uses the platform's downloads capability when this
  // page is running as a published Claude artifact (plain blob <a download> links are
  // inert there); falls back to the classic blob-link trick everywhere else. ----------
  async function saveFile(filename, blobOrString, mime){
    const blob = (blobOrString instanceof Blob) ? blobOrString : new Blob([blobOrString], {type: mime || 'text/plain'});
    try{
      if(window.claude && typeof window.claude.use === 'function'){
        const downloads = await window.claude.use('downloads');
        if(downloads){
          await downloads.save({filename, data: blob});
          return true;
        }
      }
    }catch(err){
      if(err && (err.code === 'declined' || err.code === 'rate_limited')) return false;
      // fall through to classic download on any other error
    }
    try{
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 4000);
      return true;
    }catch(e2){
      return false;
    }
  }

  function bytes(str){ return new Blob([str]).size; }
  function fmt(n){
    if(n < 1024) return n + ' B';
    if(n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/1024/1024).toFixed(2) + ' MB';
  }
  function refreshInStat(){ inStat.textContent = fmt(bytes(input.value || '')); }
  input.addEventListener('input', refreshInStat);
  refreshInStat();

  $('btnClear').addEventListener('click', () => { input.value=''; refreshInStat(); });
  $('btnUpload').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if(!f) return;
    const reader = new FileReader();
    reader.onload = ev => { input.value = ev.target.result; refreshInStat(); };
    reader.readAsText(f);
  });

  // ---------- theme ----------
  $('btnTheme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', cur === 'light' ? 'dark' : 'light');
  });

  // ---------- JS comment stripper ----------
  function stripJSComments(code){
    let out = '', i = 0, n = code.length, inStr = null, lastSig = '';
    while(i < n){
      const c = code[i], c2 = code[i+1];
      if(inStr){
        out += c;
        if(c === '\\'){ out += (code[i+1]||''); i += 2; continue; }
        if(c === inStr) inStr = null;
        i++; continue;
      }
      if(c === '"' || c === "'" || c === '`'){ inStr = c; out += c; lastSig = c; i++; continue; }
      if(c === '/' && c2 === '/'){ while(i<n && code[i] !== '\n') i++; continue; }
      if(c === '/' && c2 === '*'){ i += 2; while(i<n && !(code[i]==='*' && code[i+1]==='/')) i++; i += 2; continue; }
      if(c === '/' && c2 !== '/' && c2 !== '*'){
        const regexOk = lastSig === '' || /[=(:,;!&|?{}\[+\-*%^~<>\n]/.test(lastSig) ||
          /\b(return|typeof|case|do|else|yield|delete|void|instanceof|in|new|throw)$/.test(out.slice(-8));
        if(regexOk){
          let j = i+1, inClass = false, closed = false;
          out += c;
          while(j<n){
            const rc = code[j];
            if(rc === '\\'){ out += rc + (code[j+1]||''); j += 2; continue; }
            if(rc === '\n') break;
            out += rc;
            if(rc === '[') inClass = true;
            else if(rc === ']') inClass = false;
            else if(rc === '/' && !inClass){ j++; closed = true; break; }
            j++;
          }
          if(closed){
            while(j<n && /[a-z]/i.test(code[j])){ out += code[j]; j++; }
            i = j; lastSig = '/'; continue;
          }
          out = out.slice(0, out.length - (j-i));
          out += c; lastSig = c; i++; continue;
        }
      }
      out += c;
      if(!/\s/.test(c)) lastSig = c;
      i++;
    }
    return out;
  }
  function minifyJS(code){
    code = stripJSComments(code);
    code = code.split('\n').map(l => l.replace(/[ \t]+/g,' ').trim()).filter(l => l.length).join('\n');
    return code;
  }
  function minifyCSS(css){
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    css = css.replace(/\s+/g, ' ');
    css = css.replace(/\s*([{}:;,])\s*/g, '$1');
    css = css.replace(/;}/g, '}');
    return css.trim();
  }
  function minifyHTML(html){
    const blocks = [];
    const stash = (match) => { blocks.push(match); return '@@KAVACH_BLOCK_' + (blocks.length-1) + '@@'; };
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, m => stash(m));
    html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, m => stash(m));
    html = html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, m => stash(m));
    html = html.replace(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi, m => stash(m));
    html = html.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
    html = html.replace(/>\s+</g, '><').replace(/[ \t]{2,}/g, ' ').replace(/\n\s*/g, '\n').trim();
    html = html.replace(/@@KAVACH_BLOCK_(\d+)@@/g, (_, idx) => {
      let block = blocks[+idx];
      if(/^<script/i.test(block)){
        block = block.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/i, (m, open, body, close) => {
          if(/\ssrc\s*=/.test(open)) return m;
          return open + minifyJS(body) + close;
        });
      } else if(/^<style/i.test(block)){
        block = block.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/i, (m, open, body, close) => open + minifyCSS(body) + close);
      }
      return block;
    });
    return html;
  }
  function injectBaseHref(html, baseHref){
    if(!baseHref) return html;
    const safe = baseHref.replace(/"/g, '&quot;');
    const tag = '<base href="' + safe + '">';
    if(/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + tag);
    if(/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, m => m + '<head>' + tag + '</head>');
    return tag + html;
  }

  // ---------- in-browser WASM assembler ----------
  function wasmUleb128(n){ const out=[]; while(true){ let b=n&0x7f; n=n>>>7; if(n){out.push(b|0x80);}else{out.push(b);return out;} } }
  function wasmSleb128(n){ const out=[]; let more=true; while(more){ let b=n&0x7f; n=n>>7; if((n===0&&(b&0x40)===0)||(n===-1&&(b&0x40)!==0))more=false; else b|=0x80; out.push(b);} return out; }
  function wasmSection(id, payload){ return [id, ...wasmUleb128(payload.length), ...payload]; }
  function wasmVec(items){ return [...wasmUleb128(items.length), ...[].concat(...items)]; }
  function W_LOCAL_GET(i){ return [0x20, ...wasmUleb128(i)]; }
  function W_LOCAL_SET(i){ return [0x21, ...wasmUleb128(i)]; }
  function W_I32_CONST(n){ return [0x41, ...wasmSleb128(n)]; }
  const W_I32_ADD=[0x6a], W_I32_SUB=[0x6b], W_I32_XOR=[0x73], W_I32_REM_U=[0x70], W_I32_REM_S=[0x6f], W_I32_GE_U=[0x4f];
  function W_I32_LOAD8_U(o){ return [0x2d, 0x00, ...wasmUleb128(o||0)]; }
  function W_I32_STORE8(o){ return [0x3a, 0x00, ...wasmUleb128(o||0)]; }
  const W_BLOCK=[0x02,0x40], W_LOOP=[0x03,0x40], W_END=[0x0b], W_NOP=[0x01];
  function W_BR(d){ return [0x0c, ...wasmUleb128(d)]; }
  function W_BR_IF(d){ return [0x0d, ...wasmUleb128(d)]; }
  function wasmStrBytes(s){ const b=[]; for(let i=0;i<s.length;i++) b.push(s.charCodeAt(i)); return b; }
  function wasmExportEntry(name, kind, idx){ const nb=wasmStrBytes(name); return [...wasmUleb128(nb.length), ...nb, kind, ...wasmUleb128(idx)]; }
  function buildWasmXorFn(extraNops){
    let body=[];
    body.push(...W_I32_CONST(0), ...W_LOCAL_SET(5));
    body.push(...W_BLOCK, ...W_LOOP);
    body.push(...W_LOCAL_GET(5), ...W_LOCAL_GET(1), ...W_I32_GE_U, ...W_BR_IF(1));
    body.push(...W_LOCAL_GET(5), ...W_LOCAL_GET(3), ...W_I32_REM_U, ...W_LOCAL_SET(7));
    body.push(...W_LOCAL_GET(0), ...W_LOCAL_GET(5), ...W_I32_ADD, ...W_I32_LOAD8_U());
    body.push(...W_LOCAL_GET(2), ...W_LOCAL_GET(7), ...W_I32_ADD, ...W_I32_LOAD8_U());
    body.push(...W_I32_XOR, ...W_LOCAL_SET(6));
    body.push(...W_LOCAL_GET(4), ...W_LOCAL_GET(5), ...W_I32_ADD, ...W_LOCAL_GET(6), ...W_I32_STORE8());
    body.push(...W_LOCAL_GET(5), ...W_I32_CONST(1), ...W_I32_ADD, ...W_LOCAL_SET(5));
    for(let i=0;i<extraNops;i++) body.push(...W_NOP);
    body.push(...W_BR(0), ...W_END, ...W_END, ...W_END);
    const localsDecl = wasmVec([[...wasmUleb128(3), 0x7f]]);
    const fb = [...localsDecl, ...body];
    return [...wasmUleb128(fb.length), ...fb];
  }
  function buildWasmRotFn(extraNops){
    let body=[];
    body.push(...W_I32_CONST(0), ...W_LOCAL_SET(4));
    body.push(...W_BLOCK, ...W_LOOP);
    body.push(...W_LOCAL_GET(4), ...W_LOCAL_GET(1), ...W_I32_GE_U, ...W_BR_IF(1));
    body.push(...W_LOCAL_GET(0), ...W_LOCAL_GET(4), ...W_I32_ADD, ...W_I32_LOAD8_U());
    body.push(...W_LOCAL_GET(2), ...W_I32_SUB, ...W_LOCAL_SET(5));
    body.push(...W_LOCAL_GET(5), ...W_I32_CONST(256), ...W_I32_REM_S);
    body.push(...W_I32_CONST(256), ...W_I32_ADD);
    body.push(...W_I32_CONST(256), ...W_I32_REM_S, ...W_LOCAL_SET(6));
    body.push(...W_LOCAL_GET(3), ...W_LOCAL_GET(4), ...W_I32_ADD, ...W_LOCAL_GET(6), ...W_I32_STORE8());
    body.push(...W_LOCAL_GET(4), ...W_I32_CONST(1), ...W_I32_ADD, ...W_LOCAL_SET(4));
    for(let i=0;i<extraNops;i++) body.push(...W_NOP);
    body.push(...W_BR(0), ...W_END, ...W_END, ...W_END);
    const localsDecl = wasmVec([[...wasmUleb128(3), 0x7f]]);
    const fb = [...localsDecl, ...body];
    return [...wasmUleb128(fb.length), ...fb];
  }
  function buildKavachWasmModule(xorName, rotName, extraNop1, extraNop2, junkBytes){
    const typeXor = [0x60, ...wasmVec([[0x7f],[0x7f],[0x7f],[0x7f],[0x7f]]), ...wasmVec([])];
    const typeRot = [0x60, ...wasmVec([[0x7f],[0x7f],[0x7f],[0x7f]]), ...wasmVec([])];
    const typeSec = wasmSection(1, wasmVec([typeXor, typeRot]));
    const funcSec = wasmSection(3, wasmVec([wasmUleb128(0), wasmUleb128(1)]));
    const memSec = wasmSection(5, wasmVec([[0x00, ...wasmUleb128(1)]]));
    const exportSec = wasmSection(7, wasmVec([
      wasmExportEntry('memory', 0x02, 0),
      wasmExportEntry(xorName, 0x00, 0),
      wasmExportEntry(rotName, 0x00, 1),
    ]));
    const codeSec = wasmSection(10, wasmVec([ buildWasmXorFn(extraNop1), buildWasmRotFn(extraNop2) ]));
    let mod = [0x00,0x61,0x73,0x6d, 0x01,0x00,0x00,0x00, ...typeSec, ...funcSec, ...memSec, ...exportSec, ...codeSec];
    if(junkBytes && junkBytes.length){
      const cname = wasmStrBytes('k');
      const payload = [...wasmUleb128(cname.length), ...cname, ...junkBytes];
      mod = mod.concat(wasmSection(0, payload));
    }
    return mod;
  }
  function bytesToBase64(byteArr){
    let bin = '';
    for(let i=0;i<byteArr.length;i++) bin += String.fromCharCode(byteArr[i]);
    return btoa(bin);
  }

  // ---------- cipher primitives ----------
  function toBytes(str){ return unescape(encodeURIComponent(str)); }
  function b64encode(byteStr){ return btoa(byteStr); }
  function xorEncode(byteStr, key){
    const out = new Array(byteStr.length);
    for(let i=0;i<byteStr.length;i++) out[i] = String.fromCharCode(byteStr.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    return out.join('');
  }
  function rotEncode(byteStr, shift){
    const out = new Array(byteStr.length);
    const s = ((shift % 256) + 256) % 256;
    for(let i=0;i<byteStr.length;i++) out[i] = String.fromCharCode((byteStr.charCodeAt(i) + s) % 256);
    return out.join('');
  }
  function randomKey(len){
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let k = '';
    for(let i=0;i<len;i++) k += chars[Math.floor(Math.random()*chars.length)];
    return k;
  }
  function randInt(min, max){ return min + Math.floor(Math.random() * (max - min + 1)); }
  function shuffleArr(arr){
    const a = arr.slice();
    for(let i=a.length-1;i>0;i--){ const j = randInt(0,i); const t=a[i]; a[i]=a[j]; a[j]=t; }
    return a;
  }

  function makeNamer(){
    const used = new Set();
    const first = '_$';
    const rest = '0123456789';
    return function(){
      let n;
      do {
        n = first[randInt(0, first.length-1)];
        const len = randInt(4, 9);
        for(let i=0;i<len;i++) n += rest[randInt(0, rest.length-1)];
      } while(used.has(n));
      used.add(n);
      return n;
    };
  }
  function makeStrHelper(namer){
    const shift = randInt(3, 90);
    const helperName = namer();
    const decl = 'function ' + helperName + '(a){var o=new Array(a.length);for(var i=0;i<a.length;i++){o[i]=String.fromCharCode(a[i]-' + shift + ');}return o.join("");}';
    function enc(str){
      const codes = new Array(str.length);
      for(let i=0;i<str.length;i++) codes[i] = str.charCodeAt(i) + shift;
      return helperName + '(' + JSON.stringify(codes) + ')';
    }
    return { decl: decl, enc: enc };
  }
  function shiftedCodesExpr(str, shift, helperName){
    const codes = str.split('').map(c => c.charCodeAt(0) + shift);
    return helperName + '(' + JSON.stringify(codes) + ')';
  }
  function shuffleIdx(n){
    const a = Array.from({length:n}, (_,i)=>i);
    for(let i=a.length-1;i>0;i--){ const j = randInt(0, i); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function splitChunks(str, n){
    n = Math.max(2, Math.min(12, n));
    const len = str.length;
    if(len < n) n = Math.max(1, len);
    if(n <= 1) return [str];
    const cutsSet = new Set();
    while(cutsSet.size < n-1){ cutsSet.add(randInt(1, len-1)); }
    const cuts = Array.from(cutsSet).sort((a,b)=>a-b);
    const parts = [];
    let prev = 0;
    for(const c of cuts){ parts.push(str.slice(prev, c)); prev = c; }
    parts.push(str.slice(prev));
    return parts;
  }

  function buildAntiFeatures(s, namer){
    let js = '';
    const needsStr = s.consoleWarn || s.devToolsDetect || s.timingDebug || s.botDetect || (s.selfDestruct && (s.viewLimit > 0 || s.timeLimitMinutes > 0));
    let strH = null;
    if(needsStr){ strH = makeStrHelper(namer); js += strH.decl; }

    if(s.noRightClick) js += 'document.addEventListener("contextmenu",function(e){e.preventDefault();});';
    if(s.noDevtoolsKeys){
      js += 'document.addEventListener("keydown",function(e){var k=e.key?e.key.toUpperCase():"";' +
            'if(k==="F12"||(e.ctrlKey&&e.shiftKey&&(k==="I"||k==="J"||k==="C"))||(e.ctrlKey&&k==="U")){e.preventDefault();}});';
    }
    if(s.debugTrap) js += 'setInterval(function(){ debugger; }, 800);';
    if(s.noSelect){
      js += 'var _st=document.createElement("style");_st.textContent="*:not(input):not(textarea):not(select):not([contenteditable]):not([contenteditable] *){user-select:none !important;-webkit-user-select:none !important;}";document.head.appendChild(_st);' +
            'document.addEventListener("copy",function(e){var t=e.target&&e.target.tagName;if(t==="INPUT"||t==="TEXTAREA"||(e.target&&e.target.isContentEditable))return;e.preventDefault();});' +
            'document.addEventListener("selectstart",function(e){var t=e.target&&e.target.tagName;if(t==="INPUT"||t==="TEXTAREA"||(e.target&&e.target.isContentEditable))return;e.preventDefault();});';
    }
    if(s.noImgDrag){
      js += 'document.addEventListener("dragstart",function(e){if(e.target&&e.target.tagName==="IMG")e.preventDefault();});' +
            'document.addEventListener("DOMContentLoaded",function(){var imgs=document.getElementsByTagName("img");for(var i=0;i<imgs.length;i++){imgs[i].setAttribute("draggable","false");}});';
    }
    if(s.frameBust) js += 'if(window.top!==window.self){try{window.top.location=window.self.location;}catch(e){document.documentElement.style.display="none";}}';
    if(s.consoleWarn){
      js += 'try{console.log("%c"+' + strH.enc('থামুন!') + ',"color:#d9634c;font-size:34px;font-weight:bold;");' +
            'console.log("%c"+' + strH.enc('এই কনসোলে কিছু পেস্ট করলে আপনার অ্যাকাউন্ট/ডেটা ঝুঁকিতে পড়তে পারে। কোনো নির্দেশনা অনুযায়ী কোড পেস্ট করবেন না।') + ',"font-size:14px;");}catch(e){}';
    }
    if(s.devToolsDetect){
      js += '(function(){var _isTouch=("ontouchstart" in window)||(navigator.maxTouchPoints>0);if(_isTouch)return;' +
            'var _thr=220,_hits=0,_warn;' +
            'function _ensure(){if(!_warn&&document.body){_warn=document.createElement("div");' +
            '_warn.style.cssText="display:none;position:fixed;inset:0;z-index:2147483647;background:#111;color:#999;font-family:sans-serif;align-items:center;justify-content:center;text-align:center;padding:20px;";' +
            '_warn.textContent=' + strH.enc('এই মুহূর্তে কনটেন্ট দেখানো সম্ভব হচ্ছে না।') + ';document.body.appendChild(_warn);}}' +
            'setInterval(function(){_ensure();' +
            'var _wd=(window.outerWidth-window.innerWidth)>_thr,_hd=(window.outerHeight-window.innerHeight)>_thr;' +
            'if(_wd||_hd){_hits++;}else{_hits=0;if(_warn)_warn.style.display="none";}' +
            'if(_hits>=4&&_warn){_warn.style.display="flex";}' +
            '},700);})();';
    }
    if(s.botDetect){
      js += '(function(){try{' +
        'var _bad=false;' +
        'if(navigator.webdriver){_bad=true;}' +
        'if(!_bad&&window.callPhantom){_bad=true;}' +
        'if(!_bad&&window._phantom){_bad=true;}' +
        'if(!_bad&&window.__nightmare){_bad=true;}' +
        'if(!_bad&&navigator.plugins&&navigator.plugins.length===0&&!("ontouchstart" in window)&&!navigator.userAgentData){_bad=true;}' +
        'if(_bad){window[' + strH.enc('document') + '][' + strH.enc('documentElement') + '][' + strH.enc('innerHTML') + ']="";}' +
      '}catch(e){}})();';
    }
    if(s.consoleOverride){
      js += '(function(){try{var _n=function(){};var _m=["log","warn","error","info","debug","table","dir","trace","group","groupEnd"];' +
            'for(var i=0;i<_m.length;i++){console[_m[i]]=_n;}}catch(e){}})();';
    }
    if(s.heartbeat){
      js += '(function(){var _tag=document.currentScript;setInterval(function(){' +
            'if(_tag&&!document.contains(_tag)){location.reload();}' +
            '},1000);})();';
    }
    if(s.timingDebug){
      js += '(function(){var _hit=0,_warn2;' +
            'function _ensure2(){if(!_warn2&&document.body){_warn2=document.createElement("div");' +
            '_warn2.style.cssText="display:none;position:fixed;inset:0;z-index:2147483647;background:#111;color:#999;font-family:sans-serif;align-items:center;justify-content:center;text-align:center;padding:20px;";' +
            '_warn2.textContent=' + strH.enc('এই মুহূর্তে কনটেন্ট দেখানো সম্ভব হচ্ছে না।') + ';document.body.appendChild(_warn2);}}' +
            'setInterval(function(){_ensure2();' +
            'var _t0=performance.now();debugger;var _t1=performance.now();' +
            'if((_t1-_t0)>150){_hit++;}else{_hit=0;if(_warn2)_warn2.style.display="none";}' +
            'if(_hit>=3&&_warn2){_warn2.style.display="flex";}' +
            '},1500);})();';
    }
    if(s.selfDestruct && (s.viewLimit > 0 || s.timeLimitMinutes > 0)){
      var sdId = 'kv_' + (s.watermark ? s.watermark.replace(/[^a-zA-Z0-9_\-]/g,'') : Math.random().toString(36).slice(2,10));
      js += '(function(){try{' +
            'var _id="' + sdId + '";var _vk="_kvv_"+_id;var _tk="_kvt_"+_id;' +
            'var _blocked=false;var _msg=' + strH.enc('এই কনটেন্টের সর্বোচ্চ দেখার সীমা বা সময়সীমা শেষ হয়ে গেছে।') + ';';
      if(s.viewLimit > 0){
        js += 'var _lim=' + s.viewLimit + ';var _c=parseInt(localStorage.getItem(_vk)||"0",10)+1;localStorage.setItem(_vk,String(_c));' +
              'if(_c>_lim){_blocked=true;}';
      }
      if(s.timeLimitMinutes > 0){
        js += 'var _mins=' + s.timeLimitMinutes + ';var _start=localStorage.getItem(_tk);' +
              'if(!_start){_start=String(Date.now());localStorage.setItem(_tk,_start);}' +
              'if((Date.now()-parseInt(_start,10))>(_mins*60000)){_blocked=true;}';
      }
      js += 'if(_blocked){window[' + strH.enc('document') + '][' + strH.enc('documentElement') + '][' + strH.enc('innerHTML') + ']=\'<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#999;text-align:center;padding:20px;background:#111;">\'+_msg+\'</div>\';throw new Error("kavach-limit");}' +
            '}catch(e){}})();';
    }
    return js;
  }

  function buildAccessControl(s, namer){
    const domains = (s.domainLock||'').split(',').map(x=>x.trim()).filter(Boolean);
    const expiry = s.expiryDate || '';
    const expiryMsg = (s.expiryMsg && s.expiryMsg.trim()) || 'এই কনটেন্টের মেয়াদ শেষ হয়ে গেছে।';
    let checks = '';
    if(!domains.length && !expiry) return checks;
    const strH = makeStrHelper(namer);
    checks += strH.decl;
    if(domains.length){
      const list = JSON.stringify(domains);
      checks += 'var _allowed=' + list + ';var _h=location.hostname;' +
        'var _ok=_allowed.some(function(d){d=d.trim();if(d.indexOf("*.")===0){return _h===d.slice(2)||_h.endsWith("."+d.slice(2));}return _h===d;});' +
        'if(!_ok){window[' + strH.enc('document') + '][' + strH.enc('write') + ']("<p style=\\"font-family:sans-serif;padding:40px;color:#a33\\">"+' + strH.enc('এই কনটেন্ট এই ডোমেইনে দেখানোর অনুমতি নেই।') + '+"</p>");return;}';
    }
    if(expiry){
      checks += 'if(new Date()>new Date("' + expiry + 'T23:59:59")){window[' + strH.enc('document') + '][' + strH.enc('write') + ']("<p style=\\"font-family:sans-serif;padding:40px;color:#a33\\">"+' + strH.enc(expiryMsg) + '+"</p>");return;}';
    }
    return checks;
  }

  // ---------- polymorphic decode script builder ----------
  async function buildDecodeScript(payloadHtml, opts, namer){
    const order = opts.order;

    let processed = toBytes(payloadHtml);
    for(const op of order){
      if(op === 'rotate') processed = rotEncode(processed, opts.rotate.shift);
      else if(op === 'xor'){ for(const k of opts.xor.keys) processed = xorEncode(processed, k); }
      else if(op === 'reverse') processed = processed.split('').reverse().join('');
    }

    let b64, aesIvB64 = null, aesKeyB64 = null;
    if(opts.aesGcm){
      const key = await crypto.subtle.generateKey({name:'AES-GCM', length:256}, true, ['encrypt','decrypt']);
      const rawKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', key));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plainBytes = new Uint8Array(processed.length);
      for(let i=0;i<processed.length;i++) plainBytes[i] = processed.charCodeAt(i);
      const ctBuf = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, plainBytes);
      const ctBytes = new Uint8Array(ctBuf);
      let ctByteStr = '';
      for(let i=0;i<ctBytes.length;i++) ctByteStr += String.fromCharCode(ctBytes[i]);
      b64 = b64encode(ctByteStr);
      let ivByteStr = ''; for(let i=0;i<iv.length;i++) ivByteStr += String.fromCharCode(iv[i]);
      let keyByteStr = ''; for(let i=0;i<rawKeyBytes.length;i++) keyByteStr += String.fromCharCode(rawKeyBytes[i]);
      aesIvB64 = b64encode(ivByteStr);
      aesKeyB64 = b64encode(keyByteStr);
    } else {
      b64 = b64encode(processed);
    }

    let storageDecl = '', reconstructDecl = '', b64VarExpr;
    if(opts.chunk.enabled){
      const parts = splitChunks(b64, opts.chunk.n);
      const k = parts.length;
      const perm = shuffleIdx(k);
      const invperm = new Array(k);
      perm.forEach((origIdx, pos) => { invperm[origIdx] = pos; });
      const storedArr = perm.map(origIdx => parts[origIdx]);
      const arrName = namer(), ordName = namer(), joinedName = namer();
      storageDecl = 'var ' + arrName + '=' + JSON.stringify(storedArr) + ';var ' + ordName + '=' + JSON.stringify(invperm) + ';';
      reconstructDecl = 'var ' + joinedName + '=' + ordName + '.map(function(_q){return ' + arrName + '[_q];}).join("");';
      b64VarExpr = joinedName;
    } else {
      const bName = namer();
      storageDecl = 'var ' + bName + '=' + JSON.stringify(b64) + ';';
      b64VarExpr = bName;
    }

    let apiHelperDecl = '';
    let atobExpr, docExpr, openExpr, writeExpr, closeExpr;
    if(opts.apiObf.enabled){
      const helperName = namer();
      const shift = randInt(5, 220);
      apiHelperDecl = 'function ' + helperName + '(a){var s="";for(var i=0;i<a.length;i++){s+=String.fromCharCode(a[i]-' + shift + ');}return s;}';
      atobExpr = 'window[' + shiftedCodesExpr('atob', shift, helperName) + ']';
      docExpr = 'window[' + shiftedCodesExpr('document', shift, helperName) + ']';
      openExpr = shiftedCodesExpr('open', shift, helperName);
      writeExpr = shiftedCodesExpr('write', shift, helperName);
      closeExpr = shiftedCodesExpr('close', shift, helperName);
    } else {
      atobExpr = 'atob'; docExpr = 'document';
    }

    const pVar = namer();
    let body = opts.aesGcm ? '' : ('var ' + pVar + '=' + atobExpr + '(' + b64VarExpr + ');');

    const needsWasm = opts.wasmCore && (order.includes('xor') || order.includes('rotate'));
    if(needsWasm){
      const wxorExport = namer(), wrotExport = namer();
      const extraNop1 = randInt(0, 6), extraNop2 = randInt(0, 6);
      const junkLen = randInt(6, 48);
      const junkBytes = new Array(junkLen);
      for(let i=0;i<junkLen;i++) junkBytes[i] = randInt(0, 255);
      const modBytes = buildKavachWasmModule(wxorExport, wrotExport, extraNop1, extraNop2, junkBytes);
      const modB64 = bytesToBase64(modBytes);

      const wb64Name = namer(), wbinName = namer(), wbytesName = namer(), wiName = namer();
      const wmodName = namer(), winstName = namer(), wmemName = namer();
      const wxorName = namer(), wrotName = namer();
      const jsxFnName = namer(), jsrFnName = namer();
      opts._wxorName = wxorName;
      opts._wrotName = wrotName;

      body += 'function ' + jsxFnName + '(s,k){var a=new Array(s.length);for(var i=0;i<s.length;i++){a[i]=String.fromCharCode(s.charCodeAt(i)^k.charCodeAt(i%k.length));}return a.join("");}';
      body += 'function ' + jsrFnName + '(s,sh){return s.split("").map(function(_c){return String.fromCharCode(((_c.charCodeAt(0)-sh)%256+256)%256);}).join("");}';
      body += 'var ' + wxorName + '=' + jsxFnName + ';var ' + wrotName + '=' + jsrFnName + ';';
      body += 'try{' +
        'var ' + wb64Name + '="' + modB64 + '";' +
        'var ' + wbinName + '=atob(' + wb64Name + ');' +
        'var ' + wbytesName + '=new Uint8Array(' + wbinName + '.length);' +
        'for(var ' + wiName + '=0;' + wiName + '<' + wbinName + '.length;' + wiName + '++){' + wbytesName + '[' + wiName + ']=' + wbinName + '.charCodeAt(' + wiName + ');}' +
        'var ' + wmodName + '=new WebAssembly.Module(' + wbytesName + '.buffer);' +
        'var ' + winstName + '=new WebAssembly.Instance(' + wmodName + ');' +
        'var ' + wmemName + '=' + winstName + '.exports.memory;' +
        wxorName + '=function(bs,ks){' +
          'var inPtr=0,keyPtr=bs.length+64,outPtr=keyPtr+ks.length+64,need=outPtr+bs.length+64;' +
          'var curB=' + wmemName + '.buffer.byteLength;' +
          'if(need>curB){' + wmemName + '.grow(Math.ceil((need-curB)/65536));}' +
          'var m=new Uint8Array(' + wmemName + '.buffer);' +
          'for(var i=0;i<bs.length;i++)m[inPtr+i]=bs.charCodeAt(i);' +
          'for(var i=0;i<ks.length;i++)m[keyPtr+i]=ks.charCodeAt(i);' +
          winstName + '.exports["' + wxorExport + '"](inPtr,bs.length,keyPtr,ks.length,outPtr);' +
          'var o=new Array(bs.length);for(var i=0;i<bs.length;i++)o[i]=String.fromCharCode(m[outPtr+i]);' +
          'return o.join("");' +
        '};' +
        wrotName + '=function(bs,sh){' +
          'var inPtr=0,outPtr=bs.length+64,need=outPtr+bs.length+64;' +
          'var curB2=' + wmemName + '.buffer.byteLength;' +
          'if(need>curB2){' + wmemName + '.grow(Math.ceil((need-curB2)/65536));}' +
          'var m2=new Uint8Array(' + wmemName + '.buffer);' +
          'for(var i=0;i<bs.length;i++)m2[inPtr+i]=bs.charCodeAt(i);' +
          winstName + '.exports["' + wrotExport + '"](inPtr,bs.length,((sh%256)+256)%256,outPtr);' +
          'var o2=new Array(bs.length);for(var i=0;i<bs.length;i++)o2[i]=String.fromCharCode(m2[outPtr+i]);' +
          'return o2.join("");' +
        '};' +
      '}catch(_wErr){}';
    }

    for(const op of order.slice().reverse()){
      if(op === 'reverse'){
        body += pVar + '=' + pVar + '.split("").reverse().join("");';
      } else if(op === 'xor'){
        const iName = namer();
        let xFnName;
        if(needsWasm){
          xFnName = opts._wxorName;
        } else {
          xFnName = namer();
          body += 'function ' + xFnName + '(s,k){var a=new Array(s.length);for(var i=0;i<s.length;i++){a[i]=String.fromCharCode(s.charCodeAt(i)^k.charCodeAt(i%k.length));}return a.join("");}';
        }
        let ksName;
        if(opts.keyObfuscate){
          const kShift = randInt(3, 90);
          const kCodesName = namer(), kDecName = namer();
          const keyCodes = opts.xor.keys.map(k => k.split('').map(c => c.charCodeAt(0) + kShift));
          body += 'var ' + kCodesName + '=' + JSON.stringify(keyCodes) + ';';
          body += 'var ' + kDecName + '=' + kCodesName + '.map(function(_a){return _a.map(function(_c){return String.fromCharCode(_c-' + kShift + ');}).join("");});';
          ksName = kDecName;
        } else {
          ksName = namer();
          body += 'var ' + ksName + '=' + JSON.stringify(opts.xor.keys) + ';';
        }
        body += 'for(var ' + iName + '=0;' + iName + '<' + ksName + '.length;' + iName + '++){' + pVar + '=' + xFnName + '(' + pVar + ',' + ksName + '[' + iName + ']);}';
      } else if(op === 'rotate'){
        const rotShiftNorm = ((opts.rotate.shift % 256) + 256) % 256;
        if(needsWasm){
          body += pVar + '=' + opts._wrotName + '(' + pVar + ',' + rotShiftNorm + ');';
        } else {
          body += pVar + '=' + pVar + '.split("").map(function(_c){return String.fromCharCode(((_c.charCodeAt(0)-' + rotShiftNorm + ')%256+256)%256);}).join("");';
        }
      }
    }

    body += pVar + '=decodeURIComponent(escape(' + pVar + '));';
    body += opts.access;

    if(opts.apiObf.enabled){
      body += docExpr + '[' + openExpr + ']();' + docExpr + '[' + writeExpr + '](' + pVar + ');' + docExpr + '[' + closeExpr + ']();';
    } else {
      body += 'document.open();document.write(' + pVar + ');document.close();';
    }

    let junk = '';
    if(opts.junk.enabled){
      for(let i=0;i<opts.junk.count;i++){
        const jn = namer();
        const choice = randInt(0,2);
        if(choice===0) junk += 'var ' + jn + '=Math.random()*' + randInt(2,999) + ';';
        else if(choice===1) junk += 'var ' + jn + '="' + randomKey(randInt(4,9)) + '".length;';
        else junk += 'var ' + jn + '=[' + randInt(1,9) + ',' + randInt(1,9) + ',' + randInt(1,9) + '];';
      }
    }

    const syncPrefix = junk + apiHelperDecl + storageDecl + reconstructDecl;
    if(!opts.aesGcm) return syncPrefix + body;

    const ctStrName = namer(), ctArrName = namer();
    const ivB64Name = namer(), ivBinName = namer(), ivArrName = namer();
    const keyB64Name = namer(), keyBinName = namer(), keyArrName = namer();
    const idxName = namer(), cryptoKeyName = namer(), ptBufName = namer(), ptArrName = namer();
    const failH = makeStrHelper(namer);
    const prelude =
      'var ' + ctStrName + '=' + atobExpr + '(' + b64VarExpr + ');' +
      'var ' + ctArrName + '=new Uint8Array(' + ctStrName + '.length);for(var ' + idxName + '=0;' + idxName + '<' + ctStrName + '.length;' + idxName + '++){' + ctArrName + '[' + idxName + ']=' + ctStrName + '.charCodeAt(' + idxName + ');}' +
      'var ' + ivB64Name + '="' + aesIvB64 + '";var ' + ivBinName + '=atob(' + ivB64Name + ');' +
      'var ' + ivArrName + '=new Uint8Array(' + ivBinName + '.length);for(' + idxName + '=0;' + idxName + '<' + ivBinName + '.length;' + idxName + '++){' + ivArrName + '[' + idxName + ']=' + ivBinName + '.charCodeAt(' + idxName + ');}' +
      'var ' + keyB64Name + '="' + aesKeyB64 + '";var ' + keyBinName + '=atob(' + keyB64Name + ');' +
      'var ' + keyArrName + '=new Uint8Array(' + keyBinName + '.length);for(' + idxName + '=0;' + idxName + '<' + keyBinName + '.length;' + idxName + '++){' + keyArrName + '[' + idxName + ']=' + keyBinName + '.charCodeAt(' + idxName + ');}' +
      failH.decl +
      'Promise.resolve().then(function(){' +
        'if(!window.crypto||!window.crypto.subtle){throw new Error("no-webcrypto");}' +
        'return window.crypto.subtle.importKey("raw",' + keyArrName + ',{name:"AES-GCM"},false,["decrypt"]);' +
      '}).then(function(' + cryptoKeyName + '){' +
        'return window.crypto.subtle.decrypt({name:"AES-GCM",iv:' + ivArrName + '},' + cryptoKeyName + ',' + ctArrName + ');' +
      '}).then(function(' + ptBufName + '){' +
        'var ' + ptArrName + '=new Uint8Array(' + ptBufName + ');' +
        'var ' + pVar + '="";for(' + idxName + '=0;' + idxName + '<' + ptArrName + '.length;' + idxName + '++){' + pVar + '+=String.fromCharCode(' + ptArrName + '[' + idxName + ']);}' +
        body +
      '}).catch(function(_aesErr){try{' +
        'window[' + failH.enc('document') + '][' + failH.enc('documentElement') + '][' + failH.enc('innerHTML') + ']=' +
        '"<div style=\\"display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#999;text-align:center;padding:20px;background:#111;\\">"+' +
        failH.enc('এই কনটেন্ট ডিক্রিপ্ট করতে সমস্যা হয়েছে। ব্রাউজারটি Web Crypto সাপোর্ট করে কিনা, এবং পেজটি https বা লোকাল সার্ভার থেকে খোলা হয়েছে কিনা যাচাই করুন।') +
        '+"</div>";' +
      '}catch(_e2){}});';
    return syncPrefix + prelude;
  }

  function getCurrentSettings(){
    return {
      minify: $('optMinify').checked,
      pack: $('optPack').checked,
      xor: $('optXor').checked,
      xorPasses: Math.max(1, Math.min(5, parseInt($('xorPasses').value,10) || 1)),
      baseHref: $('baseHref').value.trim(),
      watermark: $('watermark').value.trim(),
      rotate: $('optRotate').checked,
      rotateShiftField: $('rotateShift').value.trim(),
      reverse: $('optReverse').checked,
      chunk: $('optChunk').checked,
      chunkCount: Math.max(2, Math.min(12, parseInt($('chunkCount').value,10) || 5)),
      apiObf: $('optApiObf').checked,
      junk: $('optJunk').checked,
      junkCount: Math.max(1, Math.min(10, parseInt($('junkCount').value,10) || 3)),
      randomOrder: $('optRandomOrder').checked,
      wasmCore: $('optWasmCore').checked,
      aesGcm: $('optAesGcm').checked,
      noRightClick: $('optNoRightClick').checked,
      noDevtoolsKeys: $('optNoDevtoolsKeys').checked,
      debugTrap: $('optDebugTrap').checked,
      noSelect: $('optNoSelect').checked,
      noImgDrag: $('optNoImgDrag').checked,
      frameBust: $('optFrameBust').checked,
      consoleWarn: $('optConsoleWarn').checked,
      devToolsDetect: $('optDevToolsDetect').checked,
      consoleOverride: $('optConsoleOverride').checked,
      heartbeat: $('optHeartbeat').checked,
      botDetect: $('optBotDetect').checked,
      timingDebug: $('optTimingDebug').checked,
      keyObfuscate: $('optKeyObfuscate').checked,
      selfDestruct: $('optSelfDestruct').checked,
      viewLimit: Math.max(0, parseInt($('viewLimit').value,10) || 0),
      timeLimitMinutes: Math.max(0, parseInt($('timeLimitMinutes').value,10) || 0),
      domainLock: $('domainLock').value.trim(),
      expiryDate: $('expiryDate').value,
      expiryMsg: $('expiryMsg').value.trim()
    };
  }

  const DEV_TOP_COMMENT =
    '<!--\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    '👨\u200d💻 DEVELOPER PROFILE\n' +
    'A.K.M REDWAN\n' +
    '🇧🇩 Bangladesh | 📍 Sylhet\n' +
    '💻 Developer & Digital Creator\n' +
    '🔹 Telegram: https://t.me/Fucker_King_M\n' +
    '🔹 Website: https://ba2388814-sketch.github.io/akm-redwan.com/\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    '✨ Building • Creating • Innovating\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    'Hardened with কোড-কবচ (multi-layer client-side obfuscation).\n' +
    '-->\n';
  const DEV_BOTTOM_COMMENT =
    '\n<!-- Protected & hardened by কোড-কবচ | Developer: A.K.M Redwan | Sylhet, Bangladesh | Telegram: https://t.me/Fucker_King_M | Website: https://ba2388814-sketch.github.io/akm-redwan.com/ -->\n';

  async function protectHTML(rawHtml, s){
    if(!rawHtml || !rawHtml.trim()) return '';
    let html = rawHtml;
    if(s.minify) html = minifyHTML(html);
    html = injectBaseHref(html, s.baseHref);

    const namer = makeNamer();

    const antiJS = buildAntiFeatures(s, namer);
    if(antiJS || s.watermark){
      const inject = '<script>' + (s.watermark ? '/* kavach-id:' + s.watermark.replace(/[^a-zA-Z0-9_\-.]/g,'') + ' */' : '') + antiJS + '<\/script>';
      if(/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, inject + '</body>');
      else html += inject;
    }

    if(!s.pack) return DEV_TOP_COMMENT + html + DEV_BOTTOM_COMMENT;

    let xorKeys = [];
    if(s.xor){ for(let i=0;i<s.xorPasses;i++) xorKeys.push(randomKey(12)); }
    const rotateShift = s.rotateShiftField ? (parseInt(s.rotateShiftField,10) || 0) : randInt(1, 30000);

    let order = [];
    if(s.rotate) order.push('rotate');
    if(s.xor) order.push('xor');
    if(s.reverse) order.push('reverse');
    if(s.randomOrder) order = shuffleArr(order);

    const opts = {
      order: order,
      rotate: { enabled: s.rotate, shift: rotateShift },
      xor: { enabled: s.xor, keys: xorKeys },
      reverse: { enabled: s.reverse },
      chunk: { enabled: s.chunk, n: s.chunkCount },
      apiObf: { enabled: s.apiObf },
      junk: { enabled: s.junk, count: s.junkCount },
      keyObfuscate: s.keyObfuscate,
      wasmCore: s.wasmCore,
      aesGcm: s.aesGcm,
      access: buildAccessControl(s, namer)
    };

    const decodeScript = await buildDecodeScript(html, opts, namer);
    const errStrH = makeStrHelper(namer);
    const safeWrapped = '(function(){try{' + decodeScript + '}catch(_kvErr){try{' +
      errStrH.decl +
      'window[' + errStrH.enc('document') + '][' + errStrH.enc('documentElement') + '][' + errStrH.enc('innerHTML') + ']="<div style=\\"display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#999;text-align:center;padding:20px;background:#111;\\">"+' + errStrH.enc('এই কনটেন্ট লোড করতে সমস্যা হয়েছে। পেজ রিফ্রেশ করে আবার চেষ্টা করুন।') + '+"</div>";' +
      '}catch(_e2){}}})();';
    return DEV_TOP_COMMENT + '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>' + safeWrapped + '<\/script></body></html>' + DEV_BOTTOM_COMMENT;
  }

  function validateOutput(html){
    return new Promise((resolve) => {
      if(!html){ resolve(null); return; }
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'position:absolute;width:1px;height:1px;border:0;left:-9999px;top:-9999px;';
      ifr.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      let done = false;
      const finish = (ok) => {
        if(done) return; done = true;
        setTimeout(() => { try{ document.body.removeChild(ifr); }catch(e){} }, 100);
        resolve(ok);
      };
      ifr.onload = () => { setTimeout(() => finish(true), 60); };
      ifr.onerror = () => finish(false);
      document.body.appendChild(ifr);
      const timer = setTimeout(() => finish('timeout'), 3000);
      try{
        ifr.srcdoc = html;
      }catch(e){ clearTimeout(timer); finish(false); }
    });
  }

  function setValidateStat(state){
    validateStat.classList.remove('ok','bad','pending');
    if(state === null){ validateStat.textContent=''; return; }
    if(state === 'timeout'){ validateStat.textContent='⏳ যাচাই অনিশ্চিত'; validateStat.classList.add('pending'); return; }
    if(state){ validateStat.textContent='✅ ভ্যালিডেটেড'; validateStat.classList.add('ok'); }
    else { validateStat.textContent='⚠️ লোড এরর হতে পারে'; validateStat.classList.add('bad'); }
  }

  function pushHistory(inB, outB, settingsSummary, outputText){
    historyStore.unshift({ time: new Date(), inB, outB, settingsSummary, outputText });
    if(historyStore.length > 5) historyStore.pop();
    renderHistory();
  }
  function renderHistory(){
    const list = $('historyList');
    if(!historyStore.length){
      list.innerHTML = '<div class="history-empty" id="historyEmpty">এখনো কোনো রান হয়নি।</div>';
      return;
    }
    list.innerHTML = '';
    historyStore.forEach((h, idx) => {
      const row = document.createElement('div');
      row.className = 'history-item';
      const timeStr = h.time.toLocaleTimeString('bn-BD', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
      row.innerHTML = '<span class="meta">' + timeStr + ' · ' + fmt(h.inB) + ' → ' + fmt(h.outB) + ' · ' + h.settingsSummary + '</span>';
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'আউটপুটে লোড করুন';
      btn.addEventListener('click', () => {
        output.value = h.outputText;
        outStat.textContent = fmt(bytes(h.outputText));
        $('btnCopy').disabled = false; $('btnDownload').disabled = false; $('btnPreview').disabled = false;
        $('btnDownloadZip').disabled = !window.JSZip;
        setValidateStat(null);
      });
      row.appendChild(btn);
      list.appendChild(row);
    });
  }

  function settingsSummary(s){
    const bits = [];
    if(s.minify) bits.push('মিনিফাই');
    if(s.pack) bits.push('প্যাক');
    if(s.xor) bits.push('XOR');
    if(s.rotate) bits.push('রোটেট');
    if(s.reverse) bits.push('রিভার্স');
    if(s.chunk) bits.push('চাংক');
    if(s.apiObf) bits.push('API-অস্পষ্ট');
    if(s.devToolsDetect) bits.push('DevTools-ডিটেক্ট');
    if(s.consoleOverride) bits.push('কনসোল-বন্ধ');
    if(s.heartbeat) bits.push('হার্টবিট');
    if(s.timingDebug) bits.push('টাইমিং-ডিটেক্ট');
    if(s.keyObfuscate) bits.push('কী-অস্পষ্ট');
    if(s.wasmCore) bits.push('WASM-কোর');
    if(s.aesGcm) bits.push('AES-GCM');
    if(s.botDetect) bits.push('বট-ব্লক');
    if(s.selfDestruct) bits.push('সেলফ-ডিস্ট্রাক্ট');
    return bits.join('+') || 'শুধু-HTML';
  }

  const PRESETS = {
    extreme: {
      minify:true, pack:true, xor:true, xorPasses:5, rotate:true, reverse:true,
      chunk:true, chunkCount:12, apiObf:true, junk:true, junkCount:10, randomOrder:true,
      noRightClick:true, noDevtoolsKeys:true, debugTrap:true, noSelect:true, noImgDrag:true, frameBust:true, consoleWarn:true,
      devToolsDetect:true, consoleOverride:true, heartbeat:true, timingDebug:true, keyObfuscate:true, selfDestruct:false, wasmCore:true, aesGcm:true, botDetect:true
    },
    balanced: {
      minify:true, pack:true, xor:false, xorPasses:1, rotate:true, reverse:true,
      chunk:true, chunkCount:5, apiObf:true, junk:true, junkCount:3, randomOrder:true,
      noRightClick:false, noDevtoolsKeys:false, debugTrap:false, noSelect:false, noImgDrag:false, frameBust:false, consoleWarn:false,
      devToolsDetect:false, consoleOverride:false, heartbeat:false, timingDebug:false, keyObfuscate:true, selfDestruct:false, wasmCore:false, aesGcm:false, botDetect:false
    },
    high: {
      minify:true, pack:true, xor:true, xorPasses:2, rotate:true, reverse:true,
      chunk:true, chunkCount:7, apiObf:true, junk:true, junkCount:5, randomOrder:true,
      noRightClick:true, noDevtoolsKeys:true, debugTrap:false, noSelect:true, noImgDrag:true, frameBust:true, consoleWarn:true,
      devToolsDetect:true, consoleOverride:true, heartbeat:true, timingDebug:true, keyObfuscate:true, selfDestruct:false, wasmCore:true, aesGcm:false, botDetect:true
    },
    light: {
      minify:true, pack:true, xor:false, xorPasses:1, rotate:false, reverse:false,
      chunk:false, chunkCount:5, apiObf:false, junk:false, junkCount:3, randomOrder:false,
      noRightClick:false, noDevtoolsKeys:false, debugTrap:false, noSelect:false, noImgDrag:false, frameBust:false, consoleWarn:false,
      devToolsDetect:false, consoleOverride:false, heartbeat:false, timingDebug:false, keyObfuscate:true, selfDestruct:false, wasmCore:false, aesGcm:false, botDetect:false
    },
    minifyonly: {
      minify:true, pack:false, xor:false, xorPasses:1, rotate:false, reverse:false,
      chunk:false, chunkCount:5, apiObf:false, junk:false, junkCount:3, randomOrder:false,
      noRightClick:false, noDevtoolsKeys:false, debugTrap:false, noSelect:false, noImgDrag:false, frameBust:false, consoleWarn:false,
      devToolsDetect:false, consoleOverride:false, heartbeat:false, timingDebug:false, keyObfuscate:true, selfDestruct:false, wasmCore:false, aesGcm:false, botDetect:false
    }
  };
  function applyPreset(name){
    const p = PRESETS[name];
    if(!p) return;
    $('optMinify').checked = p.minify;
    $('optPack').checked = p.pack;
    $('optXor').checked = p.xor;
    $('xorPasses').value = p.xorPasses;
    $('optRotate').checked = p.rotate;
    $('optReverse').checked = p.reverse;
    $('optChunk').checked = p.chunk;
    $('chunkCount').value = p.chunkCount;
    $('optApiObf').checked = p.apiObf;
    $('optJunk').checked = p.junk;
    $('junkCount').value = p.junkCount;
    $('optRandomOrder').checked = p.randomOrder;
    $('optWasmCore').checked = p.wasmCore;
    $('optAesGcm').checked = p.aesGcm;
    $('optBotDetect').checked = p.botDetect;
    $('optNoRightClick').checked = p.noRightClick;
    $('optNoDevtoolsKeys').checked = p.noDevtoolsKeys;
    $('optDebugTrap').checked = p.debugTrap;
    $('optNoSelect').checked = p.noSelect;
    $('optNoImgDrag').checked = p.noImgDrag;
    $('optFrameBust').checked = p.frameBust;
    $('optConsoleWarn').checked = p.consoleWarn;
    $('optDevToolsDetect').checked = p.devToolsDetect;
    $('optConsoleOverride').checked = p.consoleOverride;
    $('optHeartbeat').checked = p.heartbeat;
    $('optTimingDebug').checked = p.timingDebug;
    $('optKeyObfuscate').checked = p.keyObfuscate;
    $('optSelfDestruct').checked = p.selfDestruct;
  }
  $('btnApplyPreset').addEventListener('click', () => applyPreset($('presetSelect').value));

  async function protect(){
    const s = getCurrentSettings();
    const btn = $('btnRun');
    btn.disabled = true;
    const finalOut = await protectHTML(input.value, s);
    btn.disabled = false;

    if(!finalOut){
      output.value = '';
      outStat.textContent = '—';
      savings.textContent = '';
      setValidateStat(null);
      $('btnCopy').disabled = true; $('btnDownload').disabled = true; $('btnPreview').disabled = true; $('btnDownloadZip').disabled = true;
      return;
    }

    output.value = finalOut;
    const inB = bytes(input.value), outB = bytes(finalOut);
    outStat.textContent = fmt(outB);
    const diffPct = inB ? Math.round((1 - outB/inB) * 100) : 0;
    let sizeWarn = '';
    if(outB > SIZE_WARN_BYTES) sizeWarn = '  ·  <span class="warn">⚠ আউটপুট ' + fmt(outB) + ' — মোবাইল ওয়েবভিউতে লোড ধীর হতে পারে</span>';
    savings.innerHTML = 'ইনপুট <b>' + fmt(inB) + '</b> → আউটপুট <b>' + fmt(outB) + '</b>' +
      (diffPct > 0 ? '  ·  আকার <b>' + diffPct + '%</b> কমেছে' : (diffPct < 0 ? '  ·  মাল্টি-লেয়ার এনকোডিং-এর কারণে আকার বেড়েছে (স্বাভাবিক)' : '')) + sizeWarn;

    $('btnCopy').disabled = false; $('btnDownload').disabled = false; $('btnPreview').disabled = false;
    $('btnDownloadZip').disabled = !window.JSZip;

    setValidateStat('pending');
    validateOutput(finalOut).then(setValidateStat);

    pushHistory(inB, outB, settingsSummary(s), finalOut);
  }

  $('btnRun').addEventListener('click', protect);
  document.addEventListener('keydown', (e) => {
    if((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); protect(); }
  });

  $('btnCopy').addEventListener('click', async () => {
    try{
      await navigator.clipboard.writeText(output.value);
      const b = $('btnCopy'); const old = b.textContent;
      b.textContent = 'কপি হয়েছে ✓';
      setTimeout(()=> b.textContent = old, 1400);
    }catch(e){
      output.select(); document.execCommand('copy');
    }
  });

  $('btnDownload').addEventListener('click', async () => {
    const b = $('btnDownload'); b.disabled = true;
    await saveFile('protected.html', output.value, 'text/html');
    b.disabled = false;
  });

  // ---------------------------------------------------------------
  // Split a single protected HTML output into a project structure:
  //   index.html   — markup + <link>/<script src> references only
  //   css/secure.css — every <style> block pulled out (concatenated)
  //   js/secure.js   — every inline <script> block pulled out (concatenated,
  //                    skipping any <script src="..."> which stay as-is)
  // This mirrors the same index.html/css/js layout this admin tool itself uses.
  // ---------------------------------------------------------------
  function splitIntoProject(html){
    let cssParts = [];
    let jsParts = [];
    let working = html;

    // pull inline <style>...</style> blocks out to css/secure.css
    working = working.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, function(_, body){
      cssParts.push(body);
      return '<link rel="stylesheet" href="css/secure.css">';
    });

    // pull inline <script>...</script> blocks (no src attr) out to js/secure.js,
    // leave <script src="..."> tags (e.g. CDN libs) untouched in place
    working = working.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, function(m, attrs, body){
      if(/\bsrc\s*=/.test(attrs)) return m; // external script — keep as-is
      if(!body.trim()) return '';
      jsParts.push(body);
      return '';
    });

    // add a single reference to the combined js file, right before </body>
    const jsTag = '<script src="js/secure.js"><\/script>';
    if(/<\/body>/i.test(working)) working = working.replace(/<\/body>/i, jsTag + '</body>');
    else working += jsTag;

    return {
      indexHtml: working,
      css: cssParts.join('\n\n').trim(),
      js: jsParts.join('\n\n').trim()
    };
  }

  async function buildProjectZip(zip, folderName, protectedHtml){
    const proj = splitIntoProject(protectedHtml);
    const root = folderName ? zip.folder(folderName) : zip;
    root.file('index.html', proj.indexHtml || '<!-- no markup left after extraction -->');
    root.folder('css').file('secure.css', proj.css || '/* no inline styles in this output */');
    root.folder('js').file('secure.js', proj.js || '// no inline scripts in this output');
  }

  $('btnDownloadZip').addEventListener('click', async () => {
    if(!window.JSZip){ alert('JSZip লোড হয়নি — ইন্টারনেট সংযোগ যাচাই করুন।'); return; }
    if(!output.value) return;
    const b = $('btnDownloadZip'); b.disabled = true;
    try{
      const zip = new JSZip();
      await buildProjectZip(zip, null, output.value);
      const blob = await zip.generateAsync({type:'blob'});
      await saveFile('protected-project.zip', blob);
    } finally {
      b.disabled = false;
    }
  });

  $('btnPreview').addEventListener('click', () => {
    if(!output.value) return;
    if(lastPreviewUrl) URL.revokeObjectURL(lastPreviewUrl);
    const blob = new Blob([output.value], {type:'text/html'});
    lastPreviewUrl = URL.createObjectURL(blob);
    window.open(lastPreviewUrl, '_blank');
  });

  // ---------- batch processing ----------
  let batchFiles = [];
  $('btnBatchUpload').addEventListener('click', () => $('batchFileInput').click());
  $('batchFileInput').addEventListener('change', (e) => {
    batchFiles = Array.from(e.target.files || []);
    renderBatchList();
    $('btnBatchRun').disabled = batchFiles.length === 0;
  });
  function renderBatchList(){
    const list = $('batchList');
    list.innerHTML = '';
    batchFiles.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'batch-item';
      row.innerHTML = '<span>' + f.name + ' (' + fmt(f.size) + ')</span><span class="status pending">অপেক্ষমাণ</span>';
      row.dataset.name = f.name;
      list.appendChild(row);
    });
  }
  function setBatchRowStatus(name, text, cls){
    const rows = document.querySelectorAll('#batchList .batch-item');
    rows.forEach(r => {
      if(r.dataset.name === name){
        const st = r.querySelector('.status');
        st.textContent = text;
        st.className = 'status ' + cls;
      }
    });
  }

  function readFileAsText(file){
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = ev => resolve(ev.target.result);
      r.onerror = reject;
      r.readAsText(file);
    });
  }

  $('btnBatchRun').addEventListener('click', async () => {
    if(!window.JSZip){ alert('JSZip লোড হয়নি — ইন্টারনেট সংযোগ যাচাই করুন।'); return; }
    if(!batchFiles.length) return;
    const btn = $('btnBatchRun');
    btn.disabled = true;
    $('batchStatus').textContent = 'প্রসেসিং হচ্ছে...';
    const zip = new JSZip();
    const s = getCurrentSettings();

    for(const f of batchFiles){
      setBatchRowStatus(f.name, 'প্রসেসিং...', 'pending');
      try{
        const text = await readFileAsText(f);
        const out = await protectHTML(text, s);
        const baseName = f.name.replace(/\.html?$/i, '');
        // each source file becomes its own project folder: <name>/index.html + css/secure.css + js/secure.js
        await buildProjectZip(zip, baseName, out);
        setBatchRowStatus(f.name, '✅ ' + fmt(bytes(text)) + ' → ' + fmt(bytes(out)), 'ok');
      }catch(err){
        setBatchRowStatus(f.name, '❌ এরর', 'bad');
      }
    }

    $('batchStatus').textContent = 'ZIP তৈরি হচ্ছে...';
    const blob = await zip.generateAsync({type:'blob'});
    await saveFile('protected-batch.zip', blob);
    $('batchStatus').textContent = 'সম্পন্ন — ZIP ডাউনলোড হয়েছে।';
    btn.disabled = false;
  });

})();
