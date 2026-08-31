/* Clipery — login / register page */
(function () {
  var form = document.getElementById("auth-form");
  var msg = document.getElementById("auth-msg");
  var submit = document.getElementById("auth-submit");
  var tabLogin = document.getElementById("tab-login");
  var tabRegister = document.getElementById("tab-register");
  var fieldName = document.getElementById("field-name");
  var pwHint = document.getElementById("pw-hint");
  var title = document.getElementById("auth-title");
  var sub = document.getElementById("auth-sub");
  var foot = document.getElementById("auth-foot");
  var password = document.getElementById("password");

  var mode = "login";

  function nextUrl() {
    var params = new URLSearchParams(location.search);
    var next = params.get("next") || "/studio";
    // only allow same-site paths
    return next.charAt(0) === "/" && next.charAt(1) !== "/" ? next : "/studio";
  }

  function say(text, kind) {
    msg.textContent = text || "";
    msg.className = "auth-msg" + (text ? " " + (kind || "err") : "");
  }

  function setMode(next) {
    mode = next;
    var reg = mode === "register";
    tabLogin.classList.toggle("on", !reg);
    tabRegister.classList.toggle("on", reg);
    fieldName.hidden = !reg;
    pwHint.hidden = !reg;
    title.textContent = reg ? "Create your account" : "Welcome back";
    sub.textContent = reg
      ? "Free to start — no card needed. You get the Studio right after."
      : "Log in to open the Studio and your clip library.";
    submit.textContent = reg ? "Create account" : "Log in";
    password.setAttribute("autocomplete", reg ? "new-password" : "current-password");
    foot.innerHTML = reg
      ? 'Already have an account? <a href="#" id="switch-link">Log in</a>'
      : 'No account yet? <a href="#" id="switch-link">Create one free</a>';
    bindSwitch();
    say("");
  }

  function bindSwitch() {
    var link = document.getElementById("switch-link");
    if (!link) return;
    link.addEventListener("click", function (e) {
      e.preventDefault();
      setMode(mode === "login" ? "register" : "login");
    });
  }

  /* Social buttons: only show the providers this server actually has keys for,
     and carry the ?next= target through the round-trip. */
  (function socialSetup() {
    var box = document.getElementById("social");
    if (!box) return;
    fetch("/api/auth/providers")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var p = (d && d.providers) || {};
        var google = document.getElementById("btn-google");
        var apple = document.getElementById("btn-apple");
        var next = encodeURIComponent(nextUrl());
        if (p.google) google.href = "/api/auth/google?next=" + next; else google.remove();
        if (p.apple) apple.href = "/api/auth/apple?next=" + next; else apple.remove();
        if (p.google || p.apple) box.classList.add("on");
      })
      .catch(function () {});
  })();

  // A failed social round-trip comes back as /login?error=…
  (function showOauthError() {
    var err = new URLSearchParams(location.search).get("error");
    if (err) say(err);
  })();

  tabLogin.addEventListener("click", function () { setMode("login"); });
  tabRegister.addEventListener("click", function () { setMode("register"); });
  bindSwitch();

  // ?mode=register (or landing straight on /register) opens the signup tab
  if (/register/i.test(location.pathname) || /mode=register/i.test(location.search)) {
    setMode("register");
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    var email = document.getElementById("email").value.trim();
    var pass = password.value;
    var name = document.getElementById("name").value.trim();

    if (!email || !pass) return say("Email and password are required.");
    if (mode === "register" && pass.length < 8) return say("Password must be at least 8 characters.");

    submit.disabled = true;
    submit.textContent = mode === "register" ? "Creating…" : "Logging in…";
    say("");

    try {
      var res = await fetch(mode === "register" ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, password: pass, name: name }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) {
        say(data.error || "Something went wrong. Try again.");
        submit.disabled = false;
        submit.textContent = mode === "register" ? "Create account" : "Log in";
        return;
      }
      say(mode === "register" ? "Account created — opening Studio…" : "Logged in — opening Studio…", "ok");
      location.href = nextUrl();
    } catch (err) {
      say("Network error. Check your connection and try again.");
      submit.disabled = false;
      submit.textContent = mode === "register" ? "Create account" : "Log in";
    }
  });
})();
