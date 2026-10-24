import UIKit
import WebKit
import Capacitor

/// The PCs this app knows, kept in UserDefaults. The WebView's cookies (a paired device's
/// sign-in) live in WebKit's own store, not here.
enum PCStore {
    private static let defaults = UserDefaults.standard

    /// Origins opened before, the latest first.
    static var saved: [String] {
        get { defaults.stringArray(forKey: "herdr.saved") ?? [] }
        set { defaults.set(newValue, forKey: "herdr.saved") }
    }

    /// The PC the app opens at launch, an origin; nil shows the connect screen.
    static var current: String? {
        get { defaults.string(forKey: "herdr.current") }
        set { defaults.set(newValue, forKey: "herdr.current") }
    }

    /// The PC opened last, even after "Change PC", for the pages that name it.
    static var last: String? {
        get { defaults.string(forKey: "herdr.last") }
        set { defaults.set(newValue, forKey: "herdr.last") }
    }

    /// The address to open instead of the bare origin until a PC page loads: a pairing link keeps
    /// its `?pair=` code through Try again. In memory only, as it can hold that code.
    static var pendingStart: String?

    /// Why the last load failed, for the error page.
    static var failure: String?

    /// Redirects in a row that made another origin the PC (NavigationFailureProxy), so two servers
    /// that redirect to each other stop.
    static var redirects = 0

    /// Redirects in a row the app follows, in the web view and in `ovisOrigin`; past it the error
    /// page says so.
    static let maxRedirects = 5

    /// How long `ovisOrigin` may take in all, its redirects included: the screen stays blank meanwhile.
    static let probeBudget: TimeInterval = 10

    static func remember(_ origin: String) {
        saved = [origin] + saved.filter { $0 != origin }
    }

    static func forget(_ origin: String) {
        saved = saved.filter { $0 != origin }
        if current == origin { current = nil }
        if last == origin { last = nil }
    }

    /// `scheme://host[:port]` of an http or https URL, the host in lowercase as WebKit reports it, or nil.
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let shownHost = host.contains(":") ? "[\(host)]" : host
        return url.port.map { "\(scheme)://\(shownHost):\($0)" } ?? "\(scheme)://\(shownHost)"
    }

    /// The origin of the Ovis server that `target` leads to, or nil. Asks `/api/health?scope=bridge`,
    /// which Ovis answers to anyone so a client can find its gate, and follows at most `maxRedirects`
    /// redirects of that request: a sign-in page, another site, a loop or no answer is not Ovis. Only
    /// such an origin may become the PC: Capacitor gives its bridge to every page the web view keeps.
    /// Gives up after `probeBudget` in all, however slowly the answers come, and reads at most 64 KB.
    static func ovisOrigin(leadingTo target: URL) async -> String? {
        let deadline = Date().addingTimeInterval(probeBudget)
        var next = origin(of: target)
        for _ in 0...maxRedirects {
            let left = deadline.timeIntervalSinceNow
            guard left > 0, let current = next, let health = URL(string: current + "/api/health?scope=bridge") else { return nil }
            // the request's own timeout is per pause in the answer; the session's ends it at the deadline
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForResource = left
            let session = URLSession(configuration: configuration)
            defer { session.invalidateAndCancel() }
            var request = URLRequest(url: health, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: min(5, left))
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            guard let (bytes, response) = try? await session.bytes(for: request, delegate: RefuseRedirects()),
                  let http = response as? HTTPURLResponse else { return nil }
            if (300..<400).contains(http.statusCode) {
                next = http.value(forHTTPHeaderField: "Location")
                    .flatMap { URL(string: $0, relativeTo: health) }
                    .flatMap { origin(of: $0.absoluteURL) }
                continue
            }
            guard http.statusCode == 200 else { return nil }
            var data = Data()
            do {
                for try await byte in bytes {
                    data.append(byte)
                    if data.count > 64 * 1024 { return nil }
                }
            } catch {
                return nil
            }
            // JSON true and numbers both come as NSNumber: only a boolean true is ok, only a number a protocol
            guard let answer = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let ok = answer["ok"] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID(), ok.boolValue,
                  answer["auth"] is [String: Any],
                  let version = answer["bridge_protocol"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID() else { return nil }
            return current
        }
        return nil
    }

    /// `target`'s path, query and fragment on `origin`: a pairing link keeps its code when its
    /// server's /api/health redirected to another origin.
    static func start(on origin: String, for target: URL) -> String {
        guard let parts = URLComponents(url: target, resolvingAgainstBaseURL: true) else { return origin + "/" }
        let path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
        return origin + path + (parts.percentEncodedQuery.map { "?" + $0 } ?? "") + (parts.percentEncodedFragment.map { "#" + $0 } ?? "")
    }
}

