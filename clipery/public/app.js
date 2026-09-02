(function () {
  const header = document.getElementById("header");
  const form = document.getElementById("waitlist-form");
  const formMsg = document.getElementById("form-msg");
  const submitBtn = document.getElementById("submit-btn");
  const countEl = document.getElementById("waitlist-count");
  const success = document.getElementById("form-success");
  const successText = document.getElementById("success-text");
  const positionBadge = document.getElementById("position-badge");
  const yearEl = document.getElementById("year");

  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  window.addEventListener(
    "scroll",
    function () {
      if (!header) return;
      header.classList.toggle("scrolled", window.scrollY > 8);
    },
    { passive: true }
  );

  async function refreshCount() {
    try {
      const res = await fetch("/api/waitlist");
      if (!res.ok) return;
      const data = await res.json();
      if (countEl && typeof data.count === "number") {
        countEl.textContent = String(data.count);
      }
    } catch (_) {
      /* offline / first paint */
    }
  }

  refreshCount();

  if (form) {
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      formMsg.textContent = "";
      formMsg.className = "form-msg";

      const email = (form.email.value || "").trim();
      const name = (form.name.value || "").trim();
      const role = form.role.value;
      const interest = form.interest.value;

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        formMsg.textContent = "Please enter a valid email.";
        formMsg.classList.add("error");
        form.email.focus();
        return;
      }

      submitBtn.disabled = true;
      const prev = submitBtn.textContent;
      submitBtn.textContent = "Joining…";

      try {
        const res = await fetch("/api/waitlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            name,
            role,
            interest,
            source: "landing",
          }),
        });
        const data = await res.json();

        if (!res.ok || !data.ok) {
          formMsg.textContent = data.error || "Something went wrong. Try again.";
          formMsg.classList.add("error");
          submitBtn.disabled = false;
          submitBtn.textContent = prev;
          return;
        }

        form.classList.add("hide");
        success.classList.add("show");
        positionBadge.textContent = "#" + data.position;
        successText.textContent = data.already
          ? "You were already on the list — we kept your original spot."
          : "We’ll email you when your early-access seat opens.";

        if (countEl && typeof data.count === "number") {
          countEl.textContent = String(data.count);
        }
      } catch (_) {
        formMsg.textContent = "Network error. Check your connection and try again.";
        formMsg.classList.add("error");
        submitBtn.disabled = false;
        submitBtn.textContent = prev;
      }
    });
  }

  // -------- Clip demo --------
  const btnSample = document.getElementById("btn-sample");
  const btnUpload = document.getElementById("btn-upload");
  const btnReset = document.getElementById("btn-reset-demo");
  const videoInput = document.getElementById("video-input");
  const dropzone = document.getElementById("dropzone");
  const dropLabel = document.getElementById("drop-label");
  const statusBox = document.getElementById("clip-status");
  const statusStage = document.getElementById("status-stage");
  const statusPct = document.getElementById("status-pct");
  const statusDetail = document.getElementById("status-detail");
  const progressFill = document.getElementById("progress-fill");
  const results = document.getElementById("clip-results");
  const resultsTitle = document.getElementById("results-title");
  const clipGrid = document.getElementById("clip-grid");
  const clipError = document.getElementById("clip-error");

  let selectedFile = null;
  let pollTimer = null;

  function stageLabel(stage) {
    const map = {
      queued: "Queued",
      probing: "Reading video",
      detecting_moments: "Detecting moments",
      scoring: "Scoring clips",
      listening: "Listening to the audio",
      watching: "Watching the picture",
      checking_context: "Checking context and payoff",
      rendering: "Rendering vertical clips",
      complete: "Done",
      processing: "Processing",
    };
    return map[stage] || stage || "Working…";
  }

  function setBusy(isBusy) {
    if (btnSample) btnSample.disabled = isBusy;
    if (btnUpload) btnUpload.disabled = isBusy || !selectedFile;
  }

  function showError(msg) {
    if (!clipError) return;
    clipError.hidden = !msg;
    clipError.textContent = msg || "";
    clipError.classList.toggle("error-text", !!msg);
  }

  function renderClips(job) {
    if (!clipGrid || !results) return;
    clipGrid.innerHTML = "";
    (job.clips || []).forEach(function (c) {
      const card = document.createElement("article");
      card.className = "clip-card";
      const start = formatTime(c.start);
      const end = formatTime(c.end);
      card.innerHTML =
        '<video src="' +
        c.url +
        '" controls playsinline preload="metadata"></video>' +
        '<div class="clip-card-body">' +
        '<div class="clip-card-top">' +
        '<span class="clip-rank-pill">#' +
        c.rank +
        "</span>" +
        '<span class="clip-score-pill">' +
        c.score +
        " score</span>" +
        "</div>" +
        "<h4>" +
        escapeHtml(c.title) +
        "</h4>" +
        '<div class="meta">' +
        start +
        " → " +
        end +
        " · " +
        c.duration +
        "s</div>" +
        '<a href="' +
        c.url +
        '" download>Download MP4</a>' +
        "</div>";
      clipGrid.appendChild(card);
    });
    results.hidden = false;
    if (resultsTitle) {
      resultsTitle.textContent =
        (job.clips || []).length +
        " ranked clips" +
        (job.sourceName ? " · " + job.sourceName : "");
    }
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ":" + String(r).padStart(2, "0");
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function updateProgress(job) {
    if (statusBox) statusBox.hidden = false;
    if (statusStage) {
      statusStage.textContent =
        stageLabel(job.stage || job.status) +
        (job.stageNote ? " (" + String(job.stageNote).replace(/^.*- /, "") + ")" : "");
    }
    const pct = Math.min(100, Math.max(0, Number(job.progress) || 0));
    if (statusPct) statusPct.textContent = pct + "%";
    if (progressFill) progressFill.style.width = pct + "%";
    if (statusDetail) {
      if (job.status === "error") {
        statusDetail.textContent = job.error || "Failed.";
      } else if (job.clips && job.clips.length && job.status !== "done") {
        statusDetail.textContent =
          "Rendered " + job.clips.length + " clip(s) so far…";
      } else if (job.status === "done") {
        statusDetail.textContent = "All clips ready. Play them below.";
      } else {
        statusDetail.textContent =
          "Scene detection → score → 9:16 export. Usually under a minute for short videos.";
      }
    }
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollJob(jobId) {
    stopPoll();
    const tick = async function () {
      try {
        const res = await fetch("/api/clip/status/" + jobId);
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showError((data && data.error) || "Could not read job status.");
          setBusy(false);
          stopPoll();
          return;
        }
        const job = data.job;
        updateProgress(job);
        if (job.clips && job.clips.length) renderClips(job);
        if (job.status === "done") {
          setBusy(false);
          stopPoll();
          showError("");
        } else if (job.status === "error") {
          setBusy(false);
          stopPoll();
          showError(job.error || "Clipping failed.");
        }
      } catch (_) {
        showError("Lost connection while polling. Retry in a moment.");
        setBusy(false);
        stopPoll();
      }
    };
    await tick();
    pollTimer = setInterval(tick, 1200);
  }

  async function startSample() {
    showError("");
    if (results) results.hidden = true;
    if (clipGrid) clipGrid.innerHTML = "";
    setBusy(true);
    updateProgress({ stage: "queued", progress: 2, status: "queued" });
    try {
      const res = await fetch("/api/clip/sample", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showError((data && data.error) || "Could not start sample job.");
        setBusy(false);
        return;
      }
      pollJob(data.jobId);
    } catch (_) {
      showError("Network error starting sample.");
      setBusy(false);
    }
  }

  async function startUpload() {
    if (!selectedFile) return;
    showError("");
    if (results) results.hidden = true;
    if (clipGrid) clipGrid.innerHTML = "";
    setBusy(true);
    updateProgress({ stage: "queued", progress: 2, status: "queued" });
    try {
      const fd = new FormData();
      fd.append("video", selectedFile, selectedFile.name);
      const res = await fetch("/api/clip/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showError((data && data.error) || "Upload failed.");
        setBusy(false);
        return;
      }
      pollJob(data.jobId);
    } catch (_) {
      showError("Network error during upload.");
      setBusy(false);
    }
  }

  if (btnSample) btnSample.addEventListener("click", startSample);
  if (btnUpload) btnUpload.addEventListener("click", startUpload);
  if (btnReset) {
    btnReset.addEventListener("click", function () {
      stopPoll();
      setBusy(false);
      if (statusBox) statusBox.hidden = true;
      if (results) results.hidden = true;
      if (clipGrid) clipGrid.innerHTML = "";
      showError("");
      if (progressFill) progressFill.style.width = "0%";
    });
  }

  function onFile(file) {
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) {
      showError("File is over 100MB. Trim it or compress first.");
      return;
    }
    selectedFile = file;
    if (dropLabel) dropLabel.textContent = file.name;
    if (btnUpload) btnUpload.disabled = false;
    showError("");
  }

  if (videoInput) {
    videoInput.addEventListener("change", function () {
      onFile(videoInput.files && videoInput.files[0]);
    });
  }

  if (dropzone) {
    ["dragenter", "dragover"].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) {
        e.preventDefault();
        dropzone.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) {
        e.preventDefault();
        dropzone.classList.remove("dragover");
      });
    });
    dropzone.addEventListener("drop", function (e) {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      onFile(f);
    });
  }
})();
