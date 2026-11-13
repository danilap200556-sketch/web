/* Оформление v3: живой фон первого экрана (WebGL «жидкий шёлк» в цветах сезона или своё видео), витрина моделей
   с 3D-наклоном, счётчики, «магнитные» кнопки, подсветка за курсором и перелёт фото товара между страницами.
   Без библиотек. При prefers-reduced-motion фон рисуется одним неподвижным кадром, видео не запускается. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const css = getComputedStyle(document.documentElement);
  const hex = (name, fallback) => {
    const v = (css.getPropertyValue(name) || '').trim() || fallback;
    const m = /^#?([0-9a-f]{6})$/i.exec(v);
    const n = parseInt(m ? m[1] : fallback.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };

  /* ---------- Живой фон: WebGL-шейдер ---------- */
  const hero = $('[data-hero]');
  const canvas = $('[data-hero-gl]');
  if (hero && canvas) startShader(hero, canvas);

  function startShader(section, cv) {
    let gl;
    try { gl = cv.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false }); } catch (e) { gl = null; }
    if (!gl) return; // остаётся CSS-фон .hero__fallback
    const vs = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
    const fs = [
      'precision mediump float;',
      'uniform vec2 r;uniform float t;uniform vec2 m;uniform vec3 ca;uniform vec3 cb;uniform vec3 cc;',
      'float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
      'float n(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);',
      ' return mix(mix(h(i),h(i+vec2(1.,0.)),u.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),u.x),u.y);}',
      'float fbm(vec2 p){float v=0.,a=.5;mat2 R=mat2(.8,.6,-.6,.8);for(int i=0;i<5;i++){v+=a*n(p);p=R*p*2.03;a*=.5;}return v;}',
      'void main(){',
      ' vec2 uv=gl_FragCoord.xy/r;',
      ' vec2 p=(gl_FragCoord.xy-.5*r)/r.y*1.55;',
      ' float s=t*.045;',
      ' vec2 q=vec2(fbm(p+vec2(0.,s)),fbm(p+vec2(5.2,1.3)-s));',
      ' vec2 w=vec2(fbm(p+3.2*q+vec2(1.7,9.2)+s*1.6),fbm(p+3.2*q+vec2(8.3,2.8)-s*1.2));',
      ' float f=fbm(p+2.6*w+(m-.5)*.35);',
      ' vec3 c=vec3(.016,.016,.02);',
      ' c=mix(c,cc,smoothstep(.15,.85,length(q))*.9);',
      ' c=mix(c,ca,smoothstep(.42,.95,f)*.95);',
      ' c=mix(c,cb,smoothstep(.62,1.05,f*w.x+.25)*.6);',
      ' c+=.22*pow(smoothstep(.55,.98,f),4.);',            // блики «шёлка»
      ' float d=distance(uv,m);c+=cb*.1*exp(-d*d*9.);',     // мягкий свет за курсором
      ' c*=mix(.38,1.,smoothstep(0.,.8,uv.x));',             // слева темнее: под текстом
      ' c*=1.-.45*pow(length(uv-vec2(.62,.5)),2.);',
      ' gl_FragColor=vec4(c,1.);',
      '}',
    ].join('\n');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
    const v = sh(gl.VERTEX_SHADER, vs);
    const f = sh(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return;
    const pr = gl.createProgram();
    gl.attachShader(pr, v); gl.attachShader(pr, f); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return;
    gl.useProgram(pr);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (k) => gl.getUniformLocation(pr, k);
    const uR = U('r'), uT = U('t'), uM = U('m');
    gl.uniform3fv(U('ca'), hex('--glow-a', '#ff6a2b'));
    gl.uniform3fv(U('cb'), hex('--glow-b', '#ffb067'));
    gl.uniform3fv(U('cc'), hex('--glow-c', '#6e1f0c'));

    // Шёлк мягкий - рисуем в пониженном разрешении: это в разы легче для видеокарты и не заметно глазу.
    const scale = Math.min(window.devicePixelRatio || 1, 1.5) * 0.5;
    const size = () => {
      const w = Math.max(1, Math.round(cv.clientWidth * scale));
      const h = Math.max(1, Math.round(cv.clientHeight * scale));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); }
      gl.uniform2f(uR, w, h);
    };
    const mouse = { x: .7, y: .5, tx: .7, ty: .5 };
    if (finePointer && !reduce) {
      section.addEventListener('pointermove', (e) => {
        const b = section.getBoundingClientRect();
        mouse.tx = (e.clientX - b.left) / b.width; mouse.ty = 1 - (e.clientY - b.top) / b.height;
      }, { passive: true });
    }
    let visible = true, raf = 0, t0 = performance.now(), last = 0;
    const draw = (now) => {
      raf = 0;
      if (!visible || document.hidden) return;
      // 40 кадров в секунду достаточно для плавного «дыма» и бережёт батарею
      if (now - last < 24) { raf = requestAnimationFrame(draw); return; }
      last = now;
      size();
      mouse.x += (mouse.tx - mouse.x) * .04; mouse.y += (mouse.ty - mouse.y) * .04;
      gl.uniform1f(uT, (now - t0) / 1000);
      gl.uniform2f(uM, mouse.x, mouse.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(draw);
    };
    if (reduce) {
      size(); gl.uniform1f(uT, 12.0); gl.uniform2f(uM, .7, .5); gl.drawArrays(gl.TRIANGLES, 0, 3);
      cv.classList.add('is-on');
      window.addEventListener('resize', () => { size(); gl.drawArrays(gl.TRIANGLES, 0, 3); });
      return;
    }
    const go = () => { if (!raf) raf = requestAnimationFrame(draw); };
    if ('IntersectionObserver' in window) new IntersectionObserver((list) => { visible = list[0].isIntersecting; if (visible) go(); }).observe(section);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) go(); });
    go();
    requestAnimationFrame(() => cv.classList.add('is-on'));
  }

  /* ---------- Своё видео на фоне (загружается в админке) ---------- */
  const video = $('[data-hero-video]');
  if (video) {
    const conn = navigator.connection || {};
    const slow = conn.saveData || /(^|-)2g$/.test(conn.effectiveType || '');
    if (!reduce && !slow) {
      video.addEventListener('playing', () => video.classList.add('is-on'), { once: true });
      video.src = video.dataset.src;
      const p = video.play();
      if (p && p.catch) p.catch(() => { /* автозапуск запрещён - остаётся фон */ });
      if ('IntersectionObserver' in window) new IntersectionObserver((list) => { if (list[0].isIntersecting) video.play().catch(() => {}); else video.pause(); }).observe(video);
    }
  }

  /* ---------- Витрина моделей: смена по таймеру, полоски, наклон за курсором ---------- */
  const spot = $('[data-spot]');
  if (spot) {
    const items = $$('[data-spot-item]', spot);
    const bars = $$('[data-spot-go]', spot);
    const card = $('[data-tilt]', spot);
    const MS = 5500;
    let cur = 0, timer = 0, paused = false;
    const show = (i) => {
      cur = (i + items.length) % items.length;
      items.forEach((it, k) => {
        const on = k === cur;
        it.classList.toggle('is-active', on);
        if (on) { it.removeAttribute('tabindex'); it.removeAttribute('aria-hidden'); } else { it.setAttribute('tabindex', '-1'); it.setAttribute('aria-hidden', 'true'); }
      });
      bars.forEach((b, k) => { b.classList.toggle('is-active', k === cur); b.classList.toggle('is-done', k < cur); });
      // перезапуск заполнения полоски
      const a = bars[cur]; if (a) { a.classList.remove('is-active'); void a.offsetWidth; a.classList.add('is-active'); }
      schedule();
    };
    const schedule = () => { clearTimeout(timer); if (!paused && !reduce && items.length > 1) timer = setTimeout(() => show(cur + 1), MS); };
    bars.forEach((b) => b.addEventListener('click', () => show(Number(b.dataset.spotGo) || 0)));
    const pause = (on) => { paused = on; spot.classList.toggle('is-paused', on); if (on) clearTimeout(timer); else schedule(); };
    spot.addEventListener('mouseenter', () => pause(true));
    spot.addEventListener('mouseleave', () => pause(false));
    spot.addEventListener('focusin', () => pause(true));
    spot.addEventListener('focusout', () => pause(false));
    document.addEventListener('visibilitychange', () => pause(document.hidden));
    schedule();
    if (card && finePointer && !reduce) {
      spot.addEventListener('pointermove', (e) => {
        const b = card.getBoundingClientRect();
        const x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height;
        card.classList.add('is-tilting');
        card.style.setProperty('--ry', ((x - .5) * 14).toFixed(2) + 'deg');
        card.style.setProperty('--rx', ((.5 - y) * 12).toFixed(2) + 'deg');
        card.style.setProperty('--gx', (x * 100).toFixed(1) + '%');
        card.style.setProperty('--gy', (y * 100).toFixed(1) + '%');
      }, { passive: true });
      spot.addEventListener('pointerleave', () => {
        card.classList.remove('is-tilting');
        card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg');
      });
    }
  }

  /* ---------- Счётчики: число «добегает» до значения, когда его видно ---------- */
  const counters = $$('[data-count]');
  if (counters.length && !reduce && 'IntersectionObserver' in window) {
    const fmt = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const io = new IntersectionObserver((list) => {
      for (const e of list) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const el = e.target, to = Number(el.dataset.count) || 0, t0 = performance.now(), dur = 1400;
        const step = (now) => {
          const k = Math.min(1, (now - t0) / dur);
          el.textContent = fmt(to * (1 - Math.pow(1 - k, 4)));
          if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
    }, { threshold: .6 });
    counters.forEach((c) => io.observe(c));
  }

  /* ---------- «Магнитные» кнопки и подсветка за курсором ---------- */
  if (finePointer && !reduce) {
    $$('[data-magnetic]').forEach((b) => {
      b.addEventListener('pointermove', (e) => {
        const r = b.getBoundingClientRect();
        b.style.translate = `${((e.clientX - r.left - r.width / 2) * .18).toFixed(1)}px ${((e.clientY - r.top - r.height / 2) * .3).toFixed(1)}px`;
      });
      b.addEventListener('pointerleave', () => { b.style.translate = ''; });
    });
    $$('[data-glow]').forEach((g) => {
      g.addEventListener('pointermove', (e) => {
        const r = g.getBoundingClientRect();
        g.style.setProperty('--mx', (e.clientX - r.left).toFixed(0) + 'px');
        g.style.setProperty('--my', (e.clientY - r.top).toFixed(0) + 'px');
      }, { passive: true });
    });
  }

  /* ---------- Перелёт фото: карточка товара -> страница модели (View Transitions между страницами) ---------- */
  if (!reduce) {
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a.card, a.spot__item');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const img = a.querySelector('.card__img, img');
      if (img) img.style.viewTransitionName = 'pimg';
    });
    // вернулись кнопкой «назад» - имя снимаем, иначе две картинки с одним именем сорвут переход
    window.addEventListener('pageshow', () => { $$('.card__img, .spot__item img').forEach((i) => { i.style.viewTransitionName = ''; }); });
  }
})();
