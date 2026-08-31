/* Clipery - owner dashboard */
(function () {
  var esc = (window.CF && window.CF.escapeHtml) || function (s) { return String(s); };
  var people = [];
  var plans = [];
  var jobs = [];

  function flash(text) {
    var f = document.getElementById("flash");
    f.textContent = text;
    f.style.display = "block";
    setTimeout(function () { f.style.display = "none"; }, 2600);
  }

  async function api(url, body) {
    var res = await fetch(url, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : undefined);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  function stats() {
    var totalClips = jobs.reduce(function (a, j) { return a + (j.clipCount || 0); }, 0);
    var usedThisMonth = people.reduce(function (a, u) { return a + (u.used || 0); }, 0);
    var paying = people.filter(function (u) { return u.plan && u.plan !== "free"; }).length;
    document.getElementById("stats").innerHTML =
      card(people.length, "accounts") +
      card(paying, "on a paid plan") +
      card(jobs.length, "jobs made") +
      card(totalClips, "clips rendered") +
      card(usedThisMonth, "videos this month");
  }
  function card(n, label) {
    return '<div class="stat"><b>' + n + "</b><span>" + label + "</span></div>";
  }

  function renderPeople() {
    var rows = people.map(function (u) {
      var limit = u.limit === null ? "unlimited" : u.limit;
      var pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 0;
      var options = plans.map(function (p) {
        return '<option value="' + p.id + '"' + (p.id === u.plan ? " selected" : "") + ">" + esc(p.label) + "</option>";
      }).join("");
      return (
        "<tr data-id='" + u.id + "'>" +
        "<td><b>" + esc(u.name || u.email) + "</b><br><span style='color:#66627a;font-size:.78rem'>" + esc(u.email) + "</span></td>" +
        '<td><span class="pill ' + esc(u.plan) + '">' + esc(u.planLabel) + "</span>" +
        (u.role === "owner" ? ' <span class="pill owner">owner</span>' : "") + "</td>" +
        "<td>" + u.used + " / " + limit +
        '<div class="bar"><i style="width:' + pct + '%"></i></div></td>' +
        "<td>" + (u.bonusVideos ? "+" + u.bonusVideos : "-") + "</td>" +
        '<td><select data-plan>' + options + "</select></td>" +
        '<td><input type="number" data-bonus value="10" min="1" /> ' +
        '<button class="mini" data-give>Give</button></td>' +
        '<td><button class="mini ghost" data-reset>Reset usage</button></td>' +
        "</tr>"
      );
    });
    document.getElementById("people").innerHTML =
      rows.join("") || '<tr><td colspan="7" class="empty">No accounts yet.</td></tr>';
  }

  function renderVideos() {
    var box = document.getElementById("videos");
    var cards = [];
    jobs.forEach(function (j) {
      (j.clips || []).forEach(function (c) {
        cards.push(
          '<div class="vid">' +
          '<video src="' + esc(c.url) + '" controls preload="metadata"></video>' +
          '<div class="meta">' +
          '<div class="who">' + esc(j.ownerEmail) + "</div>" +
          '<div class="nm">' + esc(c.title || j.sourceName || "clip") + "</div>" +
          '<div class="sc">score ' + (c.score || "-") + " &middot; " +
          new Date(j.createdAt).toLocaleDateString() + "</div>" +
          "</div></div>"
        );
      });
      if (j.compilation) {
        cards.push(
          '<div class="vid">' +
          '<video src="' + esc(j.compilation) + '" controls preload="metadata"></video>' +
          '<div class="meta"><div class="who">' + esc(j.ownerEmail) + "</div>" +
          '<div class="nm">Ranking video</div>' +
          '<div class="sc">' + new Date(j.createdAt).toLocaleDateString() + "</div></div></div>"
        );
      }
    });
    box.innerHTML = cards.join("") || '<p class="empty">No videos rendered yet.</p>';
  }

  document.getElementById("people").addEventListener("change", async function (e) {
    if (!e.target.hasAttribute("data-plan")) return;
    var id = e.target.closest("tr").getAttribute("data-id");
    try {
      await api("/api/admin/plan", { userId: id, plan: e.target.value });
      flash("Plan updated");
      await load();
    } catch (err) { flash(err.message); }
  });

  document.getElementById("people").addEventListener("click", async function (e) {
    var row = e.target.closest("tr");
    if (!row) return;
    var id = row.getAttribute("data-id");
    try {
      if (e.target.hasAttribute("data-give")) {
        var n = row.querySelector("[data-bonus]").value;
        await api("/api/admin/bonus", { userId: id, videos: n });
        flash("Gave " + n + " extra videos");
        await load();
      }
      if (e.target.hasAttribute("data-reset")) {
        await api("/api/admin/reset-usage", { userId: id });
        flash("Usage reset");
        await load();
      }
    } catch (err) { flash(err.message); }
  });

  Array.prototype.forEach.call(document.querySelectorAll(".adm-tab"), function (t) {
    t.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll(".adm-tab"), function (x) {
        x.classList.toggle("on", x === t);
      });
      var tab = t.getAttribute("data-tab");
      document.getElementById("tab-people").hidden = tab !== "people";
      document.getElementById("tab-videos").hidden = tab !== "videos";
    });
  });

  async function load() {
    try {
      var u = await api("/api/admin/users");
      people = u.users;
      plans = u.plans;
      var j = await api("/api/admin/jobs");
      jobs = j.jobs;
      stats();
      renderPeople();
      renderVideos();
    } catch (err) {
      document.querySelector(".adm").innerHTML =
        '<p class="empty">' + esc(err.message) + "</p>";
    }
  }

  load();
})();
