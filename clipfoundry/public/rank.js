(function () {
  "use strict";

  function $(id) {
    return document.getElementById(id);
  }

  function on(el, ev, fn) {
    if (el) el.addEventListener(ev, fn);
  }

  const CF = window.CF || {
    escapeHtml: function (s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    },
    stageLabel: function (s) {
      return s || "Working…";
    },
    renderClipCard: function (c) {
      return (
        '<article class="clip-card"><video src="' +
        CF.escapeHtml(c.url) +
        '" controls playsinline></video><div class="clip-card-body"><strong>#' +
        c.rank +
        " · " +
        c.score +
        "</strong><div class='meta'>" +
        CF.escapeHtml(c.title || "") +
        '</div><a href="' +
        CF.escapeHtml(c.url) +
        '" download>Download</a></div></article>'
      );
    },
    api: async function (path, opts) {
      const res = await fetch(path, opts);
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
      return { res: res, data: data };
    },
    createPoller: function (jobId, hooks) {
      var timer = null;
      function stop() {
        if (timer) clearInterval(timer);
        timer = null;
      }
      async function tick() {
        try {
          var r = await CF.api("/api/clip/status/" + jobId);
          if (!r.res.ok || !r.data || !r.data.ok) {
            if (hooks.onError) hooks.onError((r.data && r.data.error) || "Status failed");
            stop();
            return;
          }
          var job = r.data.job;
          if (hooks.onUpdate) hooks.onUpdate(job);
          if (job.status === "done") {
            if (hooks.onDone) hooks.onDone(job);
            stop();
          } else if (job.status === "error") {
            if (hooks.onError) hooks.onError(job.error || "Failed");
            stop();
          }
        } catch (e) {
          if (hooks.onError) hooks.onError("Network error");
          stop();
        }
      }
      tick();
      timer = setInterval(tick, 1000);
      return { stop: stop };
    },
  };

  var tabUpload = $("tab-upload");
  var tabLinks = $("tab-links");
  var paneUpload = $("pane-upload");
  var paneLinks = $("pane-links");
  var multiInput = $("multi-input");
  var multiLabel = $("multi-label");
  var fileList = $("file-list");
  var btnMulti = $("btn-multi-upload");
  var upMsg = $("up-msg");
  var pasteEl = $("vr-paste");
  var btnLinks = $("vr-submit");
  var vrMsg = $("vr-msg");
  var vrStatus = $("vr-status");
  var vrStage = $("vr-stage");
  var vrPct = $("vr-pct");
  var vrFill = $("vr-fill");
  var vrDetail = $("vr-detail");
  var vrResults = $("vr-results");
  var vrGrid = $("vr-grid");
  var vrTitle = $("vr-title");
  var vrOpenJob = $("vr-open-job");
  var compHost = $("comp-host");
  var btnAgain = $("btn-again");

  var multiFiles = [];
  var poller = null;
  var busy = false;

  function showMsg(el, text, isError) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "form-msg" + (text && isError ? " error" : text ? " success" : "");
  }

  function setTab(which) {
    var upload = which === "upload";
    if (tabUpload) tabUpload.classList.toggle("active", upload);
    if (tabLinks) tabLinks.classList.toggle("active", !upload);
    if (paneUpload) paneUpload.style.display = upload ? "block" : "none";
    if (paneLinks) paneLinks.style.display = upload ? "none" : "block";
  }

  on(tabUpload, "click", function () {
    setTab("upload");
  });
  on(tabLinks, "click", function () {
    setTab("links");
  });

  function setBusy(b) {
    busy = b;
    if (btnMulti) {
      btnMulti.disabled = b;
      btnMulti.textContent = b ? "Working…" : "Create ranking video";
    }
    if (btnLinks) {
      btnLinks.disabled = b;
      btnLinks.textContent = b ? "Working…" : "Create ranking video from links";
    }
    if (multiInput) multiInput.disabled = b;
    if (pasteEl) pasteEl.disabled = b;
  }

  function updateProgress(job) {
    if (vrStatus) vrStatus.style.display = "block";
    if (vrStage) vrStage.textContent = CF.stageLabel(job.stage || job.status);
    var pct = Math.min(100, Math.max(0, Number(job.progress) || 0));
    if (vrPct) vrPct.textContent = pct + "%";
    if (vrFill) vrFill.style.width = pct + "%";
    if (vrDetail) {
      if (job.status === "error") vrDetail.textContent = job.error || "Failed";
      else if (job.status === "done") vrDetail.textContent = "Done — download below.";
      else if (job.downloadStatus) vrDetail.textContent = job.downloadStatus;
      else vrDetail.textContent = "Scoring and building your ranking video…";
    }
    if (vrOpenJob && job.id) vrOpenJob.href = "/job/" + job.id;
  }

  function renderJob(job) {
    updateProgress(job);
    if (!job.clips || !job.clips.length) return;
    if (vrResults) vrResults.style.display = "block";
    if (vrTitle) vrTitle.textContent = job.clips.length + " ranked clips";

    if (compHost) {
      if (job.compilation && job.compilation.url) {
        compHost.innerHTML =
          '<div class="comp-card">' +
          '<div class="panel-label">Your ranking video</div>' +
          '<video src="' +
          CF.escapeHtml(job.compilation.url) +
          '" controls playsinline preload="metadata"></video>' +
          '<a class="btn btn-primary btn-block" style="margin-top:0.75rem" href="' +
          CF.escapeHtml(job.compilation.url) +
          '" download="' +
          CF.escapeHtml(job.compilation.downloadName || "ranking.mp4") +
          '">Download ranking video</a></div>';
      } else {
        compHost.innerHTML = "";
      }
    }

    if (vrGrid) vrGrid.innerHTML = job.clips.map(CF.renderClipCard).join("");

    if (job.errors && job.errors.length && vrDetail) {
      vrDetail.textContent =
        job.errors.length +
        " failed: " +
        job.errors
          .map(function (e) {
            return e.error || "";
          })
          .join(" · ");
    }
  }

  function startPoll(jobId) {
    if (poller) poller.stop();
    poller = CF.createPoller(jobId, {
      onUpdate: renderJob,
      onDone: function (job) {
        renderJob(job);
        setBusy(false);
        showMsg(upMsg, "Finished.", false);
        showMsg(vrMsg, "Finished.", false);
      },
      onError: function (msg) {
        showMsg(upMsg, msg, true);
        showMsg(vrMsg, msg, true);
        setBusy(false);
        CF.api("/api/clip/status/" + jobId).then(function (r) {
          if (r.data && r.data.job) renderJob(r.data.job);
        });
      },
    });
  }

  function resetUI() {
    if (poller) poller.stop();
    if (vrStatus) vrStatus.style.display = "none";
    if (vrResults) vrResults.style.display = "none";
    if (vrGrid) vrGrid.innerHTML = "";
    if (compHost) compHost.innerHTML = "";
    if (vrFill) vrFill.style.width = "0%";
    showMsg(upMsg, "", false);
    showMsg(vrMsg, "", false);
    setBusy(false);
  }

  on(btnAgain, "click", resetUI);

  function onMultiFiles(list) {
    multiFiles = Array.prototype.slice.call(list || [], 0, 12);
    if (multiLabel) {
      multiLabel.textContent = multiFiles.length
        ? multiFiles.length + " file" + (multiFiles.length > 1 ? "s" : "") + " selected — tap to change"
        : "Tap here to choose videos";
    }
    if (fileList) {
      if (!multiFiles.length) {
        fileList.innerHTML = "";
      } else {
        fileList.innerHTML = multiFiles
          .map(function (f, i) {
            var mb = (f.size / (1024 * 1024)).toFixed(1);
            return (
              "<li><span>" +
              (i + 1) +
              ".</span> " +
              CF.escapeHtml(f.name) +
              ' <em style="color:var(--text-dim);font-style:normal">(' +
              mb +
              " MB)</em></li>"
            );
          })
          .join("");
      }
    }
    showMsg(upMsg, multiFiles.length ? multiFiles.length + " ready. Press Create." : "", false);
  }

  on(multiInput, "change", function () {
    onMultiFiles(multiInput.files);
  });

  // Drag-drop on the upload box
  var uploadBox = $("upload-box");
  if (uploadBox) {
    ["dragenter", "dragover"].forEach(function (ev) {
      on(uploadBox, ev, function (e) {
        e.preventDefault();
        uploadBox.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      on(uploadBox, ev, function (e) {
        e.preventDefault();
        uploadBox.classList.remove("dragover");
      });
    });
    on(uploadBox, "drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        onMultiFiles(e.dataTransfer.files);
        // Also try to assign to input for consistency (may fail on some browsers)
        try {
          multiInput.files = e.dataTransfer.files;
        } catch (err) {}
      }
    });
  }

  on(btnMulti, "click", async function () {
    if (busy) return;
    if (!multiFiles.length) {
      showMsg(upMsg, "Choose at least 1 video first (tap the upload box above).", true);
      if (multiInput) multiInput.click();
      return;
    }
    showMsg(upMsg, "Uploading " + multiFiles.length + " video(s)…", false);
    setBusy(true);
    if (vrResults) vrResults.style.display = "none";
    updateProgress({ stage: "queued", progress: 5, status: "queued" });

    try {
      var fd = new FormData();
      for (var i = 0; i < multiFiles.length; i++) {
        fd.append("videos", multiFiles[i], multiFiles[i].name || "video" + i + ".mp4");
      }
      var r = await fetch("/api/rank/video/upload", { method: "POST", body: fd });
      var data = null;
      try {
        data = await r.json();
      } catch (e) {
        data = null;
      }
      if (!r.ok || !data || !data.ok) {
        showMsg(upMsg, (data && data.error) || "Upload failed (" + r.status + ")", true);
        setBusy(false);
        return;
      }
      showMsg(upMsg, "Upload received. Building ranking…", false);
      startPoll(data.jobId);
    } catch (e) {
      showMsg(upMsg, "Network error: " + (e.message || "could not reach server"), true);
      setBusy(false);
    }
  });

  on(btnLinks, "click", async function () {
    if (busy) return;
    var paste = ((pasteEl && pasteEl.value) || "").trim();
    if (!paste) {
      showMsg(vrMsg, "Paste at least one video link.", true);
      return;
    }
    var lines = paste.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) {
      showMsg(vrMsg, "Paste at least one video link.", true);
      return;
    }
    showMsg(vrMsg, "Starting with " + lines.length + " link(s)…", false);
    setBusy(true);
    if (vrResults) vrResults.style.display = "none";
    updateProgress({ stage: "queued", progress: 5, status: "queued" });

    try {
      var r = await fetch("/api/rank/video/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paste: paste }),
      });
      var data = null;
      try {
        data = await r.json();
      } catch (e) {
        data = null;
      }
      if (!r.ok || !data || !data.ok) {
        showMsg(vrMsg, (data && data.error) || "Could not start (" + r.status + ")", true);
        setBusy(false);
        return;
      }
      showMsg(vrMsg, "Job started. Downloading / ranking…", false);
      startPoll(data.jobId);
    } catch (e) {
      showMsg(vrMsg, "Network error: " + (e.message || "could not reach server"), true);
      setBusy(false);
    }
  });

  // Year stamp
  var y = $("year");
  if (y) y.textContent = String(new Date().getFullYear());

  // Active nav
  document.querySelectorAll("[data-nav]").forEach(function (a) {
    if ((a.getAttribute("href") || "") === "/rank") a.classList.add("active");
  });

  console.log("[Clipery] Rank page ready");
})();
