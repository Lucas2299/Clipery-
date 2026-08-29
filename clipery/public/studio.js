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
    return { color: gv("color"), size: gv("size"), pos: gv("pos"), style: gv("style") };
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
  wireSubToggle("long-subs", "long-substyle");
  wireSubToggle("rank-subs", "rank-substyle");

  function collectHook(prefix) {
    var t = $(prefix + "-hook");
    var m = $(prefix + "-hook-mode");
    return { enabled: !!(t && t.checked), mode: m ? m.value : "intro" };
  }

  function wireHookToggle(prefix) {
    var t = $(prefix + "-hook");
    var g = $(prefix + "-hookgrid");
    var pv = $(prefix + "-sub-preview");
    if (!t) return;
    function sync() {
      if (g) g.classList.toggle("subs-off", !t.checked);
      if (pv) {
        var chip = pv.querySelector(".sub-preview-hook");
        if (chip) chip.hidden = !t.checked;
      }
    }
    t.addEventListener("change", sync);
    sync();
  }
  wireHookToggle("long");
  wireHookToggle("rank");

  /* --- live subtitle style preview --- */
  var SUB_PREV = {
    colors: {
      white: "#ffffff", yellow: "#FFE74C", pink: "#FF4D6D", orange: "#FF8A4C",
      red: "#FF3B3B", green: "#30D158", cyan: "#3CD4F5", blue: "#4C8AFF", purple: "#A86BFF"
    },
    sizes: { small: 9, medium: 11 },
    pos: { bottom: "68%", middle: "38%", top: "8%" },
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
    cap.style.fontSize = (SUB_PREV.sizes[s.size] || 11) + "px";
    cap.style.top = SUB_PREV.pos[s.pos] || "68%";
    frame.classList.toggle("box", s.style === "box");
    frame.classList.toggle("pop", s.style === "pop");
    var shadow = s.style === "box" ? "none" : "0 0 3px rgba(0,0,0,.95), 0 0 3px rgba(0,0,0,.95)";
    cap.style.textTransform = (s.style === "hormozi" || s.style === "mrbeast") ? "uppercase" : "none";
    var spans = cap.querySelectorAll(".lit, .dim");
    for (var i = 0; i < spans.length; i++) {
      var w = spans[i];
      var isDim = w.className === "dim";
      if (isDim) {
        // upcoming: hidden for pop/mrbeast, white for highlight/hormozi, full-colour for classic
        if (s.style === "pop" || s.style === "mrbeast") { w.style.color = "#fff"; w.style.opacity = "0"; }
        else if (s.style === "classic") { w.style.color = col; w.style.opacity = "1"; }
        else if (s.style === "highlight" || s.style === "hormozi") { w.style.color = "#fff"; w.style.opacity = "1"; }
        else { w.style.color = "#fff"; w.style.opacity = "0.45"; }
        w.style.textShadow = shadow;
      } else {
        w.style.opacity = "1";
        w.style.color = s.style === "rainbow" ? SUB_PREV.rainbow[i % SUB_PREV.rainbow.length]
          : s.style === "mrbeast" ? SUB_PREV.beast[i % SUB_PREV.beast.length]
          : col;
        w.style.textShadow = shadow;
      }
    }
  }

  var TEMPLATES = {
    tiktok:  { color: "white",  size: "medium", pos: "bottom", style: "outline" },
    beast:   { color: "yellow", size: "medium", pos: "middle", style: "outline" },
    candy:   { color: "pink",   size: "medium", pos: "middle", style: "pop" },
    rainbow: { color: "pink",   size: "medium", pos: "bottom", style: "rainbow" },
    news:    { color: "white",  size: "small",  pos: "top",    style: "box" },
    goldbox: { color: "yellow", size: "medium", pos: "bottom", style: "box" },
    glow:    { color: "orange", size: "medium", pos: "middle", style: "highlight" },
    clean:   { color: "white",  size: "small",  pos: "bottom", style: "classic" },
    hormozi: { color: "yellow", size: "medium", pos: "middle", style: "hormozi" },
    mrbeast: { color: "yellow", size: "medium", pos: "middle", style: "mrbeast" },
    reels:   { color: "yellow", size: "medium", pos: "middle", style: "highlight" }
  };

  function clearTplChips(prefix) {
    var row = $(prefix + "-templates");
    if (!row) return;
    var chips = row.querySelectorAll(".tpl-chip");
    for (var j = 0; j < chips.length; j++) chips[j].classList.remove("active");
  }

  function wireTemplates(prefix) {
    var row = $(prefix + "-templates");
    if (!row) return;
    var chips = row.querySelectorAll(".tpl-chip");
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener("click", function (ev) {
        var t = TEMPLATES[ev.currentTarget.getAttribute("data-tpl")];
        if (!t) return;
        var keys = ["color", "size", "pos", "style"];
        for (var k = 0; k < keys.length; k++) {
          var sel = $(prefix + "-sub-" + keys[k]);
          if (sel) sel.value = t[keys[k]];
        }
        clearTplChips(prefix);
        ev.currentTarget.classList.add("active");
        updateSubPreview(prefix);
      });
    }
  }

  function wireSubPreview(prefix) {
    var keys = ["color", "size", "pos", "style"];
    for (var i = 0; i < keys.length; i++) {
      var el = $(prefix + "-sub-" + keys[i]);
      if (el) {
        el.addEventListener("change", function () {
          clearTplChips(prefix);
          updateSubPreview(prefix);
        });
      }
    }
    wireTemplates(prefix);
    updateSubPreview(prefix);
  }
  wireSubPreview("long");
  wireSubPreview("rank");

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
      '<div class="meta">' + esc(c.postTip || "") + "</div>" +
      (reasons.length
        ? '<ul class="viral-reasons">' +
          reasons.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") +
          "</ul>"
        : "") +
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
    if (longStage) longStage.textContent = stageLabel(job.stage || job.status);
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
        var longHook = collectHook("long");
        if (fileObj) {
          var fd = new FormData();
          fd.append("video", fileObj, fileObj.name || "video.mp4");
          fd.append("mode", "viral");
          fd.append("subtitles", wantSubs ? "1" : "0");
          fd.append("subColor", longStyle.color);
          fd.append("subSize", longStyle.size);
          fd.append("subPos", longStyle.pos);
          fd.append("subStyle", longStyle.style);
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
              subtitles: wantSubs,
              subColor: longStyle.color,
              subSize: longStyle.size,
              subPos: longStyle.pos,
              subStyle: longStyle.style,
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
