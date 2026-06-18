/**
 * Hosted extension login page — Hauska-branded signup / sign-in / reset (75i task 8).
 */

export type ExtensionLoginMode = "signin" | "signup" | "reset";

const RADAR_MARK_SVG = `<svg class="mark" viewBox="0 0 28 28" style="--mark-size:28px" aria-hidden="true">
  <circle class="ring" cx="14" cy="14" r="12.5" stroke-width="1.6"/>
  <path class="wedge" d="M14 14 L14 1.5 A12.5 12.5 0 0 1 25.6 9.6 Z"/>
  <line class="edge" x1="14" y1="14" x2="14" y2="1.5" stroke-width="1.8" stroke-linecap="round"/>
  <circle class="core" cx="14" cy="14" r="2"/>
  <circle class="blip" cx="20.5" cy="7" r="1.7"/>
</svg>`;

export function resolveExtensionLoginMode(
  intent: unknown,
): ExtensionLoginMode {
  if (intent === "signup") return "signup";
  if (intent === "reset") return "reset";
  return "signin";
}

export function renderExtensionLoginPage(initialMode: ExtensionLoginMode): string {
  const titles: Record<ExtensionLoginMode, string> = {
    signin: "Sign in",
    signup: "Create your account",
    reset: "Reset your password",
  };
  const leads: Record<ExtensionLoginMode, string> = {
    signin: "Save your buy box, verdict history, and Pro depth across devices.",
    signup: "Creating account… finish here to sync your Deal radar profile.",
    reset: "We will email reset instructions if an account exists for this address.",
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hauska — ${titles[initialMode]}</title>
  <link rel="stylesheet" href="/api/auth/hauska/hauska.css">
  <link rel="stylesheet" href="/api/auth/hauska/extension-auth.css">
</head>
<body class="auth-page" data-initial-mode="${initialMode}">
  <main class="auth-shell">
    <header class="auth-brand">
      <span class="brand">
        ${RADAR_MARK_SVG}
        <span class="brand__name">Hauska</span>
      </span>
      <p class="t-overline auth-kicker">Deal radar</p>
    </header>

    <div class="card card--pad auth-card">
      <h1 class="t-h2" id="auth-title">${titles[initialMode]}</h1>
      <p class="t-body auth-lead u-muted" id="auth-lead">${leads[initialMode]}</p>

      <section class="auth-panel" id="panel-signin" ${initialMode === "signin" ? "" : "hidden"}>
        <form id="form-signin" novalidate>
          <div class="auth-field">
            <label class="auth-label" for="signin-email">Email</label>
            <input class="auth-input" type="email" id="signin-email" name="email" required autocomplete="email">
          </div>
          <div class="auth-field">
            <label class="auth-label" for="signin-password">Password</label>
            <input class="auth-input" type="password" id="signin-password" name="password" required minlength="8" autocomplete="current-password">
          </div>
          <button type="submit" class="btn btn--primary btn--lg auth-submit" id="signin-submit">Sign in</button>
        </form>
        <p class="auth-switch">New here? <button type="button" data-mode="signup">Create an account</button></p>
        <p class="auth-switch"><button type="button" data-mode="reset">Forgot password?</button></p>
      </section>

      <section class="auth-panel" id="panel-signup" ${initialMode === "signup" ? "" : "hidden"}>
        <form id="form-signup" novalidate>
          <div class="auth-field">
            <label class="auth-label" for="signup-email">Email</label>
            <input class="auth-input" type="email" id="signup-email" name="email" required autocomplete="email">
          </div>
          <div class="auth-field">
            <label class="auth-label" for="signup-password">Password (8+ characters)</label>
            <input class="auth-input" type="password" id="signup-password" name="password" required minlength="8" autocomplete="new-password">
          </div>
          <div class="auth-field">
            <label class="auth-label" for="signup-confirm">Confirm password</label>
            <input class="auth-input" type="password" id="signup-confirm" name="confirm" required minlength="8" autocomplete="new-password">
          </div>
          <button type="submit" class="btn btn--primary btn--lg auth-submit" id="signup-submit">Create account</button>
        </form>
        <p class="auth-switch">Already have an account? <button type="button" data-mode="signin">Sign in</button></p>
      </section>

      <section class="auth-panel" id="panel-reset" ${initialMode === "reset" ? "" : "hidden"}>
        <form id="form-reset" novalidate>
          <div class="auth-field">
            <label class="auth-label" for="reset-email">Email</label>
            <input class="auth-input" type="email" id="reset-email" name="email" required autocomplete="email">
          </div>
          <button type="submit" class="btn btn--primary btn--lg auth-submit" id="reset-submit">Send reset instructions</button>
        </form>
        <p class="auth-switch"><button type="button" data-mode="signin">Back to sign in</button></p>
      </section>

      <p class="auth-err" id="err" role="alert"></p>
      <p class="auth-foot">Your profile stays private — never pooled into anyone else's number.</p>
    </div>
  </main>
  <script>
    (function () {
      const params = new URLSearchParams(location.search);
      const redirectUri = params.get("redirect_uri");
      const installId = params.get("install_id") || "";
      const titles = {
        signin: "Sign in",
        signup: "Create your account",
        reset: "Reset your password",
      };
      const leads = {
        signin: "Save your buy box, verdict history, and Pro depth across devices.",
        signup: "Creating account… finish here to sync your Deal radar profile.",
        reset: "We will email reset instructions if an account exists for this address.",
      };
      const err = document.getElementById("err");
      const title = document.getElementById("auth-title");
      const lead = document.getElementById("auth-lead");
      const panels = {
        signin: document.getElementById("panel-signin"),
        signup: document.getElementById("panel-signup"),
        reset: document.getElementById("panel-reset"),
      };

      function setErr(message, ok) {
        err.textContent = message || "";
        err.classList.toggle("is-ok", Boolean(ok));
      }

      function setMode(mode) {
        Object.entries(panels).forEach(([key, el]) => {
          el.hidden = key !== mode;
        });
        title.textContent = titles[mode];
        lead.textContent = leads[mode];
        document.title = "Hauska — " + titles[mode];
        setErr("");
      }

      document.querySelectorAll("[data-mode]").forEach((btn) => {
        btn.addEventListener("click", () => setMode(btn.getAttribute("data-mode")));
      });

      setMode(document.body.dataset.initialMode || "signin");

      async function finishAuth(body) {
        if (redirectUri) {
          const u = new URL(redirectUri);
          u.hash = "token=" + encodeURIComponent(body.token);
          location.href = u.toString();
          return;
        }
        setErr("Signed in. You can close this tab.", true);
      }

      document.getElementById("form-signin").addEventListener("submit", async (e) => {
        e.preventDefault();
        const submit = document.getElementById("signin-submit");
        submit.disabled = true;
        setErr("");
        try {
          const email = document.getElementById("signin-email").value.trim();
          const password = document.getElementById("signin-password").value;
          const r = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Hauska-Install-Id": installId },
            body: JSON.stringify({ email, password }),
          });
          const body = await r.json();
          if (!r.ok) {
            setErr(body.error === "invalid_credentials" ? "Email or password is incorrect." : (body.error || "Sign in failed"));
            return;
          }
          await finishAuth(body);
        } finally {
          submit.disabled = false;
        }
      });

      document.getElementById("form-signup").addEventListener("submit", async (e) => {
        e.preventDefault();
        const submit = document.getElementById("signup-submit");
        setErr("");
        const email = document.getElementById("signup-email").value.trim();
        const password = document.getElementById("signup-password").value;
        const confirm = document.getElementById("signup-confirm").value;
        if (password !== confirm) {
          setErr("Passwords do not match.");
          return;
        }
        submit.disabled = true;
        try {
          const r = await fetch("/api/auth/signup", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Hauska-Install-Id": installId },
            body: JSON.stringify({ email, password, installId: installId || undefined }),
          });
          const body = await r.json();
          if (!r.ok) {
            const msg = body.error === "email_taken"
              ? "An account already exists for this email. Try signing in."
              : (body.error || "Could not create account");
            setErr(msg);
            return;
          }
          await finishAuth(body);
        } finally {
          submit.disabled = false;
        }
      });

      document.getElementById("form-reset").addEventListener("submit", async (e) => {
        e.preventDefault();
        const submit = document.getElementById("reset-submit");
        submit.disabled = true;
        setErr("");
        try {
          const email = document.getElementById("reset-email").value.trim();
          await fetch("/api/auth/password-reset-request", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
          });
          setErr("If an account exists, reset instructions will be sent.", true);
        } finally {
          submit.disabled = false;
        }
      });
    })();
  </script>
</body>
</html>`;
}
