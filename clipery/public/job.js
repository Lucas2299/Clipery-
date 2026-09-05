(function () {
  const CF = window.CF;

  function jobIdFromPath() {
    const parts = location.pathname.split("/").filter(Boolean);
    // /job/abc or /job.html?id=
    if (parts[0] === "job" && parts[1]) return parts[1];
    return new URLSearchParams(location.search).get("id");
  }

  const id = jobIdFromPath();
  const title = CF.$("#job-title");
  const meta = CF.$("#job-meta");
  const statusBox = CF.$("#status-box");
  const statusStage = CF.$("#status-stage");
  const statusPct = CF.$("#status-pct");
  const statusDetail = CF.$("#status-detail");
  const progressFill = CF.$("#progress-fill");
  const errEl = CF.$("#job-error");
  const clipsHost = CF.$("#clips-host");
  const tableHost = CF.$("#table-host");
  const compHost = CF.$("#comp-host");
  const errorsHost = CF.$("#errors-host");

  if (!id) {
    if (title) title.textContent = "Job not found";
    if (errEl) errEl.textContent = "Missing job id. Open a job from the library.";
    return;
  }

  var delBtn = null;
  function ensureDelete(job) {
    if (delBtn || !meta || !meta.parentNode) return;
    delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "job-del job-del-page";
    delBtn.textContent = "Delete this video";
    delBtn.addEventListener("click", async function () {
      if (!confirm("Delete this video and all its clips? This cannot be undone.")) return;
      delBtn.disabled = true;
      delBtn.textContent = "Deleting...";
      try {
        var res = await fetch("/api/clip/" + encodeURIComponent(job.id), { method: "DELETE" });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok || !data.ok) throw new Error(data.error || "Could not delete.");
        location.href = "/library";
      } catch (e) {
        alert(e.message);
        delBtn.disabled = false;
        delBtn.textContent = "Delete this video";
      }
    });
    meta.parentNode.appendChild(delBtn);
  }

  function render(job) {
    ensureDelete(job);
    document.title = (job.sourceName || "Job") + " · Clipery";
    if (title) title.textContent = job.sourceName || "Clip job";
    if (meta) {
      meta.textContent =
        "ID " +
        job.id +
        " · " +
        (job.modeLabel || job.mode || "") +
        " · " +
        CF.formatDate(job.createdAt) +
        (job.duration ? " · source " + Math.round(job.duration) + "s" : "") +
        " · " +
        (job.status || "");
    }

    if (job.status === "processing" || job.status === "queued") {
      statusBox.classList.remove("hide");
      statusStage.textContent =
        CF.stageLabel(job.stage || job.status) +
        (job.stageNote ? " (" + String(job.stageNote).replace(/^.*- /, "") + ")" : "");
      const pct = Math.min(100, Math.max(0, Number(job.progress) || 0));
      statusPct.textContent = pct + "%";
      progressFill.style.width = pct + "%";
      statusDetail.textContent = "Still working — this page updates live.";
    } else {
      statusBox.classList.add("hide");
    }

    if (job.status === "review") {
      errEl.innerHTML =
        'This video is waiting for your review. <a href="/studio?tool=editor&job=' +
        encodeURIComponent(job.id) +
        '" style="color:var(--accent-2);font-weight:600">Open it in the Editor</a> to adjust the clips and render.';
    } else if (job.status === "error") {
      errEl.textContent = job.error || "Job failed";
    } else {
      errEl.textContent = "";
    }

    if (compHost) {
      if (job.compilation && job.compilation.url) {
        compHost.innerHTML =
          '<div class="panel-label">Full ranking video</div>' +
          '<div class="clip-card" style="max-width:280px">' +
          '<video src="' +
          CF.escapeHtml(job.compilation.url) +
          '" controls playsinline preload="metadata" style="max-height:420px;object-fit:contain;background:#000"></video>' +
          '<div class="clip-card-body"><h4>' +
          CF.escapeHtml(job.compilation.title || "Countdown ranking") +
          '</h4><div class="clip-actions"><a href="' +
          CF.escapeHtml(job.compilation.url) +
          '" download>Download</a></div></div></div>';
      } else {
        compHost.innerHTML = "";
      }
    }

    if (job.clips && job.clips.length) {
      clipsHost.innerHTML =
        '<div class="panel-label">Ranked clips (one per video)</div><div class="clip-grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">' +
        job.clips.map(CF.renderClipCard).join("") +
        "</div>";
    } else if (job.status === "done") {
      clipsHost.innerHTML = '<div class="empty">No clips produced.</div>';
    }

    if (job.rankings && job.rankings.length) {
      tableHost.innerHTML =
        '<div class="panel-label">Full ranking</div>' + CF.renderRankTable(job.rankings);
    }

    if (errorsHost) {
      if (job.errors && job.errors.length) {
        errorsHost.innerHTML =
          '<div class="card"><strong style="color:#ff7b8a">Failed items</strong><ul style="margin:0.5rem 0 0 1rem;color:var(--text-muted)">' +
          job.errors
            .map(function (e) {
              return (
                "<li>" +
                CF.escapeHtml(e.url || e.label || "") +
                " — " +
                CF.escapeHtml(e.error || "") +
                "</li>"
              );
            })
            .join("") +
          "</ul></div>";
      } else {
        errorsHost.innerHTML = "";
      }
    }
  }

  CF.createPoller(id, {
    onUpdate: render,
    onDone: render,
    onError: function (m) {
      // If finished with error status it's still a job; try one fetch
      CF.api("/api/clip/status/" + id).then(function (r) {
        if (r.data && r.data.job) render(r.data.job);
        else if (errEl) errEl.textContent = m;
      });
    },
  });
})();
