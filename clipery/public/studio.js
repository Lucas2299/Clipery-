(function () {
  "use strict";

  function $(id) {
    return document.getElementById(id);
  }

  function collectSubStyle(prefix) {
    function gv(key) {
      var e = $(prefix + "-sub-" + key);
      return e ? e.value : "";
    }
    return { color: gv("color"), size: gv("size"), pos: gv("pos"), style: gv("style"), words: gv("words") };
  }

  function collectTrends(prefix) {
    var e = $(prefix + "-trends");
    return e ? e.value.trim() : "";
  }

  function wireSubToggle(toggleId, gridId) {
    var t = $(toggleId);
    var g = $(gridId);
    if (!t || !g) return;
    function sync() {
      g.classList.toggle("subs-off", !t.checked);
    }
    t.addEventListener("change", sync);
    sync();
  }
  // "What kind of video is this?" - tells the camera how to behave.
  // Injected here (not in the HTML) so it sits right under the file row.
  var GENRES = [
    ["auto", "Let AI decide", "Looks at the faces and picks"],
    ["podcast", "Podcast / interview", "Follows whoever is talking, keeps both hosts in"],
    ["talking", "Talking to camera", "One person: locked on the face"],
    ["stream", "Stream / reaction", "Follows the streamer, more movement"],
    ["gaming", "Gaming", "Full picture, never zooms into the face cam"]
  ];
  function genreHtml(prefix) {
    var h = '<div class="genre-title">What kind of video is this?</div><div class="genre-row">';
    for (var i = 0; i < GENRES.length; i++) {
      var g = GENRES[i];
      h += '<label class="genre-opt"><input type="radio" name="' + prefix + '-genre" value="' + g[0] + '"' + (i === 0 ? " checked" : "") + " /><span><b>" + g[1] + "</b><small>" + g[2] + "</small></span></label>";
    }
    return h + "</div>";
  }
  function mountGenre(prefix, afterId) {
    var host = $(prefix + "-genre");
    if (!host) {
      var after = $(afterId);
      if (!after || !after.parentNode) return;
      host = document.createElement("div");
      host.className = "genre-pick";
      host.id = prefix + "-genre";
      after.parentNode.insertBefore(host, after.nextSibling);
    }
    host.innerHTML = genreHtml(prefix);
  }
  window.clipGenre = function (prefix) {
    var r = document.querySelector('input[name="' + prefix + '-genre"]:checked');
    return r ? r.value : "auto";
  };
  mountGenre("long", "long-fname");
  mountGenre("ed", "ed-fname");

  wireSubToggle("long-subs", "long-substyle");
  wireSubToggle("rank-subs", "rank-substyle");

  function collectHook(prefix) {
    var t = $(prefix + "-hook");
    var m = $(prefix + "-hook-mode");
    return { enabled: !!(t && t.checked), mode: m ? m.value : "intro" };
  }

  // Hook title and subtitles are either/or: both at once fight for the
  // same screen. Turning one on switches the other off.
  function wireHookToggle(prefix) {
    var t = $(prefix + "-hook");
    var g = $(prefix + "-hookgrid");
    var subs = $(prefix + "-subs");
    if (!t) return;
    function sync() {
      if (g) g.classList.toggle("subs-off", !t.checked);
    }
    t.addEventListener("change", function () {
      if (t.checked && subs && subs.checked) {
        subs.checked = false;
        subs.dispatchEvent(new Event("change"));
      }
      sync();
    });
    if (subs) {
      subs.addEventListener("change", function () {
        if (subs.checked && t.checked) {
          t.checked = false;
          sync();
        }
      });
    }
    // Subtitles are on by default, so the hook starts off.
    if (t.checked && subs && subs.checked) t.checked = false;
    sync();
  }
  wireHookToggle("long");
  wireHookToggle("rank");

  // The little caption preview box is gone: the style cards already show
  // the real look, and the box only took space.
  (function removePreviews() {
    var ids = ["long-sub-preview", "rank-sub-preview"];
    for (var i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
  })();

  /* --- live subtitle style preview --- */
  var SUB_PREV = {
    colors: {
      white: "#ffffff", yellow: "#FFE74C", pink: "#FF4D6D", orange: "#FF8A4C",
      red: "#FF3B3B", green: "#30D158", cyan: "#3CD4F5", blue: "#4C8AFF", purple: "#A86BFF"
    },
    sizes: { small: 9, medium: 11 },
    pos: { bottom: "72%", middle: "38%", top: "18%" }, // matches engine safe zones (top clears the hook title)
    rainbow: ["#FFE74C", "#FF4D6D", "#3CD4F5", "#30D158", "#FF8A4C", "#A86BFF"],
    beast: ["#FFE74C", "#FFFFFF", "#FF3B3B", "#30D158", "#FF8A4C", "#3CD4F5"]
  };

  function updateSubPreview(prefix) {
    var box = $(prefix + "-sub-preview");
    if (!box) return;
    var frame = box.querySelector(".sub-preview-frame");
    var cap = box.querySelector(".sub-preview-cap");
    if (!frame || !cap) return;
    var s = collectSubStyle(prefix);
    var col = SUB_PREV.colors[s.color] || "#ffffff";
    // FIXED text colour for styles with their own solid background box
    var FIXED = { boxwhite: "#17171B", boxred: "#ffffff", boxblack: "#ffffff" };
    var wordCol = FIXED[s.style] || col;
    // style cards preview the real look: their sample words wear the chosen colour
    var sCards = cardsIn(prefix, "styles");
    for (var ci = 0; ci < sCards.length; ci++) {
      if (/sc-bwhite|sc-bred|sc-bblack/.test(sCards[ci].className)) continue; // fixed-colour boxes
      var cws = sCards[ci].querySelectorAll(".sc-cap .w");
      for (var cw = 0; cw < cws.length; cw++) cws[cw].style.color = col;
    }
    cap.style.fontSize = (SUB_PREV.sizes[s.size] || 11) + "px";
    cap.style.top = SUB_PREV.pos[s.pos] || "68%";
    var isBoxed = s.style === "box" || s.style === "boxdark" || s.style === "boxlight"
      || s.style === "boxwhite" || s.style === "boxred" || s.style === "boxblack";
    frame.classList.toggle("box", isBoxed);
    frame.classList.toggle("boxwhite", s.style === "boxwhite");
    frame.classList.toggle("boxred", s.style === "boxred");
    frame.classList.toggle("boxblack", s.style === "boxblack");
    frame.classList.toggle("pop", s.style === "pop" || s.style === "mrbeast");
    // boxed looks draw ONE box around the whole line → shrink-wrap the caption strip
    if (isBoxed) {
      cap.style.left = "50%"; cap.style.right = "auto";
      cap.style.width = "fit-content"; cap.style.maxWidth = "94%";
      cap.style.transform = "translateX(-50%)";
    } else {
      cap.style.left = ""; cap.style.right = ""; cap.style.width = "";
      cap.style.maxWidth = ""; cap.style.transform = "";
    }
    var STATIC = { classic: 1, plain: 1, outlined: 1, thick: 1, shadow: 1, boxdark: 1, boxlight: 1, boxwhite: 1, boxred: 1, boxblack: 1 };
    var OUT1 = "-1px 0 0 #000,1px 0 0 #000,0 -1px 0 #000,0 1px 0 #000";
    var shadow = isBoxed ? "none"
      : s.style === "thick" ? "-2px 0 0 #000,2px 0 0 #000,0 -2px 0 #000,0 2px 0 #000,-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000"
      : s.style === "shadow" ? "0 0 2px rgba(0,0,0,0.9),2px 2px 0 #000"
      : s.style === "plain" ? "0 1px 2px rgba(0,0,0,0.6)"
      : OUT1;
    cap.style.textTransform = (s.style === "hormozi" || s.style === "mrbeast") ? "uppercase" : "none";
    var spans = cap.querySelectorAll(".lit, .dim");
    for (var i = 0; i < spans.length; i++) {
      var w = spans[i];
      var isDim = w.className === "dim";
      if (isDim) {
        // upcoming: hidden for pop/mrbeast, white for highlight/hormozi, full-colour for static looks
        if (s.style === "pop" || s.style === "mrbeast") { w.style.color = "#fff"; w.style.opacity = "0"; }
        else if (STATIC[s.style]) { w.style.color = wordCol; w.style.opacity = "1"; }
        else if (s.style === "highlight" || s.style === "hormozi" || s.style === "reels") { w.style.color = "#fff"; w.style.opacity = "1"; }
        else { w.style.color = "#fff"; w.style.opacity = "0.45"; }
        w.style.textShadow = shadow;
      } else {
        w.style.opacity = "1";
        w.style.color = s.style === "rainbow" ? SUB_PREV.rainbow[i % SUB_PREV.rainbow.length]
          : s.style === "mrbeast" ? SUB_PREV.beast[i % SUB_PREV.beast.length]
          : wordCol;
        w.style.textShadow = shadow;
      }
    }
  }

  var TEMPLATES = {
    tiktok:  { color: "white",  size: "medium", pos: "bottom", style: "outline",   words: 3 },
    beast:   { color: "yellow", size: "medium", pos: "middle", style: "outline",   words: 3 },
    candy:   { color: "pink",   size: "medium", pos: "middle", style: "pop",       words: 4 },
    rainbow: { color: "pink",   size: "medium", pos: "bottom", style: "rainbow",   words: 4 },
    news:    { color: "white",  size: "small",  pos: "top",    style: "box",       words: 5 },
    goldbox: { color: "yellow", size: "medium", pos: "bottom", style: "box",       words: 4 },
    glow:    { color: "orange", size: "medium", pos: "middle", style: "highlight", words: 3 },
    clean:   { color: "white",  size: "small",  pos: "bottom", style: "classic",   words: 5 },
    hormozi: { color: "yellow", size: "medium", pos: "middle", style: "hormozi",   words: 3 },
    mrbeast: { color: "yellow", size: "medium", pos: "middle", style: "mrbeast",   words: 3 },
    reels:   { color: "yellow", size: "medium", pos: "middle", style: "highlight", words: 3 }
  };

  /* A picked template owns colour, size and word count — only Position stays
     free. Styles (cards) leave colour & size open for the user. */
  function setTplLock(prefix, on) {
    var keys = ["color", "size"];
    for (var i = 0; i < keys.length; i++) {
      var el = $(prefix + "-sub-" + keys[i]);
      if (!el) continue;
      el.disabled = !!on;
      var lab = el.closest ? el.closest("label") : null;
      if (lab) lab.classList.toggle("locked", !!on);
    }
    var hint = $(prefix + "-tpl-lock");
    if (hint) hint.hidden = !on;
  }

  function setTplWords(prefix, words) {
    var el = $(prefix + "-sub-words");
    if (el) el.value = words || "";
  }

  /* --- visual style/template cards --- */
  function cardsIn(prefix, kind) {
    var grid = $(prefix + "-cards-" + kind);
    return grid ? grid.querySelectorAll(".sub-card") : [];
  }

  function clearSel(list) {
    for (var j = 0; j < list.length; j++) list[j].classList.remove("sel");
  }

  function clearTplChips(prefix) {
    clearSel(cardsIn(prefix, "templates"));
  }

  function syncStyleCards(prefix) {
    var styleSel = $(prefix + "-sub-style");
    var cards = cardsIn(prefix, "styles");
    clearSel(cards);
    for (var j = 0; j < cards.length; j++) {
      if (styleSel && cards[j].getAttribute("data-style") === styleSel.value) {
        cards[j].classList.add("sel");
      }
    }
  }

  function wireStyleCards(prefix) {
    var cards = cardsIn(prefix, "styles");
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener("click", function (ev) {
        var st = ev.currentTarget.getAttribute("data-style");
        var sel = $(prefix + "-sub-style");
        if (sel && st) sel.value = st;
        clearTplChips(prefix);
        setTplLock(prefix, false); // styles: colour & size stay yours
        setTplWords(prefix, "");
        syncStyleCards(prefix);
        updateSubPreview(prefix);
      });
    }
  }

  function wireSubTabs(prefix) {
    var tabs = $(prefix + "-subtabs");
    if (!tabs) return;
    var btns = tabs.querySelectorAll(".sub-tab");
    var styles = $(prefix + "-cards-styles");
    var tpls = $(prefix + "-cards-templates");
    function showMode(mode) {
      for (var j = 0; j < btns.length; j++) btns[j].classList.toggle("active", btns[j].getAttribute("data-tab") === mode);
      if (styles) { styles.hidden = mode !== "styles"; styles.style.display = mode === "styles" ? "grid" : "none"; }
      if (tpls) { tpls.hidden = mode !== "templates"; tpls.style.display = mode === "templates" ? "grid" : "none"; }
    }
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function (ev) {
        showMode(ev.currentTarget.getAttribute("data-tab"));
      });
    }
    showMode("templates"); // start on the Templates tab
  }

  function wireTemplates(prefix) {
    var cards = cardsIn(prefix, "templates");
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener("click", function (ev) {
        var t = TEMPLATES[ev.currentTarget.getAttribute("data-tpl")];
        if (!t) return;
        var keys = ["color", "size", "pos", "style"];
        for (var k = 0; k < keys.length; k++) {
          var sel = $(prefix + "-sub-" + keys[k]);
          if (sel) sel.value = t[keys[k]];
        }
        setTplWords(prefix, t.words);
        setTplLock(prefix, true); // template owns colour/size/words — placement stays yours
        clearTplChips(prefix);
        ev.currentTarget.classList.add("sel");
        syncStyleCards(prefix);
        updateSubPreview(prefix);
      });
    }
  }

  function wireSubControl(prefix, key) {
    var el = $(prefix + "-sub-" + key);
    if (!el) return;
    el.addEventListener("change", function () {
      // Position is always yours to change, template or not. Only
      // hand-tuning colour/size/style means leaving the template behind.
      if (key !== "pos") {
        clearTplChips(prefix);
        setTplLock(prefix, false);
        setTplWords(prefix, "");
      }
      updateSubPreview(prefix);
    });
  }

  function wireSubPreview(prefix) {
    var keys = ["color", "size", "pos", "style"];
    for (var i = 0; i < keys.length; i++) wireSubControl(prefix, keys[i]);
    wireSubTabs(prefix);
    wireStyleCards(prefix);
    wireTemplates(prefix);
    syncStyleCards(prefix);
    updateSubPreview(prefix);
  }
  wireSubPreview("long");
  wireSubPreview("rank");

  // Reels card: give it its own look (dark box, pink highlight) so it no
  // longer reads as a copy of Hormozi. Done here because the card markup is
  // one long generated line.
  (function styleReelsCards() {
    TEMPLATES.reels = { color: "red", size: "medium", pos: "bottom", style: "reels", words: 3 };
    var cards = document.querySelectorAll('.sub-card[data-tpl="reels"]');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      c.classList.remove("sc-caps");
      c.classList.remove("sc-box");
      c.classList.remove("sc-bdim");
      c.style.setProperty("--hl", "#FF3B3B");
      var meta = c.querySelector(".sc-meta");
      if (meta) meta.textContent = "red . med . 3 words";
    }
  })();

  function setMsg(node, text, isErr) {
    if (!node) return;
    node.textContent = text || "";
    node.className = "form-msg" + (text ? (isErr ? " error" : " success") : "");
  }

  function stageLabel(s) {
    var map = {
      queued: "Queued",
      downloading: "Downloading",
      probing: "Reading video",
      detecting_moments: "Finding moments",
      scoring: "Scoring",
      listening: "Listening",
      watching: "Watching",
      checking_context: "Checking context",
      scoring_sources: "Scoring videos",
      rendering: "Rendering",
      rendering_clips: "Rendering clips",
      building_compilation: "Building ranking video",
      complete: "Done",
      processing: "Processing",
      done: "Done",
    };
    return map[s] || s || "Working…";
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // The three brains, per clip: what it is (1), why it scores (2), how it
  // was cut (3). Collapsed by default so the card stays tidy.
  var SCORE_ORDER = ["hook", "curiosity", "emotion", "value", "completion", "surprise", "payoff", "retention"];
  function brainPanel(c) {
    var sc = c.scores;
    if (!sc) return "";
    var bars = SCORE_ORDER.map(function (k) {
      var v = sc[k] != null ? sc[k] : 0;
      var cls = v >= 75 ? "hi" : v >= 55 ? "mid" : "lo";
      return (
        '<div class="bscore"><span class="bscore-k">' + k + "</span>" +
        '<span class="bscore-bar"><i class="' + cls + '" style="width:' + v + '%"></i></span>' +
        '<span class="bscore-v">' + v + "</span></div>"
      );
    }).join("");
    var ed = c.edit || {};
    var edits = [];
    if (ed.anchor) edits.push("built around: " + ed.anchor);
    if (ed.reasons && ed.reasons.length) edits.push(ed.reasons.join(", "));
    if (ed.emphasis && ed.emphasis.length) edits.push("caption emphasis: " + ed.emphasis.slice(0, 5).join(", "));
    if (ed.trimmed >= 0.5) edits.push("cut " + ed.trimmed + "s of dead air");
    else if (ed.trimmable >= 1) edits.push(ed.trimmable + "s of dead air could be trimmed");
    if (ed.punchIn) edits.push("punch-in on the key line");
    return (
      '<details class="brain-panel"><summary>Why this clip</summary>' +
      (c.summary ? '<p class="brain-line"><b>What it is:</b> ' + esc(c.summary) + "</p>" : "") +
      '<div class="brain-scores">' + bars + "</div>" +
      (edits.length ? '<p class="brain-line"><b>Edit:</b> ' + esc(edits.join(" / ")) + "</p>" : "") +
      "</details>"
    );
  }

  function clipCard(c) {
    var vs = c.viralScore != null ? c.viralScore : c.score;
    var verdict = c.verdict || "";
    var reasons = (c.reasons || []).slice(0, 3);
    var badgeClass = "v-avg";
    if (c.verdictKey === "viral" || vs >= 90) badgeClass = "v-hot";
    else if (c.verdictKey === "strong" || vs >= 82) badgeClass = "v-strong";
    else if (c.verdictKey === "good" || vs >= 72) badgeClass = "v-good";
    return (
      '<article class="clip-card viral-card">' +
      '<video src="' + esc(c.url) + '" controls playsinline preload="metadata"></video>' +
      '<div class="clip-card-body">' +
      '<div class="viral-top">' +
      '<span class="clip-rank-pill">#' + c.rank + "</span>" +
      '<span class="viral-score-pill ' + badgeClass + '">' + vs + " viral</span>" +
      "</div>" +
      (verdict ? '<div class="viral-verdict ' + badgeClass + '">' + esc(verdict) + "</div>" : "") +
      "<h4>" + esc(c.title || "Clip") + "</h4>" +
      (c.quote
        ? '<p class="clip-quote" style="margin:.35rem 0 .5rem;font-size:.82rem;color:#c9c4d4;font-style:italic">&ldquo;' +
          esc(c.quote) + '&rdquo;</p>'
        : "") +
      '<div class="meta">' + esc(c.postTip || "") +
      (c.reframe && c.reframe !== "center"
        ? ' &middot; ' + esc(
            c.reframe === "follow" ? "camera follows the speaker"
              : c.reframe === "wide" ? "zoomed out to fit everyone"
              : "locked on the speaker"
          )
        : "") +
      "</div>" +
      (reasons.length
        ? '<ul class="viral-reasons">' +
          reasons.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") +
          "</ul>"
        : "") +
      brainPanel(c) +
      '<div class="clip-actions"><a href="' + esc(c.url) + '" download>Download</a></div>' +
      "</div></article>"
    );
  }

  function pollJob(jobId, hooks) {
    var timer = null;
    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
    async function tick() {
      try {
        var res = await fetch("/api/clip/status/" + jobId);
        var data = await res.json();
        if (!res.ok || !data.ok) {
          if (hooks.onError) hooks.onError((data && data.error) || "Status failed");
          stop();
          return;
        }
        var job = data.job;
        if (hooks.onUpdate) hooks.onUpdate(job);
        if (job.status === "done") {
          if (hooks.onDone) hooks.onDone(job);
          stop();
        } else if (job.status === "error") {
          if (hooks.onError) hooks.onError(job.error || "Failed");
          stop();
        }
      } catch (e) {
        if (hooks.onError) hooks.onError("Network error while checking status");
        stop();
      }
    }
    tick();
    timer = setInterval(tick, 1000);
    return { stop: stop };
  }

  // Keep mode switch alive (also defined inline)
  if (typeof window.setStudioMode === "function") {
    // already set
  } else {
    window.setStudioMode = function (mode) {
      var isLong = mode !== "rank";
      var vl = $("view-long");
      var vr = $("view-rank");
      if (vl) {
        vl.style.display = isLong ? "block" : "none";
        vl.classList.toggle("is-hidden", !isLong);
      }
      if (vr) {
        vr.style.display = isLong ? "none" : "block";
        vr.classList.toggle("is-hidden", isLong);
      }
    };
  }

  /* ===== LONG FORM (1 only) ===== */
  var longFile = $("long-file");
  var longUrl = $("long-url");
  var longFname = $("long-fname");
  var longGo = $("long-go");
  var longMsg = $("long-msg");
  var longStatus = $("long-status");
  var longStage = $("long-stage");
  var longPct = $("long-pct");
  var longFill = $("long-fill");
  var longDetail = $("long-detail");
  var longResults = $("long-results");
  var longGrid = $("long-grid");
  var longTitle = $("long-title");
  var longJob = $("long-job");
  var fileObj = null;
  var longBusy = false;
  var longPoll = null;

  function longProgress(job) {
    if (longStatus) longStatus.style.display = "block";
    // A long step (transcribing, watching the picture) reports how many
    // seconds it has been running, so the screen never looks stuck.
    if (longStage) {
      longStage.textContent =
        stageLabel(job.stage || job.status) +
        (job.stageNote ? " " + String(job.stageNote).replace(/^.*- /, "") : "");
    }
    var pct = Math.min(100, Math.max(0, Number(job.progress) || 0));
    if (longPct) longPct.textContent = pct + "%";
    if (longFill) longFill.style.width = pct + "%";
    if (longDetail) {
      if (job.status === "error") longDetail.textContent = job.error || "Failed";
      else if (job.status === "done") longDetail.textContent = "Clips ready.";
      else if (job.stage === "downloading") longDetail.textContent = "Downloading your link…";
      else if (job.clips && job.clips.length) longDetail.textContent = "Rendered " + job.clips.length + "…";
      else longDetail.textContent = "Cutting clips…";
    }
    if (longJob && job.id) longJob.href = "/job/" + job.id;
  }

  function longRender(job) {
    longProgress(job);
    if (!job.clips || !job.clips.length) return;
    if (longResults) longResults.style.display = "block";
    if (longTitle) longTitle.textContent = job.clips.length + " clips · ranked by viral chance";
    var banner = "";
    if (job.viralAnalysis) {
      banner =
        '<div class="viral-banner">' +
        '<div class="viral-banner-title">AI viral analysis</div>' +
        '<p>' + esc(job.viralAnalysis.summary || "") + "</p>" +
        '<div class="viral-banner-stats">' +
        "<span>Analyzed <b>" + (job.viralAnalysis.analyzed || 0) + "</b> moments</span>" +
        "<span>High-viral <b>" + (job.viralAnalysis.likelyViral || 0) + "</b></span>" +
        "<span>Top score <b>" + (job.viralAnalysis.topViralScore || 0) + "</b></span>" +
        "</div>" +
        '<p class="muted" style="margin-top:0.5rem;margin-bottom:0">Post in order: #1 first (highest chance to go viral).</p>' +
        "</div>";
    }
    if (longGrid) longGrid.innerHTML = banner + job.clips.map(clipCard).join("");
  }

  if (longFile) {
    longFile.addEventListener("change", function () {
      var f = longFile.files && longFile.files[0];
      if (!f) return;
      if (f.size > 100 * 1024 * 1024) {
        setMsg(longMsg, "File too large (max 100MB).", true);
        return;
      }
      fileObj = f;
      if (longUrl) longUrl.value = "";
      if (longFname) {
        longFname.hidden = false;
        longFname.textContent = f.name;
      }
      setMsg(longMsg, "", false);
    });
  }

  if (longUrl) {
    longUrl.addEventListener("input", function () {
      if ((longUrl.value || "").trim()) {
        fileObj = null;
        if (longFile) longFile.value = "";
        if (longFname) {
          longFname.hidden = true;
          longFname.textContent = "";
        }
      }
    });
  }

  if (longGo) {
    longGo.addEventListener("click", async function () {
      if (longBusy) return;
      var url = ((longUrl && longUrl.value) || "").trim();
      // normalize youtube mobile / shorts
      if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;

      if (!fileObj && !url) {
        setMsg(longMsg, "Add 1 file or paste 1 link first.", true);
        return;
      }

      setMsg(longMsg, fileObj ? "Uploading…" : "Starting download…", false);
      longBusy = true;
      longGo.disabled = true;
      longGo.textContent = "Generating…";
      if (longResults) longResults.style.display = "none";
      if (longGrid) longGrid.innerHTML = "";
      longProgress({ stage: "queued", progress: 5, status: "queued" });

      try {
        var res, data;
        var subsEl = document.getElementById("long-subs");
        var wantSubs = subsEl ? subsEl.checked : true;
        var longStyle = collectSubStyle("long");
        var longTrends = collectTrends("long");
        var longHook = collectHook("long");
        if (fileObj) {
          var fd = new FormData();
          fd.append("video", fileObj, fileObj.name || "video.mp4");
          fd.append("mode", "viral");
          fd.append("genre", window.clipGenre("long"));
          fd.append("subtitles", wantSubs ? "1" : "0");
          fd.append("subColor", longStyle.color);
          fd.append("subSize", longStyle.size);
          fd.append("subPos", longStyle.pos);
          fd.append("subStyle", longStyle.style);
          fd.append("subWords", longStyle.words || "");
          fd.append("trends", longTrends);
          fd.append("hook", longHook.enabled ? "1" : "0");
          fd.append("hookMode", longHook.mode);
          res = await fetch("/api/clip/upload", { method: "POST", body: fd });
        } else {
          res = await fetch("/api/clip/from-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: url,
              mode: "viral",
              genre: window.clipGenre("long"),
              subtitles: wantSubs,
              subColor: longStyle.color,
              subSize: longStyle.size,
              subPos: longStyle.pos,
              subStyle: longStyle.style,
              subWords: longStyle.words || "",
              trends: longTrends,
              hook: longHook.enabled,
              hookMode: longHook.mode,
            }),
          });
        }
        var text = await res.text();
        try {
          data = JSON.parse(text);
        } catch (e) {
          data = null;
        }
        if (!res.ok || !data || !data.ok) {
          var err =
            (data && data.error) ||
            (res.status === 0 ? "Network blocked" : "Request failed (" + res.status + ")");
          setMsg(longMsg, err, true);
          longBusy = false;
          longGo.disabled = false;
          longGo.textContent = "Generate clips";
          return;
        }
        setMsg(longMsg, "Job started…", false);
        if (longPoll) longPoll.stop();
        longPoll = pollJob(data.jobId, {
          onUpdate: longRender,
          onDone: function (job) {
            longRender(job);
            longBusy = false;
            longGo.disabled = false;
            longGo.textContent = "Generate clips";
            setMsg(longMsg, "Done — download clips below.", false);
          },
          onError: function (m) {
            setMsg(longMsg, m, true);
            longBusy = false;
            longGo.disabled = false;
            longGo.textContent = "Generate clips";
          },
        });
      } catch (e) {
        setMsg(longMsg, "Network error: " + (e.message || "could not reach server"), true);
        longBusy = false;
        longGo.disabled = false;
        longGo.textContent = "Generate clips";
      }
    });
  }

  /* ===== RANK: 5 slots ===== */
  var files = [null, null, null, null, null];
  var rankGo = $("rank-go");
  var rankMsg = $("rank-msg");
  var rankBadge = $("rank-badge");
  var rankStatus = $("rank-status");
  var rankStage = $("rank-stage");
  var rankPct = $("rank-pct");
  var rankFill = $("rank-fill");
  var rankDetail = $("rank-detail");
  var rankResults = $("rank-results");
  var rankComp = $("rank-comp");
  var rankTitle = $("rank-title");
  var rankGrid = $("rank-grid");
  var rankJob = $("rank-job");
  var rankNew = $("rank-new");
  var rankBusy = false;
  var rankPoll = null;

  function slotCount() {
    var n = 0;
    for (var i = 0; i < 5; i++) {
      var u = (($("u" + i) && $("u" + i).value) || "").trim();
      if (files[i] || u) n++;
    }
    return n;
  }

  function refreshSlot(i) {
    var st = $("st" + i);
    var nm = $("n" + i);
    var u = (($("u" + i) && $("u" + i).value) || "").trim();
    if (files[i]) {
      if (st) st.textContent = "File";
      if (nm) {
        nm.hidden = false;
        nm.textContent = files[i].name;
      }
    } else if (u) {
      if (st) st.textContent = "Link";
      if (nm) nm.hidden = true;
    } else {
      if (st) st.textContent = "Empty";
      if (nm) {
        nm.hidden = true;
        nm.textContent = "";
      }
    }
    if (rankBadge) rankBadge.textContent = slotCount() + " / 5";
  }

  for (var i = 0; i < 5; i++) {
    (function (idx) {
      var fi = $("f" + idx);
      var ui = $("u" + idx);
      if (fi) {
        fi.addEventListener("change", function () {
          var f = fi.files && fi.files[0];
          if (!f) return;
          files[idx] = f;
          if (ui) ui.value = "";
          refreshSlot(idx);
        });
      }
      if (ui) {
        ui.addEventListener("input", function () {
          if ((ui.value || "").trim()) {
            files[idx] = null;
            if (fi) fi.value = "";
          }
          refreshSlot(idx);
        });
      }
      refreshSlot(idx);
    })(i);
  }

  function rankProgress(job) {
    if (rankStatus) rankStatus.style.display = "block";
    if (rankStage) rankStage.textContent = stageLabel(job.stage || job.status);
    var pct = Math.min(100, Math.max(0, Number(job.progress) || 0));
    if (rankPct) rankPct.textContent = pct + "%";
    if (rankFill) rankFill.style.width = pct + "%";
    if (rankDetail) {
      if (job.status === "error") rankDetail.textContent = job.error || "Failed";
      else if (job.status === "done") rankDetail.textContent = "Your ranking video is ready.";
      else if (job.downloadStatus) rankDetail.textContent = job.downloadStatus;
      else if (job.stage === "building_compilation") rankDetail.textContent = "Stitching one ranking video…";
      else if (job.stage === "downloading") rankDetail.textContent = "Downloading links…";
      else rankDetail.textContent = "AI ranking your videos…";
    }
    if (rankJob && job.id) rankJob.href = "/job/" + job.id;
  }

  function rankRender(job) {
    rankProgress(job);
    if (!job.clips || !job.clips.length) return;
    if (rankResults) rankResults.style.display = "block";
    if (rankTitle) rankTitle.textContent = job.clips.length + " ranked clips";
    if (rankComp) {
      if (job.compilation && job.compilation.url) {
        rankComp.innerHTML =
          '<div class="comp-card"><div class="panel-label">Ranking video (AI)</div>' +
          '<video src="' + esc(job.compilation.url) + '" controls playsinline></video>' +
          '<a class="btn btn-primary btn-block" style="margin-top:0.75rem" href="' +
          esc(job.compilation.url) +
          '" download>Download ranking video</a></div>';
      } else rankComp.innerHTML = "";
    }
    if (rankGrid) rankGrid.innerHTML = job.clips.map(clipCard).join("");
  }

  if (rankGo) {
    rankGo.addEventListener("click", async function () {
      if (rankBusy) return;
      var fileList = [];
      var links = [];
      for (var i = 0; i < 5; i++) {
        var u = (($("u" + i) && $("u" + i).value) || "").trim();
        if (u && !/^https?:\/\//i.test(u)) u = "https://" + u;
        var customName = (($("name" + i) && $("name" + i).value) || "").trim();
        if (files[i]) {
          fileList.push({
            file: files[i],
            label: customName || files[i].name.replace(/\.[^.]+$/, ""),
          });
        } else if (u) {
          links.push({
            url: u,
            hook: customName || "",
            label: customName || "",
          });
        }
      }
      var total = fileList.length + links.length;
      if (total < 2) {
        setMsg(rankMsg, "Fill at least 2 of the 5 slots (file or link).", true);
        return;
      }
      if (fileList.length && links.length) {
        setMsg(rankMsg, "Use either all files or all links — not mixed.", true);
        return;
      }

      setMsg(rankMsg, "Starting…", false);
      rankBusy = true;
      rankGo.disabled = true;
      rankGo.textContent = "Generating…";
      if (rankResults) rankResults.style.display = "none";
      if (rankGrid) rankGrid.innerHTML = "";
      if (rankComp) rankComp.innerHTML = "";
      rankProgress({ stage: "queued", progress: 5, status: "queued" });

      try {
        var res, data, text;
        var boardTitle = (($("rank-title-input") && $("rank-title-input").value) || "").trim() || "Top Videos";
        var rankSubsEl = document.getElementById("rank-subs");
        var wantRankSubs = rankSubsEl ? rankSubsEl.checked : true;
        var rankStyle = collectSubStyle("rank");
        var rankTrends = collectTrends("rank");
        var rankHook = collectHook("rank");
        if (fileList.length) {
          var fd = new FormData();
          fileList.forEach(function (item, idx) {
            fd.append("videos", item.file, item.file.name || "video.mp4");
            fd.append("label_" + idx, item.label || "");
          });
          fd.append("title", boardTitle);
          fd.append("subtitles", wantRankSubs ? "1" : "0");
          fd.append("subColor", rankStyle.color);
          fd.append("subSize", rankStyle.size);
          fd.append("subPos", rankStyle.pos);
          fd.append("subStyle", rankStyle.style);
          fd.append("subWords", rankStyle.words || "");
          fd.append("trends", rankTrends);
          fd.append("hook", rankHook.enabled ? "1" : "0");
          fd.append("hookMode", rankHook.mode);
          res = await fetch("/api/rank/video/upload", { method: "POST", body: fd });
        } else {
          res = await fetch("/api/rank/video/links", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: boardTitle,
              boardTitle: boardTitle,
              links: links,
              subtitles: wantRankSubs,
              subColor: rankStyle.color,
              subSize: rankStyle.size,
              subPos: rankStyle.pos,
              subStyle: rankStyle.style,
              subWords: rankStyle.words || "",
              trends: rankTrends,
              hook: rankHook.enabled,
              hookMode: rankHook.mode,
            }),
          });
        }
        text = await res.text();
        try {
          data = JSON.parse(text);
        } catch (e) {
          data = null;
        }
        if (!res.ok || !data || !data.ok) {
          setMsg(rankMsg, (data && data.error) || "Failed (" + res.status + ")", true);
          rankBusy = false;
          rankGo.disabled = false;
          rankGo.textContent = "Generate ranking video";
          return;
        }
        setMsg(rankMsg, "AI is building your ranking video…", false);
        if (rankPoll) rankPoll.stop();
        rankPoll = pollJob(data.jobId, {
          onUpdate: rankRender,
          onDone: function (job) {
            rankRender(job);
            rankBusy = false;
            rankGo.disabled = false;
            rankGo.textContent = "Generate ranking video";
            setMsg(rankMsg, "Done.", false);
          },
          onError: function (m) {
            setMsg(rankMsg, m, true);
            rankBusy = false;
            rankGo.disabled = false;
            rankGo.textContent = "Generate ranking video";
          },
        });
      } catch (e) {
        setMsg(rankMsg, "Network error: " + (e.message || ""), true);
        rankBusy = false;
        rankGo.disabled = false;
        rankGo.textContent = "Generate ranking video";
      }
    });
  }

  if (rankNew) {
    rankNew.addEventListener("click", function () {
      if (rankPoll) rankPoll.stop();
      rankBusy = false;
      if (rankGo) {
        rankGo.disabled = false;
        rankGo.textContent = "Generate ranking video";
      }
      files = [null, null, null, null, null];
      for (var i = 0; i < 5; i++) {
        var fi = $("f" + i);
        var ui = $("u" + i);
        var ni = $("name" + i);
        if (fi) fi.value = "";
        if (ui) ui.value = "";
        if (ni) ni.value = "";
        refreshSlotUI(i);
      }
      if (rankStatus) rankStatus.style.display = "none";
      if (rankResults) rankResults.style.display = "none";
      if (rankGrid) rankGrid.innerHTML = "";
      if (rankComp) rankComp.innerHTML = "";
      if (rankFill) rankFill.style.width = "0%";
      setMsg(rankMsg, "", false);
      if (rankBadge) rankBadge.textContent = "0 / 5";
    });
  }

  function refreshSlotUI(i) {
    var st = $("st" + i);
    var nm = $("n" + i);
    if (st) st.textContent = "Empty";
    if (nm) {
      nm.hidden = true;
      nm.textContent = "";
    }
  }

  console.log("[Studio] loaded. Mode buttons + generate ready.");
})();
