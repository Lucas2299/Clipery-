/* Clipery Editor - review where the AI would cut, adjust, then render.
 *
 * Flow:  pick file -> /api/editor/upload (review=1 or manual=1)
 *        poll /api/clip/status/:id until status === "review"
 *        show source video + timeline + one card per planned clip
 *        user edits -> POST /api/editor/render {jobId, clips:[...]}
 *        poll until done -> show rendered clips
 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  if (!$("view-editor")) return;

  // Owner-only preview for now: the tab stays hidden until the account says
  // it is the owner. Everyone else gets bounced back to Long form.
  fetch("/api/auth/me").then(function (r) { return r.json(); }).then(function (d) {
    var owner = !!(d && d.user && d.user.isOwner);
    var b = $("btn-editor");
    if (b) b.hidden = !owner;
    if (!owner && new URLSearchParams(location.search).get("tool") === "editor") window.setStudioMode("long");
  }).catch(function () {});

  var fileIn = $("ed-file"), fname = $("ed-fname"), go = $("ed-go"), msg = $("ed-msg");
  var status = $("ed-status"), stage = $("ed-stage"), pct = $("ed-pct"), fill = $("ed-fill"), detail = $("ed-detail");
  var setup = $("ed-setup"), work = $("ed-work"), results = $("ed-results"), grid = $("ed-grid");
  var video = $("ed-video"), tl = $("ed-timeline"), track = $("ed-tl-track"), cursor = $("ed-tl-cursor");
  var timeEl = $("ed-time"), durEl = $("ed-dur"), list = $("ed-list"), count = $("ed-count");
  var addBtn = $("ed-add"), renderBtn = $("ed-render"), renderMsg = $("ed-render-msg");

  var file = null, jobId = null, job = null, plan = [], duration = 0, poll = null, playStop = null;
  var LAYOUTS = [
    ["auto", "Let AI decide"],
    ["follow", "Zoomed in, follows the speaker"],
    ["static", "Zoomed in, locked"],
    ["wide", "Full picture, no zoom"],
    ["center", "Zoomed in, centre"]
  ];
  var STYLES = ["outline", "highlight", "box", "pop", "classic", "rainbow", "hormozi", "mrbeast", "reels"];
  var COLORS = ["white", "yellow", "pink", "orange", "red", "green", "cyan", "blue", "purple"];

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmt(t) {
    t = Math.max(0, Number(t) || 0);
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  function fmt2(t) { return (Math.round((Number(t) || 0) * 10) / 10).toFixed(1); }
  function setMsg(el, text, err) { if (!el) return; el.textContent = text || ""; el.style.color = err ? "#ff6b6b" : ""; }
  function stageLabel(s) {
    var map = { queued: "Waiting in line", downloading: "Downloading the video", probing: "Reading the file", detecting_moments: "Finding moments", listening: "Listening to the speech",
      watching: "Watching the picture", scoring: "Scoring moments", checking_context: "Checking each moment makes sense", rendering: "Rendering clips", review: "Ready to review", complete: "Done" };
    return map[s] || s || "Working";
  }

  /* ---------- 1. upload ---------- */
  var urlIn = $("ed-url");
  if (fileIn) fileIn.addEventListener("change", function () {
    file = fileIn.files && fileIn.files[0] ? fileIn.files[0] : null;
    if (fname) { fname.textContent = file ? file.name : ""; fname.hidden = !file; }
    if (file && urlIn) urlIn.value = "";
  });
  if (urlIn) urlIn.addEventListener("input", function () {
    if (urlIn.value.trim() && file) { file = null; if (fileIn) fileIn.value = ""; if (fname) { fname.textContent = ""; fname.hidden = true; } }
  });
  var subsT = $("ed-subs"), subsG = $("ed-substyle");
  if (subsT && subsG) {
    var syncSubs = function () { subsG.classList.toggle("subs-off", !subsT.checked); };
    subsT.addEventListener("change", syncSubs); syncSubs();
  }
  function how() { var r = document.querySelector('input[name="ed-how"]:checked'); return r ? r.value : "ai"; }
  function subStyleOf(prefix) {
    var gv = function (k) { var e = $(prefix + "-sub-" + k); return e ? e.value : ""; };
    return { color: gv("color"), size: gv("size"), pos: gv("pos"), style: gv("style") };
  }

  if (go) go.addEventListener("click", async function () {
    var link = urlIn ? urlIn.value.trim() : "";
    if (!file && !link) { setMsg(msg, "Choose a video file or paste a YouTube link first.", true); return; }
    if (link && !/^https?:\/\//i.test(link)) { setMsg(msg, "That link does not look right - it should start with https://", true); return; }
    go.disabled = true; setMsg(msg, "");
    try {
      var st = subStyleOf("ed");
      var res;
      if (file) {
        var fd = new FormData();
        fd.append("video", file, file.name);
        fd.append("manual", how() === "manual" ? "1" : "0");
        fd.append("subtitles", subsT && subsT.checked ? "1" : "0");
        fd.append("subColor", st.color); fd.append("subSize", st.size); fd.append("subPos", st.pos); fd.append("subStyle", st.style);
        res = await fetch("/api/editor/upload", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/editor/from-url", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: link, manual: how() === "manual" ? "1" : "0", subtitles: subsT && subsT.checked ? "1" : "0",
            subColor: st.color, subSize: st.size, subPos: st.pos, subStyle: st.style }) });
      }
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || ("Upload failed (" + res.status + ")"));
      jobId = data.jobId;
      try { history.replaceState({}, "", "/studio?tool=editor&job=" + jobId); } catch (e) {}
      showProgress({ stage: data.queued ? "queued" : link ? "downloading" : "probing", progress: 2 });
      watch(function (j) { return j.status === "review"; }, openReview);
    } catch (e) {
      setMsg(msg, e.message, true);
      go.disabled = false;
    }
  });

  function showProgress(j) {
    if (status) status.style.display = "block";
    if (stage) stage.textContent = stageLabel(j.stage) + (j.stageNote ? " - " + j.stageNote : "");
    if (pct) pct.textContent = (j.progress || 0) + "%";
    if (fill) fill.style.width = (j.progress || 0) + "%";
    if (detail) detail.textContent = j.status === "queued" ? "Another video is rendering. Yours starts right after." : "";
  }

  function watch(untilFn, then) {
    if (poll) clearInterval(poll);
    var tick = async function () {
      try {
        var res = await fetch("/api/clip/status/" + jobId);
        var data = await res.json();
        if (!data.ok) return;
        job = data.job;
        showProgress(job);
        if (job.status === "error") {
          clearInterval(poll); poll = null;
          setMsg(msg, job.error || "Something went wrong.", true);
          setMsg(renderMsg, job.error || "Something went wrong.", true);
          if (go) go.disabled = false;
          if (renderBtn) renderBtn.disabled = false;
          return;
        }
        if (untilFn(job)) { clearInterval(poll); poll = null; then(job); }
      } catch (e) {}
    };
    tick();
    poll = setInterval(tick, 1500);
  }

  /* ---------- 2. review ---------- */
  function openReview(j) {
    if (status) status.style.display = "none";
    if (setup) setup.hidden = true;
    if (work) work.hidden = false;
    duration = Number(j.duration || (j.review && j.review.meta && j.review.meta.duration) || 0);
    plan = (j.plan || []).map(function (p) { return Object.assign({}, p); });
    video.src = "/api/editor/source/" + jobId;
    video.addEventListener("loadedmetadata", function () {
      if (video.duration && isFinite(video.duration)) duration = video.duration;
      if (durEl) durEl.textContent = fmt(duration);
      drawTimeline();
    });
    video.addEventListener("timeupdate", function () {
      if (timeEl) timeEl.textContent = fmt(video.currentTime);
      if (cursor && duration) cursor.style.left = (video.currentTime / duration * 100) + "%";
      if (playStop != null && video.currentTime >= playStop) { video.pause(); playStop = null; }
    });
    if (durEl) durEl.textContent = fmt(duration);
    if (!plan.length && !(j.manual)) setMsg(renderMsg, "The AI found no clear moments - add clips yourself.", false);
    if (j.manual && !plan.length) setMsg(renderMsg, "Play the video and press 'Add clip at playhead' where a clip should start.", false);
    renderList();
    drawTimeline();
  }

  function drawTimeline() {
    if (!track || !duration) return;
    track.innerHTML = "";
    plan.forEach(function (p, i) {
      var seg = document.createElement("div");
      seg.className = "ed-seg" + (p.source === "user" ? " user" : "");
      seg.style.left = (p.start / duration * 100) + "%";
      seg.style.width = (Math.max(0.3, (p.end - p.start)) / duration * 100) + "%";
      seg.title = "#" + (i + 1) + " " + fmt(p.start) + " - " + fmt(p.end);
      seg.textContent = String(i + 1);
      seg.addEventListener("click", function () { playRange(p); focusCard(p.id); });
      track.appendChild(seg);
    });
  }
  if (tl) tl.addEventListener("click", function (ev) {
    if (ev.target && ev.target.classList.contains("ed-seg")) return;
    var r = tl.getBoundingClientRect();
    var x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    if (duration) { playStop = null; video.currentTime = x * duration; }
  });

  function playRange(p) {
    playStop = p.end;
    video.currentTime = p.start;
    video.play().catch(function () {});
  }
  function focusCard(id) {
    var el = document.querySelector('.ed-card[data-id="' + id + '"]');
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "nearest" }); el.classList.add("flash"); setTimeout(function () { el.classList.remove("flash"); }, 900); }
  }

  function layoutDefault(p) {
    return p.layout && p.layout !== "auto" ? p.layout : "auto";
  }

  function scoreBars(p) {
    if (!p.scores) return "";
    var keys = ["hook", "curiosity", "emotion", "value", "completion", "surprise", "payoff", "retention"];
    return '<div class="brain-scores">' + keys.map(function (k) {
      var v = p.scores[k] != null ? p.scores[k] : 0;
      var cls = v >= 75 ? "hi" : v >= 55 ? "mid" : "lo";
      return '<div class="bscore"><span class="bscore-k">' + k + '</span><span class="bscore-bar"><i class="' + cls + '" style="width:' + v + '%"></i></span><span class="bscore-v">' + v + "</span></div>";
    }).join("") + "</div>";
  }

  function card(p, i) {
    var st = p.subStyle || (job && job.review && job.review.options && job.review.options.subStyle) || {};
    var caps = p.captions != null ? !!p.captions : !!(job && job.subtitles);
    var why = (p.reasons || []).slice(0, 3);
    return (
      '<article class="ed-card" data-id="' + esc(p.id) + '">' +
      '<div class="ed-card-head">' +
      '<span class="clip-rank-pill">#' + (i + 1) + "</span>" +
      (p.viralScore ? '<span class="viral-score-pill ' + (p.viralScore >= 82 ? "v-strong" : p.viralScore >= 72 ? "v-good" : "v-avg") + '">' + p.viralScore + " viral</span>" : '<span class="ed-user-tag">your clip</span>') +
      '<input class="ed-title" data-k="title" value="' + esc(p.title || "") + '" maxlength="80" />' +
      '<button type="button" class="ed-del" title="Remove this clip">Remove</button>' +
      "</div>" +
      (p.summary ? '<p class="ed-summary">' + esc(p.summary) + "</p>" : "") +
      (p.quote ? '<p class="clip-quote">&quot;' + esc(p.quote) + "&quot;</p>" : "") +
      '<div class="ed-range">' +
      '<label>Start <input type="number" step="0.1" min="0" data-k="start" value="' + fmt2(p.start) + '" /></label>' +
      '<label>End <input type="number" step="0.1" min="0" data-k="end" value="' + fmt2(p.end) + '" /></label>' +
      '<span class="ed-len">' + fmt2(p.end - p.start) + "s</span>" +
      '<button type="button" class="btn btn-ghost ed-play">Play this</button>' +
      '<button type="button" class="btn btn-ghost ed-set-start" title="Use the current video position as the start">Start = playhead</button>' +
      '<button type="button" class="btn btn-ghost ed-set-end" title="Use the current video position as the end">End = playhead</button>' +
      "</div>" +
      '<div class="ed-opts">' +
      '<label>Framing <select data-k="layout">' + LAYOUTS.map(function (l) { return '<option value="' + l[0] + '"' + (layoutDefault(p) === l[0] ? " selected" : "") + ">" + l[1] + "</option>"; }).join("") + "</select></label>" +
      '<label class="ed-caps"><input type="checkbox" data-k="captions"' + (caps ? " checked" : "") + " /> Captions</label>" +
      '<label>Style <select data-k="style">' + STYLES.map(function (x) { return '<option value="' + x + '"' + ((st.style || "outline") === x ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></label>" +
      '<label>Colour <select data-k="color">' + COLORS.map(function (x) { return '<option value="' + x + '"' + ((st.color || "white") === x ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></label>" +
      "</div>" +
      (why.length || p.scores ? '<details class="brain-panel"><summary>Why this clip</summary>' +
        (why.length ? '<ul class="viral-reasons">' + why.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>" : "") +
        scoreBars(p) + "</details>" : "") +
      "</article>"
    );
  }

  function renderList() {
    if (!list) return;
    plan.sort(function (a, b) { return a.start - b.start; });
    list.innerHTML = plan.map(card).join("");
    if (count) count.textContent = plan.length + " clip" + (plan.length === 1 ? "" : "s");
    if (renderBtn) { renderBtn.textContent = "Render " + plan.length + " clip" + (plan.length === 1 ? "" : "s"); renderBtn.disabled = !plan.length; }
    drawTimeline();
  }

  function findPlan(id) { for (var i = 0; i < plan.length; i++) if (plan[i].id === id) return plan[i]; return null; }

  if (list) {
    list.addEventListener("click", function (ev) {
      var cardEl = ev.target.closest ? ev.target.closest(".ed-card") : null;
      if (!cardEl) return;
      var p = findPlan(cardEl.getAttribute("data-id"));
      if (!p) return;
      if (ev.target.classList.contains("ed-del")) {
        plan = plan.filter(function (x) { return x !== p; });
        renderList();
      } else if (ev.target.classList.contains("ed-play")) {
        playRange(p);
      } else if (ev.target.classList.contains("ed-set-start")) {
        p.start = Math.min(video.currentTime, p.end - 3);
        p.start = Math.max(0, +p.start.toFixed(2));
        renderList();
      } else if (ev.target.classList.contains("ed-set-end")) {
        p.end = Math.max(video.currentTime, p.start + 3);
        p.end = Math.min(duration || p.end, +p.end.toFixed(2));
        renderList();
      }
    });
    list.addEventListener("change", function (ev) {
      var cardEl = ev.target.closest ? ev.target.closest(".ed-card") : null;
      if (!cardEl) return;
      var p = findPlan(cardEl.getAttribute("data-id"));
      if (!p) return;
      var k = ev.target.getAttribute("data-k");
      if (k === "start" || k === "end") {
        var v = Number(ev.target.value);
        if (!isFinite(v)) return;
        if (k === "start") p.start = Math.max(0, Math.min(v, p.end - 3));
        else p.end = Math.min(duration || v, Math.max(v, p.start + 3));
        p.start = +p.start.toFixed(2); p.end = +p.end.toFixed(2);
        renderList();
      } else if (k === "title") {
        p.title = ev.target.value;
      } else if (k === "layout") {
        p.layout = ev.target.value;
      } else if (k === "captions") {
        p.captions = ev.target.checked;
      } else if (k === "style" || k === "color") {
        var base = p.subStyle || (job && job.review && job.review.options && job.review.options.subStyle) || {};
        p.subStyle = { color: base.color || "white", size: base.size || "medium", pos: base.pos || "bottom", style: base.style || "outline" };
        p.subStyle[k] = ev.target.value;
      }
    });
  }

  if (addBtn) addBtn.addEventListener("click", function () {
    var start = Math.max(0, +video.currentTime.toFixed(2));
    var end = Math.min(duration || start + 30, start + 30);
    if (end - start < 3) { setMsg(renderMsg, "Too close to the end of the video.", true); return; }
    var id = "u" + Math.random().toString(16).slice(2, 8);
    plan.push({ id: id, start: start, end: +end.toFixed(2), title: "My clip " + (plan.length + 1), layout: "auto",
      captions: !!(job && job.subtitles), source: "user", reasons: [], scores: null });
    setMsg(renderMsg, "");
    renderList();
    focusCard(id);
  });

  /* ---------- 3. render ---------- */
  if (renderBtn) renderBtn.addEventListener("click", async function () {
    if (!plan.length) return;
    renderBtn.disabled = true; setMsg(renderMsg, "");
    try {
      var body = { jobId: jobId, clips: plan.map(function (p) {
        return { id: p.id, start: p.start, end: p.end, title: p.title, layout: p.layout || "auto", captions: p.captions, subStyle: p.subStyle || null };
      }) };
      var res = await fetch("/api/editor/render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || ("Render failed (" + res.status + ")"));
      if (work) work.hidden = true;
      if (setup) setup.hidden = false;
      if (status) status.style.display = "block";
      showProgress({ stage: data.queued ? "queued" : "rendering", progress: 52 });
      watch(function (j) { return j.status === "done"; }, showResults);
    } catch (e) {
      setMsg(renderMsg, e.message, true);
      renderBtn.disabled = false;
    }
  });

  function showResults(j) {
    if (status) status.style.display = "none";
    if (results) results.hidden = false;
    if (grid) grid.innerHTML = (j.clips || []).map(function (c) {
      return '<article class="clip-card viral-card"><video src="' + esc(c.url) + '" controls playsinline preload="metadata"></video>' +
        '<div class="clip-card-body"><div class="viral-top"><span class="clip-rank-pill">#' + c.rank + "</span>" +
        (c.viralScore ? '<span class="viral-score-pill v-good">' + c.viralScore + " viral</span>" : "") + "</div>" +
        "<h4>" + esc(c.title || "Clip") + "</h4>" +
        '<div class="meta">' + fmt(c.start) + " - " + fmt(c.end) + (c.reframe ? " &middot; " + esc(c.reframe === "wide" ? "full picture" : c.reframe === "follow" ? "follows the speaker" : c.reframe === "static" ? "locked" : "centre") : "") + "</div>" +
        '<div class="clip-actions"><a href="' + esc(c.url) + '" download>Download</a></div></div></article>';
    }).join("");
    setMsg(msg, "Done. Your clips are below and in the Library.");
    if (go) go.disabled = false;
    if (results) results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- resume from URL ---------- */
  var params = new URLSearchParams(location.search);
  var resume = params.get("job");
  if (resume && /^[a-f0-9]+$/i.test(resume) && params.get("tool") === "editor") {
    jobId = resume;
    showProgress({ stage: "queued", progress: 1 });
    watch(function (j) { return j.status === "review" || j.status === "done"; }, function (j) {
      if (j.status === "done") showResults(j); else openReview(j);
    });
  }
})();
