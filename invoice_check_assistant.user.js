// ==UserScript==
// @name         发票查验助手（PDF电子发票解析工具配套）
// @namespace    pdf-qr-tool
// @version      2.5.0
// @description  配合「PDF电子发票解析工具」：自动读取 URL #qr 参数，填写发票查验平台的发票号码、价税合计，并模拟日历点选填写开票日期；填完后光标自动落在验证码输入框，人工仅需输入验证码后点击查验；查验结果出现后悬浮"一键截图"与"一键多页截图"按钮：截图保存弹窗 PNG（含水印）；多页截图劫持原生打印的重排版引擎（明细全展开），按 A4 纵向 300DPI 分页输出 PNG，多页带页码后缀。
// @author       TeleAgent
// @match        https://inv-veri.chinatax.gov.cn/fpcygzfw/national-invoice-check*
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  /* ---------- 参数解析：#qr=发票号码|YYYY-MM-DD|价税合计|发票代码 ---------- */
  function parseQR(){
    const m = location.hash.match(/#qr=([^&]*)/);
    if(!m) return null;
    try{
      const parts = decodeURIComponent(m[1]).split('|');
      if(!parts[0]) return null;
      return { number: parts[0]||'', date: parts[1]||'', amount: parts[2]||'', code: parts[3]||'' };
    }catch(e){ return null; }
  }

  /* ---------- 合成鼠标事件（TDesign 组件需要完整按下-抬起-点击序列） ---------- */
  function synthClick(el){
    if(!el) return;
    const o = { bubbles:true, cancelable:true, view:window };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup',   o));
    el.dispatchEvent(new MouseEvent('click',     o));
  }

  /* ---------- 原生 setter + 事件：用于普通文本框 ---------- */
  function setNativeValue(input, value){
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if(desc && desc.set){ desc.set.call(input, value); }
    else { input.value = value; }
    input.dispatchEvent(new Event('input',  { bubbles:true }));
    input.dispatchEvent(new Event('change', { bubbles:true }));
    input.dispatchEvent(new Event('blur',   { bubbles:true }));
  }

  /* ---------- 按 label 文本定位输入框 ----------
     金额字段标签是动态的：未填号码时为"开具金额(不含税)"，
     填入 20 位数电票号码后变为"价税合计"，故用候选词数组匹配 */
  function findInputByLabels(labelTexts){
    const inputs = document.querySelectorAll('input.t-input__inner, input[class*="t-input"]');
    for(const inp of inputs){
      let el = inp;
      for(let k=0; k<7 && el; k++){
        const prev = el.previousElementSibling;
        if(prev){
          const txt = prev.textContent ? prev.textContent.trim() : '';
          if(txt && txt.length < 30 && !prev.querySelector('input')){
            for(const lt of labelTexts){
              if(txt.indexOf(lt) > -1) return inp;
            }
            break;
          }
        }
        el = el.parentElement;
      }
    }
    return null;
  }
  function findInputByLabel(labelText){
    return findInputByLabels([labelText]);
  }
  function findDateInput(){
    return document.querySelector('input[placeholder="YYYYMMDD"]') ||
           Array.from(document.querySelectorAll('input[readonly]')).find(function(i){
             return /Y{4}MMDD/.test(i.placeholder || '');
           }) || null;
  }

  /* ---------- sleep ---------- */
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

  /* ---------- 右上角提示浮层 ---------- */
  function showToast(msg){
    try{
      const d = document.createElement('div');
      d.textContent = msg;
      d.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;'
        + 'background:#2E75B6;color:#fff;padding:10px 18px;border-radius:8px;'
        + 'font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.25);font-family:system-ui;';
      document.body.appendChild(d);
      setTimeout(function(){ d.remove(); }, 6000);
    }catch(e){}
  }

  /* ================================================================
     v2.2.0 新增：一键截图（查验结果弹窗 → PNG 保存）
     - 截图目标：弹窗内容卡片 .t-dialog__body（含官方水印 .shuiyin、查验状态行、
       票面、特别提示，及自带 padding 的四周白边；经唯一的 .invoice-dialog 向上定位，
       因页面上存在多个 .t-dialog__body）
     - 悬浮按钮挂在 document.body 上（fixed 定位），不在截图目标子树内，
       html2canvas 只克隆目标元素子树渲染，因此按钮不会入镜
     - 按钮位置：跟随原生"打印"按钮左侧（间隔 8px、同样大小、颜色略淡）
     - 保存方式：a[download] 直接触发浏览器下载，不弹窗
     - 文件名：dzfp_{发票号码}_{购买方}_{价税合计}-发票查验截图.png
       号码/金额优先取 URL #qr 参数，购买方固定从票面 DOM 提取（字面购买方），
       URL 缺失时号码/金额回退到票面文本提取
     ================================================================ */

  /* ---------- 文件名安全处理：过滤 Windows 非法字符 ---------- */
  function sanitizeFilename(s){
    return String(s || '')
      .replace(/[\\\/:*?"<>|\r\n\t]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.\s]+$/, '');
  }

  /* ---------- DOM 兜底提取：发票号码（票面"发票号码："） ---------- */
  function extractInvoiceNumber(){
    const info = document.querySelector('.invoice-info');
    if(!info) return '';
    const m = info.textContent.match(/发票号码[：:]\s*([0-9A-Za-z]{6,})/);
    return m ? m[1] : '';
  }

  /* ---------- DOM 提取：票面字面购买方 ----------
     真实结构："购买方信息"是叶子 span（外面还套了只含它的 span），
     "名称：公司名"是 <p class="invoice-main__header--name">（label 与值分离，
     但 p.textContent 拼合完整）。故从标签向上逐层找，直到出现"名称："开头的 p；
     购买方块在销售方之前（DOM 顺序），向上层数有限不会串块 */
  function extractBuyer(){
    const info = document.querySelector('.invoice-info');
    if(!info) return '';
    const label = Array.from(info.querySelectorAll('*')).find(function(el){
      return el.children.length === 0 && el.textContent.trim() === '购买方信息';
    });
    if(!label){
      /* 兜底：票面第一个"名称："段落即购买方 */
      const p1 = Array.from(info.querySelectorAll('p')).find(function(p){
        return /^名称[：:]/.test(p.textContent.trim());
      });
      return p1 ? p1.textContent.replace(/^名称[：:]\s*/, '').trim() : '';
    }
    let blk = label;
    for(let i = 0; i < 6 && blk && blk !== info; i++){
      blk = blk.parentElement;
      if(!blk) break;
      const ps = Array.from(blk.querySelectorAll('p'));
      const nameP = ps.find(function(p){ return /^名称[：:]/.test(p.textContent.trim()); });
      if(nameP){
        return nameP.textContent.replace(/^名称[：:]\s*/, '').trim();
      }
    }
    return '';
  }

  /* ---------- DOM 兜底提取：价税合计（票面"（小写）¥xxx"） ---------- */
  function extractAmount(){
    const info = document.querySelector('.invoice-info');
    if(!info) return '';
    const m = info.textContent.match(/[（(]\s*小写\s*[）)]\s*[¥￥]([0-9,\.]+)/);
    return m ? m[1].replace(/,/g, '') : '';
  }

  /* ---------- 文件名组装 ----------
     公共前缀（不含尾巴）：dzfp_{号码}_{购买方}_{金额}，两种输出共用 */
  function buildFilename(){
    return buildFilenameBase() + '-发票查验截图.png';
  }
  function buildFilenameBase(){
    const q   = parseQR() || {};
    const num   = q.number || extractInvoiceNumber();
    const amt   = q.amount || extractAmount();
    const buyer = extractBuyer();          /* 购买方固定取票面字面，不用"相关方" */
    const parts = [num, buyer, amt].map(sanitizeFilename).filter(Boolean);
    return 'dzfp_' + parts.join('_');
  }
  /* 多页 PNG：dzfp_..._发票查验截图多页{页码}.png，仅多页带页码，单页无页码 */
  function buildPageFilename(page, total){
    return buildFilenameBase() + '-发票查验截图多页' + (total > 1 ? page : '') + '.png';
  }

  /* ---------- blob 触发下载（a[download]，文件名由 download 属性指定） ---------- */
  function downloadBlob(blob, filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 5000);
  }

  /* ---------- 定位弹窗内的原生"打印"按钮 ---------- */
  function findPrintButton(){
    const box = document.querySelector('.invoice-check-status');
    if(!box) return null;
    return Array.from(box.querySelectorAll('button')).find(function(b){
      return b.textContent.indexOf('打印') > -1;
    }) || null;
  }

  /* ---------- 悬浮按钮状态（双按钮：截图 + PDF） ---------- */
  const snapBtn = { el: null, timer: null };
  const pdfBtn  = { el: null };

  /* 按钮通用样式：与原生"打印"同款大小/字号，颜色略淡（原生为 rgb(1,82,147)） */
  const BTN_STYLE =
    'position:fixed;z-index:30000;display:none;border:none;cursor:pointer;'
    + 'background:#2E75B6;color:#fff;font-size:16px;'
    + 'font-family:system-ui,"Microsoft YaHei",sans-serif;'
    + 'border-radius:3px;padding:0;line-height:normal;'
    + 'box-shadow:0 2px 8px rgba(0,0,0,.18);';

  function createButton(text, handler, fontSize){
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = BTN_STYLE + (fontSize ? 'font-size:' + fontSize + 'px;' : '');
    b.addEventListener('mouseenter', function(){ b.style.background = '#2565A0'; });
    b.addEventListener('mouseleave', function(){ b.style.background = '#2E75B6'; });
    b.addEventListener('click', handler);
    document.body.appendChild(b);
    return b;
  }

  function createSnapButton(){
    return createButton('一键截图', captureAndSave);
  }

  function createPdfButton(){
    /* 6 字按钮，字号 15px 避免溢出（宽度与"打印"同款 112px） */
    return createButton('一键多页截图', captureAndSavePages, 15);
  }

  /* 同步双按钮位置：PDF 在截图左侧，截图贴"打印"左侧（均同样大小、间隔 8px） */
  function syncSnapButton(){
    if(!snapBtn.el) return;
    const print = findPrintButton();
    if(!print || print.getBoundingClientRect().width <= 0){
      hideSnapButton();
      return;
    }
    const r = print.getBoundingClientRect();
    /* 截图按钮 */
    snapBtn.el.style.display = 'block';
    snapBtn.el.style.width  = r.width  + 'px';
    snapBtn.el.style.height = r.height + 'px';
    snapBtn.el.style.top    = r.top    + 'px';
    const leftSnap = r.left - r.width - 8;
    snapBtn.el.style.left   = Math.max(8, leftSnap) + 'px';
    /* PDF 按钮：再往左一格 */
    if(pdfBtn.el){
      pdfBtn.el.style.display = 'block';
      pdfBtn.el.style.width  = r.width  + 'px';
      pdfBtn.el.style.height = r.height + 'px';
      pdfBtn.el.style.top    = r.top    + 'px';
      const leftPdf = leftSnap - r.width - 8;
      pdfBtn.el.style.left   = Math.max(8, leftPdf) + 'px';
    }
  }

  function showSnapButton(){
    if(!snapBtn.el) snapBtn.el = createSnapButton();
    if(!pdfBtn.el)  pdfBtn.el  = createPdfButton();
    syncSnapButton();
    /* 兜底轮询：弹窗内部滚动/窗口变化时保持贴随"打印"按钮 */
    if(!snapBtn.timer){
      snapBtn.timer = setInterval(syncSnapButton, 300);
    }
  }

  function hideSnapButton(){
    if(snapBtn.el) snapBtn.el.style.display = 'none';
    if(pdfBtn.el)  pdfBtn.el.style.display  = 'none';
    if(snapBtn.timer){ clearInterval(snapBtn.timer); snapBtn.timer = null; }
  }

  /* ---------- 等待界面绘制上屏 ----------
     双 rAF 确保文字变化真正画到屏幕；后台标签页 rAF 会被节流甚至冻结，
     加 500ms 保底防卡死（前台场景 rAF 约 32ms 就先完成，保底不生效） */
  function nextPaint(){
    return Promise.race([
      new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); }),
      sleep(500)
    ]);
  }

  /* ---------- 截图主流程（两段式反馈） ----------
     点击瞬间变"已点击"→ 等两帧确保绘制上屏 → 变"截图中…"→ 截图。
     若不等两帧，html2canvas 同步克隆 DOM 阶段会阻塞主线程，
     任何文字变化都画不上屏，用户会感觉点击无响应几秒 */
  async function captureAndSave(){
    const b = snapBtn.el;
    /* 目标：弹窗内容卡片 .t-dialog__body（自带 padding 16px 20px，截图含一圈白边，宽 1158，与手动截图构图一致）。
       注意：页面存在多个 .t-dialog（含隐藏的"提示"确认框），直接 querySelector('.t-dialog__body')
       会命中第一个隐藏弹窗，故必须经由唯一的 .invoice-dialog 向上定位 */
    const anchor = document.querySelector('.invoice-dialog');
    const target = anchor ? anchor.closest('.t-dialog__body') : null;
    if(!target){ showToast('未找到发票详情区域'); return; }
    if(typeof html2canvas === 'undefined'){
      showToast('截图库未加载成功，请检查网络后刷新页面重试');
      return;
    }
    /* 第一段：立即反馈"已点击" */
    if(b){ b.textContent = '已点击'; b.disabled = true; b.style.opacity = '.7'; }
    await nextPaint();
    /* 第二段：进入截图状态（同样等绘制上屏后再开始阻塞主线程） */
    if(b){ b.textContent = '截图中…'; }
    await nextPaint();
    try{
      const canvas = await html2canvas(target, {
        backgroundColor : '#ffffff',   /* 弹窗底透明，垫白底（含四周白边） */
        scale           : 1,            /* 1:1 自然尺寸，与手动截图工具在 100% 缩放下像素一致，PNG 约 270KB */
        useCORS         : true,
        logging         : false
      });
      const blob = await new Promise(function(res){ canvas.toBlob(res, 'image/png'); });
      if(!blob) throw new Error('画布导出 PNG 失败');
      const name = buildFilename();
      downloadBlob(blob, name);
      showToast('截图已保存：' + name);
    }catch(e){
      showToast('截图失败：' + (e && e.message ? e.message : '未知错误'));
    }finally{
      if(b){ b.textContent = '一键截图'; b.disabled = false; b.style.opacity = '1'; }
    }
  }

  /* ================================================================
     v2.3.0 新增 / v2.4.0 改造：一键多页截图（劫持原生打印重排版 → A4 PNG）
     链路：原型劫持 iframe.contentWindow → 点击原生"打印"按钮 → print-js
     在隐藏 iframe 里重排版（明细全展开、无滚动裁剪）→ 在它调 print() 弹框前
     截获重排版 HTML → 离屏 iframe → 逐页 html2canvas 渲染（A4@300DPI）→
     垫入完整 A4 画布 + 写入 300DPI 元数据 → 逐页下载 PNG
     注：print-js 复制的重排版无官方水印（与浏览器"另存为PDF"一致）；
     若 execCommand('print') 被拦后 print-js 会走 contentWindow.print() 兜底，
     两路均已埋点，系统打印框不会弹出
     ================================================================ */

  /* ---------- 原型劫持 + 预埋：捕获 print-js 重排版 HTML ----------
     print-js 两种行为都要覆盖：
     ① 删除重建 printJS iframe（新 iframe 首次读 contentWindow 走原型 getter → 自动埋点）
     ② 复用旧 iframe（print-js 缓存了 window 引用不再走 getter）→
        需主动预埋：点打印前先把埋点写进现有 iframe 的 execCommand/print */
  function hijackForCapture(onCaptured){
    const proto = HTMLIFrameElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'contentWindow');
    const state = { html: null, done: false };
    const restore = function(){
      try { Object.defineProperty(proto, 'contentWindow', desc); } catch(e) {}
    };

    const instrument = function(iframe){
      if(!iframe || iframe.id !== 'printJS' || iframe.__pdfHooked) return;
      iframe.__pdfHooked = true;
      const d = (function(){ try { return iframe.contentDocument || iframe.contentWindow.document; } catch(e){ return null; } })();
      if(!d) return;
      const grab = function(){
        if(state.html || state.done) return true;
        if(!d.documentElement || !d.body) return false;
        if(!d.body.textContent || d.body.textContent.indexOf('发票号码') === -1) return false;  /* 未写入完整 */
        state.html = d.documentElement.outerHTML;
        state.done = true;
        restore();
        onCaptured(state.html);
        return true;
      };
      if(d.execCommand){
        const oe = d.execCommand.bind(d);
        d.execCommand = function(cmd){
          if(cmd === 'print' && grab()) return true;
          return oe.apply(d, arguments);
        };
      }
      try {
        const cw = iframe.contentWindow;
        if(cw && cw.print) cw.print = function(){ grab(); };
      } catch(e) {}
    };

    /* 预埋①：已存在的 printJS iframe（复用场景） */
    instrument(document.getElementById('printJS'));
    /* 预埋②：新建场景走原型 getter */
    try {
      Object.defineProperty(proto, 'contentWindow', {
        configurable: true,
        get: function(){
          const cw = desc.get.call(this);
          if(cw && this.id === 'printJS' && !state.done) instrument(this);
          return cw;
        }
      });
    } catch(e) { restore(); }
    return restore;
  }

  /* ================================================================
     v2.4.0 新增 / v2.4.1 调整：一键多页截图（劫持原生打印重排版 → A4 分页 PNG）
     v2.4.1：150DPI（1240×1754，体积/速度较 300DPI 减 3/4）、末页按实际内容
     高度不补满、文件名后缀改为 -发票查验截图多页{页码}.png
     画布：A4@150DPI = 1240×1754px，四边 50px 白边（=24pt，与打印边距一致）
     PNG 内嵌 pHYs 元数据（150DPI），打印时按 A4 物理尺寸解释
     ================================================================ */

  /* ---------- CRC32（PNG chunk 计算） ---------- */
  function crc32(bytes){
    let table = crc32._table;
    if(!table){
      table = crc32._table = new Uint32Array(256);
      for(let n = 0; n < 256; n++){
        let c = n;
        for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for(let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------- PNG 写入 300DPI 元数据（pHYs chunk） ----------
     canvas.toBlob 不写 DPI 信息，看图/打印软件默认按 96DPI 解释导致纸张偏大；
     在 IHDR 后插入 pHYs chunk（300DPI = 11811 像素/米），打印时即按 A4 物理尺寸 */
  function setPngDpi(arrayBuffer, dpi){
    try{
      const src = new Uint8Array(arrayBuffer);
      if(src.length < 33 || src[0] !== 0x89 || src[1] !== 0x50) return arrayBuffer;
      const ppm = Math.round(dpi / 0.0254);
      const chunk = new Uint8Array(21);            /* 4len+4type+9data+4crc */
      const dv = new DataView(chunk.buffer);
      dv.setUint32(0, 9);
      chunk[4]=0x70; chunk[5]=0x48; chunk[6]=0x59; chunk[7]=0x73;   /* 'pHYs' */
      dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;   /* 单位：米 */
      dv.setUint32(17, crc32(chunk.subarray(4, 17)));
      const out = new Uint8Array(src.length + 21);
      out.set(src.subarray(0, 33), 0);             /* 签名8 + IHDR(25) */
      out.set(chunk, 33);
      out.set(src.subarray(33), 54);
      return out.buffer;
    }catch(e){ return arrayBuffer; }
  }

  /* ---------- 多页截图主流程（两段式反馈 + 逐页进度） ---------- */
  async function captureAndSavePages(){
    const b = pdfBtn.el;
    const btn = findPrintButton();
    if(!btn){ showToast('未找到打印按钮'); return; }
    if(typeof html2canvas === 'undefined'){
      showToast('截图库未加载成功，请检查网络后刷新重试');
      return;
    }
    /* 第一段：立即反馈 */
    if(b){ b.textContent = '已点击'; b.disabled = true; b.style.opacity = '.7'; }
    await nextPaint();
    /* 第二段：生成中（print-js 写入内容需数秒） */
    if(b){ b.textContent = '生成中…'; }
    await nextPaint();
    let holder = null;
    try{
      /* 1. 捕获 print-js 重排版 HTML
         预检：若 printJS iframe 里已有当前票的完整重排版（用户点过打印/上次生成留下），
         直接复用（0 秒）；否则点击"打印"按钮触发重排版并劫持捕获。
         注：长票重排版 HTML 达 55MB 级，print-js 同步写入阻塞主线程可达 30~90 秒，
         超时须放宽到 120 秒 */
      const q0 = parseQR() || {};
      const curNum = q0.number || extractInvoiceNumber();
      let html = null;
      const pre = document.getElementById('printJS');
      if(pre){
        try{
          const pd = pre.contentDocument || pre.contentWindow.document;
          if(pd && pd.body && pd.body.textContent && pd.body.textContent.indexOf(curNum) > -1
             && pd.documentElement.outerHTML.length > 10000){
            html = pd.documentElement.outerHTML;   /* 复用现成重排版 */
          }
        }catch(e){}
      }
      if(!html){
        html = await new Promise(function(resolve, reject){
          let settled = false;
          const timer = setTimeout(function(){
            if(!settled){ settled = true; reject(new Error('重排版捕获超时（长票内容生成较慢，请重试）')); }
          }, 120000);
          const onGot = function(h){
            if(!settled){ settled = true; clearTimeout(timer); resolve(h); }
          };
          const restore = hijackForCapture(onGot);
          btn.click();
          setTimeout(function(){ if(!settled) restore(); }, 120000);
        });
      }

      /* 2. 离屏 iframe 渲染（长票 55MB 级 HTML，srcdoc 写入需几秒） */
      holder = document.createElement('iframe');
      holder.style.cssText = 'visibility:hidden;position:absolute;left:-99999px;top:0;width:1160px;height:50000px;border:0';
      document.body.appendChild(holder);
      await new Promise(function(res){ holder.onload = res; holder.srcdoc = html; });
      const hdoc = holder.contentDocument;
      const container = hdoc.querySelector('.invoice-container');
      if(!container) throw new Error('重排版内容缺失');
      const st = hdoc.createElement('style');
      st.textContent = 'html,body{margin:0;padding:0;background:#fff;} .invoice-container{margin:0;}';
      hdoc.head.appendChild(st);

      /* 3. A4@150DPI 分页参数：画布 1240×1754，四边 50px 白边 */
      const A4W = 1240, A4H = 1754, MARGIN = 50;
      const CW = A4W - MARGIN*2, CH = A4H - MARGIN*2;   /* 内容区 1140×1654 */
      const cRect = container.getBoundingClientRect();
      const scale = CW / cRect.width;                    /* ≈1.08，内容铺满页宽 */
      const srcPageH = CH / scale;                       /* 每页可容纳的内容 CSS 高度 */
      const pageCount = Math.max(1, Math.ceil(cRect.height / srcPageH));

      /* 4. 渲染策略：
         快路径——150DPI 下整图高度约 2.1 万像素，低于 Chrome 画布 32767px 上限，
         可一次渲染整图再内存切片，DOM 只克隆 1 次（逐页渲染每页克隆 57MB 文档
         各耗时约 1.7 秒，是性能瓶颈）；
         回退——万一超过画布上限（超长票），退回逐页渲染 */
      const totalPxH = Math.round(cRect.height * scale);
      let full = null;
      if(totalPxH <= 32000 && totalPxH * CW <= 260000000){
        if(b){ b.textContent = '渲染中…'; }
        full = await html2canvas(container, {
          backgroundColor : '#ffffff',
          x: 0, y: 0, width: cRect.width, height: cRect.height,
          scale: scale, useCORS: true, logging: false
        });
      }

      const names = [];
      for(let p = 0; p < pageCount; p++){
        if(b && pageCount > 1){ b.textContent = '生成中 ' + (p+1) + '/' + pageCount + '…'; }
        /* 本页内容图：来自整图切片（快路径）或逐页渲染（回退） */
        let part;
        if(full){
          const syPx = p * CH;
          const shPx = Math.min(CH, full.height - syPx);
          part = document.createElement('canvas');
          part.width = CW; part.height = Math.round(shPx);
          part.getContext('2d').drawImage(full, 0, syPx, CW, shPx, 0, 0, CW, shPx);
        }else{
          const sy = p * srcPageH;
          const sh = Math.min(srcPageH, cRect.height - sy);
          part = await html2canvas(container, {
            backgroundColor : '#ffffff',
            x: 0, y: sy, width: cRect.width, height: sh,
            scale: scale, useCORS: true, logging: false
          });
        }
        /* 5. 垫入 A4 画布：末页按实际内容高度不补满（非末页内容正好填满） */
        const page = document.createElement('canvas');
        page.width = A4W;
        page.height = Math.min(A4H, MARGIN + part.height + MARGIN);
        const ctx = page.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, A4W, page.height);
        ctx.drawImage(part, MARGIN, MARGIN);
        const blob = await new Promise(function(res){ page.toBlob(res, 'image/png'); });
        if(!blob) throw new Error('PNG 编码失败');
        /* 6. 写入 150DPI 元数据并下载 */
        const withDpi = setPngDpi(await blob.arrayBuffer(), 150);
        const name = buildPageFilename(p + 1, pageCount);
        names.push(name);
        downloadBlob(new Blob([withDpi], { type: 'image/png' }), name);
        await sleep(300);   /* 多文件下载间隔，降低浏览器拦截概率 */
      }
      if(full){ full.width = 0; full.height = 0; full = null; }   /* 及时释放大画布内存 */
      holder.remove(); holder = null;

      if(pageCount > 1){
        showToast('已保存 ' + pageCount + ' 页 PNG（' + names[0] + ' …）；若浏览器询问"下载多个文件"请选择允许');
      }else{
        showToast('PNG 已保存：' + names[0]);
      }
    }catch(e){
      showToast('多页截图失败：' + (e && e.message ? e.message : '未知错误'));
      if(holder) holder.remove();
    }finally{
      if(b){ b.textContent = '一键多页截图'; b.disabled = false; b.style.opacity = '1'; }
    }
  }

  /* ---------- 监听查验结果出现/消失（rAF 防抖） ---------- */
  let snapMoPending = false;
  const snapObserver = new MutationObserver(function(){
    if(snapMoPending) return;
    snapMoPending = true;
    requestAnimationFrame(function(){
      snapMoPending = false;
      const info = document.querySelector('.invoice-info');
      const print = findPrintButton();
      if(info && print) showSnapButton();
      else hideSnapButton();
    });
  });
  snapObserver.observe(document.body, { childList:true, subtree:true });
  window.addEventListener('resize', syncSnapButton);
  window.addEventListener('scroll',  syncSnapButton, true); /* capture：捕获弹窗内部滚动 */

  /* ================================================================
     开票日期：合成点击走日历面板（readonly DatePicker 无法直接赋值）
     流程：点日期框开面板 → 点年份选择器选年 → 点月份选择器选月 → 点日
     ================================================================ */
  async function fillDateByCalendar(dateStr){
    const ymd = (dateStr||'').replace(/[^\d]/g, '');
    if(ymd.length !== 8) return false;
    const yy = ymd.slice(0,4), mm = ymd.slice(4,6).replace(/^0/,''), dd = ymd.slice(6,8).replace(/^0/,'');

    const dateInp = findDateInput();
    if(!dateInp) return false;

    /* 1. 打开日历面板 */
    synthClick(dateInp);
    await sleep(600);

    /* 2. 选年份 */
    let yearInp = null;
    for(let t=0; t<10; t++){
      yearInp = Array.from(document.querySelectorAll('input')).find(function(i){
        return i.readOnly && /^20\d{2}$/.test(i.value);
      });
      if(yearInp) break;
      await sleep(200);
    }
    if(!yearInp) return false;
    if(yearInp.value !== yy){
      synthClick(yearInp);
      await sleep(500);
      const yearLi = Array.from(document.querySelectorAll('li')).find(function(li){
        return li.textContent.trim() === yy;
      });
      if(!yearLi) return false;
      synthClick(yearLi);
      await sleep(500);
    }

    /* 3. 选月份 */
    let monthInp = null;
    for(let t=0; t<10; t++){
      monthInp = Array.from(document.querySelectorAll('input')).find(function(i){
        return i.readOnly && /^\d{1,2}\s*月$/.test(i.value);
      });
      if(monthInp) break;
      await sleep(200);
    }
    if(!monthInp) return false;
    if(monthInp.value.replace(/\s/g,'') !== mm + '月'){
      synthClick(monthInp);
      await sleep(500);
      const monthLi = Array.from(document.querySelectorAll('li')).find(function(li){
        return li.textContent.trim().replace(/\s/g,'') === mm + '月';
      });
      if(!monthLi) return false;
      synthClick(monthLi);
      await sleep(600);
    }

    /* 4. 点日期：只点本月格子（排除 --additional 相邻月） */
    const tds = Array.from(document.querySelectorAll('table td'));
    const dayTd = tds.find(function(td){
      return td.textContent.trim() === dd
        && (td.className||'').indexOf('t-date-picker__cell') > -1
        && (td.className||'').indexOf('--additional') === -1;
    });
    if(!dayTd) return false;
    const inner = dayTd.querySelector('span, div') || dayTd;
    synthClick(dayTd);
    synthClick(inner);
    await sleep(400);
    return true;
  }

  /* ================================================================
     v2.5.0 新增：验证码框自动聚焦
     填完发票信息后光标自动落到验证码输入框，省一次鼠标点击。
     定位：主匹配沿用 label 文本方案（与号码/金额字段同构，
     该平台表单结构一致），placeholder 兜底；聚焦失败不影响
     主流程（行为同旧版）
     ================================================================ */
  function findCaptchaInput(){
    return findInputByLabels(['验证码'])
        || Array.from(document.querySelectorAll('input')).find(function(i){
             return (i.placeholder || '').indexOf('验证码') > -1;
           })
        || null;
  }
  async function focusCaptcha(){
    /* 日历面板收起、验证码图刷新都有收尾动作，轮询抢占直到焦点稳定 */
    for(let t = 0; t < 15; t++){
      const cap = findCaptchaInput();
      if(cap){
        cap.focus();
        try{
          const len = cap.value ? cap.value.length : 0;
          cap.setSelectionRange(len, len);
        }catch(e){}
        if(document.activeElement === cap) return true;
      }
      await sleep(200);
    }
    return false;
  }

  /* ================================================================
     主流程：等表单渲染 → 填号码 → 填金额 → 日历填日期 → 聚焦验证码 → 提示
     ================================================================ */
  async function main(){
    const q = parseQR();
    if(!q) return;

    /* 等表单就绪（最多 10 秒） */
    let numInp = null, amtInp = null, dateInp = null;
    for(let t=0; t<50; t++){
      numInp  = findInputByLabel('发票号码');
      amtInp  = findInputByLabels(['价税合计', '开具金额', '金额']);
      dateInp = findDateInput();
      if(numInp && amtInp && dateInp) break;
      await sleep(200);
    }
    if(!numInp || !amtInp || !dateInp){
      showToast('未找到发票输入框，请手动填写');
      return;
    }

    /* 填发票号码 */
    if(q.number) setNativeValue(numInp, q.number);
    await sleep(150);

    /* 填价税合计（填号码后标签可能已变为"价税合计"，重查一次） */
    if(q.amount){
      amtInp = findInputByLabels(['价税合计', '开具金额', '金额']) || amtInp;
      setNativeValue(amtInp, q.amount);
    }
    await sleep(150);

    /* 日历方式填开票日期 */
    let dateOk = false;
    if(q.date) dateOk = await fillDateByCalendar(q.date);

    /* 日期已自动填好才把光标切到验证码框：
       日期缺失/填失败时用户需先手动点日历补填，不抢焦点 */
    let capOk = false;
    if(dateOk) capOk = await focusCaptcha();

    showToast(dateOk
      ? (capOk
          ? '已自动填写发票信息，光标已落在验证码框，输入后点击"查验"'
          : '已自动填写发票信息，请点击验证码输入框输入，再点"查验"')
      : '号码/金额已填，日期需手动选择日历填写');
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
