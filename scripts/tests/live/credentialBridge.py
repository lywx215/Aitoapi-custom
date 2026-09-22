"""Read-only encrypted artifact bridge. Secrets travel on stdin/local HTTP only."""
import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit


def run(options):
    manager = Path(options["managerRoot"]).resolve()
    sys.path.insert(0, str(manager))
    # Import only definitions. Do not call the old runner or load its destination URL.
    spec = importlib.util.spec_from_file_location(
        "encrypted_artifacts", manager / "scripts/validate_aistudio_auth_import.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    from core.settings import unlock_repository_secrets, get_secret

    store = unlock_repository_secrets()
    try:
        artifact = Path(options["artifact"]).resolve()
        allowed = (manager / "runtime/devices").resolve()
        if not artifact.is_relative_to(allowed):
            raise ValueError("artifact_outside_runtime")
        raw = artifact.read_bytes()
        artifact_hash = hashlib.sha256(raw).hexdigest()
        if artifact_hash != options["sha256"]:
            raise ValueError("artifact_changed")
        reader = module.ArtifactStore(module._derive_artifact_key(get_secret("integrations.aitoapi.artifact_key", "")))
        payload, metadata = reader.load(artifact)
        state = payload["storage_state"]
        email = str(state.get("accountName", "")).strip().lower()
        source = payload.get("source", {})
        if (not module.EMAIL_RE.fullmatch(email)
                or source.get("account_id") != metadata.get("account_id")
                or str(source.get("email", "")).strip().lower() != email
                or hashlib.sha256(email.encode()).hexdigest() != metadata.get("email_hash")):
            raise ValueError("artifact_identity_mismatch")
        if (not isinstance(state.get("cookies"), list) or not state["cookies"]
                or not all(isinstance(cookie, dict) for cookie in state["cookies"])
                or not isinstance(state.get("origins"), list)):
            raise ValueError("artifact_invalid_state")
        if set(state) - {"accountName", "cookies", "origins"}:
            raise ValueError("artifact_control_fields")
        result = {"sha256": artifact_hash, "identityHash": metadata["email_hash"],
                  "cookieCount": len(state["cookies"]), "originCount": len(state["origins"])}
        if options["action"] == "preflight":
            return result
        if options["action"] == "diagnose":
            # Headless diagnosis; only the opt-in, exact app-launch gate may be
            # clicked. Never log in, accept service terms or generate.
            from playwright.sync_api import sync_playwright
            with sync_playwright() as playwright:
                browser = playwright.firefox.launch(executable_path=options["browser"], headless=True)
                try:
                    context = browser.new_context(storage_state={"cookies": state["cookies"], "origins": state["origins"]})
                    # A page must not consume model quota while being diagnosed.
                    def guard(route):
                        if "generatecontent" in route.request.url.lower():
                            route.abort("blockedbyclient")
                        else:
                            route.continue_()
                    context.route("**/*", guard)
                    page = context.new_page()
                    response = page.goto("https://ai.studio/apps/d31dbffc-6199-4f09-9da5-45de7684ab8a",
                                         wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_timeout(15000)
                    if options.get("advanceEntry"):
                        # Only the known app-launch interstitial. This is not a
                        # generic Continue/login/terms acceptance action.
                        known_entry = page.evaluate("() => document.body.innerText.includes('This app is from another developer')")
                        entry = page.get_by_role("button", name="Continue to the app", exact=True)
                        result["entryAdvanceRequested"] = True
                        if known_entry and entry.is_visible():
                            entry.click(timeout=5000)
                            page.wait_for_timeout(15000)
                            result["entryAdvanced"] = True
                    result["navigationStatus"] = response.status if response else None
                    result["entryRoleExactCount"] = page.get_by_role("button", name="Continue to the app", exact=True).count()
                    result["entryTextExactCount"] = page.get_by_text("Continue to the app", exact=True).count()
                    result["entryVisible"] = page.get_by_role("button", name="Continue to the app", exact=True).is_visible()
                    result["frames"] = []
                    for frame in page.frames:
                        result["frames"].append(frame.evaluate("""() => ({
                            origin: location.origin, pathname: location.pathname,
                            title: document.title.includes('Google') ? 'Google' : 'other',
                            bodyLength: document.body?.innerText?.length || 0,
                            hasWizData: !!window.WIZ_global_data,
                            hasIdentity: typeof window.WIZ_global_data?.oPEP7c === 'string',
                            loginRequired: /sign in|verify it.s you/i.test(document.body?.innerText || '')
                        })"""))
                    if options.get("screenshot"):
                        page.screenshot(path=options["screenshot"])
                    result["page"] = page.evaluate("""() => {
                        const visible = node => node.getClientRects().length > 0;
                        const labels = Array.from(document.querySelectorAll('button, [role="button"], a, h1, h2, [role="dialog"]'))
                            .filter(visible).map(node => (node.innerText || '').trim()).join('\\n');
                        const body = document.body?.innerText || '';
                        return {
                            origin: location.origin, pathname: location.pathname,
                            hasWizData: !!window.WIZ_global_data,
                            hasIdentityField: typeof window.WIZ_global_data?.oPEP7c === 'string',
                            wizKeys: Object.keys(window.WIZ_global_data || {}),
                            signIn: /sign in|verify it.s you|登录|验证您的身份/i.test(labels),
                            terms: /terms of service|agree and continue|服务条款|同意并继续/i.test(body),
                            region: /not available in your (country|region)|所在地区/i.test(body),
                            continueButton: /^(Continue|Continue to the app)$/im.test(labels),
                            loading: /loading|正在加载/i.test(labels),
                            frameCount: window.frames.length,
                            frameOrigins: Array.from(document.querySelectorAll('iframe')).map(frame => {
                                try { return new URL(frame.src, location.href).origin; } catch { return 'invalid'; }
                            }),
                            bodyLength: body.length,
                            safeUiLines: body.split('\\n').map(s => s.trim()).filter(s =>
                                s && s.length < 240 && /^[A-Za-z0-9 .,!?"'’()\\-]+$/.test(s) &&
                                !/[A-Za-z0-9_-]{24,}|password|token|secret|cookie/i.test(s)
                            ).slice(0, 12)
                        };
                    }""")
                finally:
                    browser.close()
            return result
        if options["action"] != "import":
            raise ValueError("unknown_action")
        url = urlsplit(options["baseUrl"])
        if (url.scheme != "http" or url.hostname != "127.0.0.1" or url.port != 7860
                or url.username or url.password or url.query or url.fragment or url.path not in ("", "/")):
            raise ValueError("non_loopback_destination")
        body = json.dumps({"items": [{"clientRef": options["label"], "credentials": state}],
                           "model": "gemini-3.8-flash"}).encode()
        connection = http.client.HTTPConnection("127.0.0.1", 7860, timeout=30)
        try:
            connection.request("POST", "/api/manage/v1/accounts/import", body, {
                "Authorization": "Bearer " + options["token"], "Content-Type": "application/json",
                "Idempotency-Key": options["idempotencyKey"],
            })
            response = connection.getresponse()
            content = json.loads(response.read(1024 * 1024))
            result["httpStatus"] = response.status
            result["taskId"] = content.get("data", {}).get("taskId")
            result["errorCode"] = content.get("error", {}).get("code")
            return result  # Never return storage state, arbitrary response text, or headers.
        finally:
            connection.close()
    finally:
        store.close()


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "result": run(json.loads(sys.stdin.read()))}))
    except Exception as error:
        # No exception message: third-party errors can embed decrypted values.
        print(json.dumps({"ok": False, "errorType": type(error).__name__, "stage": "credential_bridge"}))
        sys.exit(1)