/// Hands a redirect back to `ovisOrigin` instead of following it.
private final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Capacitor's view controller with the chosen PC as the WebView's first page. Reaching the PC
/// by navigating from the bundled connect page instead would cost every launch about 1.5 s
/// (docs/native-app.md, Spike results), so opening a PC builds a new one of these.
class HerdrBridgeViewController: CAPBridgeViewController {
    private var failureProxy: NavigationFailureProxy?

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        if let origin = PCStore.current, let host = URL(string: origin)?.host {
            // what server.url sets; the pairing link until a PC page has loaded, the origin after it
            descriptor.serverURL = PCStore.pendingStart ?? origin + "/"
            // the whole PC is the app: its own links stay in the WebView, others go to Safari
            descriptor.allowedNavigationHostnames = descriptor.allowedNavigationHostnames + [host]
        }
        return descriptor
    }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        // a PC on a plain http address (a tailnet or LAN IP) is opened as typed: with the system's
        // https-first try, every load of one waited about 2 s before it started
        configuration.upgradeKnownHostsToHTTPS = false
        if #available(iOS 18.2, *) {
            configuration.defaultWebpagePreferences.preferredHTTPSNavigationPolicy = .keepAsRequested
        }
        return configuration
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(HerdrShellPlugin())
        bridge?.registerPluginInstance(OvisPushPlugin())
    }

    override func viewDidLoad() {
        // before super, which starts the first load
        if let webView = webView, PCStore.current != nil {
            let proxy = NavigationFailureProxy(inner: webView.navigationDelegate) { [weak self] webView, reason in
                self?.showFailure(in: webView, reason: reason)
            }
            failureProxy = proxy
            webView.navigationDelegate = proxy
        }
        super.viewDidLoad()
    }

    private func showFailure(in webView: WKWebView, reason: String) {
        guard let local = bridge?.config.localURL else { return }
        PCStore.failure = reason
        webView.load(URLRequest(url: local.appendingPathComponent("error.html")))
    }

    /// Replaces the app's view controller, so the next page (a PC, or the connect screen) is a
    /// first load. The old one goes with its web view and the page in it (the barcode scanner
    /// plugin, which kept it alive, is patched in app/patches).
    static func reopen() {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard let window = (scene?.delegate as? SceneDelegate)?.window else { return }
        window.rootViewController = HerdrBridgeViewController()
    }
}

/// Passes every navigation callback to Capacitor's own delegate and reports a main-frame load
/// that failed, such as a PC that is off or one that answers with an HTTP error, with its reason.
/// A load cancelled on purpose (a link handed to Safari, a new navigation) is not a failure.
final class NavigationFailureProxy: NSObject, WKNavigationDelegate {
    private weak var inner: WKNavigationDelegate?
    private let onFailure: (WKWebView, String) -> Void
    /// Whether the main frame's navigation has started and not committed yet.
    private var provisional = false
    /// Whether the main frame's first page has committed: from then on a user could have followed a
    /// link from it.
    private var pageShown = false

    init(inner: WKNavigationDelegate?, onFailure: @escaping (WKWebView, String) -> Void) {
        self.inner = inner
        self.onFailure = onFailure
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (inner?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        inner?.responds(to: aSelector) == true ? inner : nil
    }

    /// A main-frame HTTP error (tailscale serve's 502 while Ovis is stopped on the PC, a 404) is
    /// not a PC worth keeping, and its page would leave the app no way back: the error page shows
    /// instead. Capacitor's delegate does not decide responses; WebKit allows all of them.
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse,
              response.statusCode >= 400 else {
            decisionHandler(.allow)
            return
        }
        // the cancelled load ends in WebKit's "frame load interrupted", which is not reported
        decisionHandler(.cancel)
        onFailure(webView, "HTTP \(response.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: response.statusCode).capitalized)")
    }

    /// WebKit has no public mark for a redirect: it comes as a main-frame action, of the type of the
    /// navigation it redirects, while that navigation has not committed. Until the first page
    /// commits, such an action to another origin is held back for `follow`: no page is there yet to
    /// follow a link from, so it comes from the address being opened. After that Capacitor decides,
    /// as a link could lead to a page that is not the PC's (another port on its host), which must not
    /// choose the PC.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if !pageShown, provisional, navigationAction.targetFrame?.isMainFrame == true,
           let current = PCStore.current, let url = navigationAction.request.url,
           let next = PCStore.origin(of: url), next != current {
            decisionHandler(.cancel)
            follow(url, in: webView)
            return
        }
        if let capacitor = inner as? WebViewDelegationHandler {
            capacitor.webView(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
        } else {
            decisionHandler(.allow)
        }
    }

    /// A redirect of the address being opened to another origin: when that origin answers as Ovis it
    /// becomes the PC and opens as the first page (http to https, an IP address to the PC's name,
    /// another port). Anything else, such as a sign-in page, gets no bridge and the error page names
    /// it: a PC address that leads elsewhere is not a PC.
    private func follow(_ target: URL, in webView: WKWebView) {
        let tooMany = PCStore.redirects >= PCStore.maxRedirects
        Task { @MainActor [weak self, weak webView] in
            let ovis = tooMany ? nil : await PCStore.ovisOrigin(leadingTo: target)
            // a web view no longer on screen (the user changed PC meanwhile) decides nothing
            guard let self, let webView, webView.window != nil else { return }
            if let ovis {
                PCStore.redirects += 1
                PCStore.current = ovis
                PCStore.last = ovis
                PCStore.pendingStart = PCStore.start(on: ovis, for: target)
                HerdrBridgeViewController.reopen()
            } else {
                let place = PCStore.origin(of: target) ?? target.absoluteString
                let reason = tooMany ? "Too many redirects" : "It redirected to \(place), which did not answer as Ovis. If that is your PC, open \(place) itself."
                self.onFailure(webView, reason)
            }
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        provisional = true
        inner?.webView?(webView, didStartProvisionalNavigation: navigation)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        provisional = false
        pageShown = true
        inner?.webView?(webView, didCommit: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        inner?.webView?(webView, didFinish: navigation)
        // the PC's page is up: a pairing link has done its work, and the PC is one worth keeping
        if let url = webView.url, let origin = PCStore.origin(of: url), origin == PCStore.current {
            PCStore.pendingStart = nil
            PCStore.redirects = 0
            PCStore.remember(origin)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        provisional = false
        inner?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
        let nsError = error as NSError
        let cancelled = nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
        // WebKit's "frame load interrupted" (102) and "plug-in handled load" (204)
        let handedOff = nsError.domain == "WebKitErrorDomain" && (nsError.code == 102 || nsError.code == 204)
        if !cancelled && !handedOff { onFailure(webView, error.localizedDescription) }
    }
}
