//
//  ContentView.swift
//  Petube
//
//  Created by Danylo Sydorenko on 15.06.2025.
//

import SwiftUI
import AgoraRtcKit
import UIKit
import AuthenticationServices

class WebAuthPresentationContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first ?? ASPresentationAnchor()
    }
}

struct ContentView: View {
    enum Role: String, CaseIterable, Identifiable {
        case monitor = "🐶 Pet Monitor"
        case owner = "👤 Owner"
        var id: String { self.rawValue }
    }
    
    @State private var role: Role = Role(rawValue: UserDefaults.standard.string(forKey: "pawwatch-role") ?? "🐶 Pet Monitor") ?? .monitor
    @State private var started = false
    @State private var showAlert = false
    @State private var alertMsg = ""
    @State private var isLoading = false
    @State private var jwt: String? = UserDefaults.standard.string(forKey: "pawwatch-jwt")
    @State private var user: [String: Any]? = nil
    @State private var agoraToken: String = ""
    @State private var agoraAppId: String = "2464efe13ff5419b9c635dfdcd70005e"
    @State private var channel: String = ""
    @State private var uid: String = ""
    @StateObject private var agoraManager = AgoraManager()
    @State private var webSocketManager = WebSocketManager()
    @State private var showWebAuth = false
    @State private var webAuthSession: ASWebAuthenticationSession?
    @State private var webAuthPresentationContextProvider = WebAuthPresentationContextProvider()
    
    var body: some View {
        VStack {
            if isLoading {
                ProgressView("Loading...")
                    .padding()
            } else if jwt == nil {
                VStack(spacing: 20) {
                    Text("🐾 PawWatch")
                        .font(.largeTitle)
                        .bold()
                    Text("Keep an eye on your furry friend, anywhere!")
                        .foregroundColor(.pink)
                        .font(.subheadline)
                    Button(action: { startGoogleSignIn() }) {
                        HStack {
                            Image(uiImage: UIImage(data: try! Data(contentsOf: URL(string: "https://developers.google.com/identity/images/g-logo.png")!)) ?? UIImage())
                                .resizable().frame(width: 20, height: 20)
                            Text("Sign in with Google")
                        }
                        .padding()
                        .background(Color.white)
                        .foregroundColor(.black)
                        .cornerRadius(8)
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.gray, lineWidth: 1))
                    }
                }.padding()
            } else if !started {
                VStack(spacing: 20) {
                    if let user = user {
                        Text("Signed in as \(user["name"] as? String ?? "") (\(user["email"] as? String ?? ""))")
                            .font(.subheadline)
                        Button("Log out") { signOut() }
                            .foregroundColor(.red)
                    }
                    Picker("Role", selection: $role) {
                        ForEach(Role.allCases) { r in
                            Text(r.rawValue).tag(r)
                        }
                    }
                    .pickerStyle(.segmented)
                    Button("Start") {
                        startSession()
                    }
                    .buttonStyle(.borderedProminent)
                }
                .padding()
            } else {
                VStack(spacing: 16) {
                    Text(role == .monitor ? "🐶 Pet Monitor" : "👤 Owner")
                        .font(.title2)
                        .bold()
                    ZStack {
                        Color.black.opacity(0.1)
                        AgoraVideoView(agoraManager: agoraManager, isLocal: role == .monitor)
                            .cornerRadius(16)
                            .shadow(radius: 8)
                    }
                    .frame(height: 320)
                    Text(role == .monitor ? "Streaming to channel: \(channel)" : "Watching channel: \(channel)")
                        .foregroundColor(.gray)
                    Button(role == .monitor ? "Stop Streaming" : "Leave") {
                        agoraManager.leaveChannel()
                        webSocketManager.disconnect()
                        UIApplication.shared.isIdleTimerDisabled = false
                        started = false
                    }
                    .buttonStyle(.bordered)
                }
                .padding()
            }
        }
        .alert(alertMsg, isPresented: $showAlert) {
            Button("OK", role: .cancel) {}
        }
        .onAppear {
            self.webSocketManager.delegate = self
            if jwt != nil && user == nil {
                fetchUserInfo()
            }
        }
    }
    
    func startGoogleSignIn() {
        let authURL = URL(string: "https://auth.petube.workers.dev/devicelogin")!
        let callbackScheme = "com.googleusercontent.apps.378632047532-17q6rg6m36ga5c6ntg5an17mnhgpgsds" // Google iOS client scheme
        print("[Auth] Starting Google Sign-In with URL: \(authURL)")
        webAuthSession = ASWebAuthenticationSession(url: authURL, callbackURLScheme: callbackScheme) { callbackURL, error in
            print("[Auth] WebAuthSession callbackURL: \(String(describing: callbackURL))")
            print("[Auth] WebAuthSession error: \(String(describing: error))")
            if let callbackURL = callbackURL, let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false), let token = components.queryItems?.first(where: { $0.name == "token" })?.value {
                print("[Auth] Received JWT token: \(token)")
                jwt = token
                UserDefaults.standard.set(token, forKey: "pawwatch-jwt")
                fetchUserInfo()
            } else {
                alertMsg = "Authentication failed."
                showAlert = true
                print("[Auth] Authentication failed. callbackURL: \(String(describing: callbackURL)), error: \(String(describing: error))")
            }
        }
        webAuthSession?.presentationContextProvider = webAuthPresentationContextProvider
        webAuthSession?.start()
    }
    
    func fetchUserInfo() {
        guard let jwt = jwt else { return }
        isLoading = true
        var req = URLRequest(url: URL(string: "https://auth.petube.workers.dev/auth/me")!)
        req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
        print("[Auth] Fetching user info with JWT: \(jwt.prefix(10))...")
        URLSession.shared.dataTask(with: req) { data, response, error in
            DispatchQueue.main.async {
                isLoading = false
                if let error = error {
                    print("[Auth] Error fetching user info: \(error)")
                }
                if let response = response as? HTTPURLResponse {
                    print("[Auth] User info response status: \(response.statusCode)")
                }
                if let data = data {
                    print("[Auth] User info response data: \(String(data: data, encoding: .utf8) ?? "<nil>")")
                }
                if let data = data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    user = obj
                    print("[Auth] User info: \(obj)")
                } else {
                    print("[Auth] Failed to parse user info or not authenticated. Signing out.")
                    signOut()
                }
            }
        }.resume()
    }
    
    func startSession() {
        guard let jwt = jwt, let user = user, let userId = user["id"] else {
            alertMsg = "User info missing."
            showAlert = true
            return
        }
        isLoading = true
        let rolePath = (role == .monitor) ? "publisher" : "subscriber"
        var req = URLRequest(url: URL(string: "https://auth.petube.workers.dev/auth/agora/\(rolePath)/token")!)
        req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: req) { data, response, error in
            DispatchQueue.main.async {
                isLoading = false
                if let data = data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let token = obj["token"] as? String {
                    agoraToken = token
                    channel = String(describing: userId)
                    uid = "0"
                    print("[Agora] Starting session. Role: \(self.role.rawValue), Channel: \(self.channel), UID: \(self.uid)")
                    UserDefaults.standard.set(self.role.rawValue, forKey: "pawwatch-role")
                    // Connect WebSocket
                    self.webSocketManager.connect(roomId: self.channel, token: jwt)
                    let wsRole = self.role == .monitor ? "publisher" : "subscriber"
                    // A slight delay to ensure the connection is open before sending the role
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        self.webSocketManager.sendRole(wsRole)
                    }
                    agoraManager.setup(appId: self.agoraAppId, token: self.agoraToken, channel: self.channel, uid: self.uid, asHost: self.role == .monitor)
                    UIApplication.shared.isIdleTimerDisabled = true
                    self.started = true
                } else {
                    self.alertMsg = "Failed to fetch Agora token."
                    self.showAlert = true
                }
            }
        }.resume()
    }
    
    func signOut() {
        jwt = nil
        user = nil
        UserDefaults.standard.removeObject(forKey: "pawwatch-jwt")
    }
}

extension ContentView: WebSocketManagerDelegate {
    func webSocketDidReceiveCommand(_ action: String) {
        if action == "start" {
            agoraManager.publish()
        } else if action == "pause" {
            agoraManager.unpublish()
        }
    }
}

class AgoraManager: NSObject, ObservableObject {
    var agoraKit: AgoraRtcEngineKit?
    @Published var localCanvas: UIView? = nil
    @Published var remoteCanvas: UIView? = UIView()
    private var isHost = false
    private var isPublished = false
    
    func setup(appId: String, token: String, channel: String, uid: String, asHost: Bool) {
        isHost = asHost
        print("[Agora] setup called. appId: \(appId), token: \(token.prefix(8))..., channel: \(channel), uid: \(uid), asHost: \(asHost)")
        if let uidUInt = UInt(uid) {
            print("[Agora] Parsed uid string '\(uid)' to UInt: \(uidUInt)")
            agoraKit = AgoraRtcEngineKit.sharedEngine(withAppId: appId, delegate: self)

            agoraKit?.setChannelProfile(.liveBroadcasting)
            // All users join as audience first. The host will become a broadcaster on command.
            agoraKit?.setClientRole(.audience)
            print("[Agora] Set as audience")

            let videoConfig = AgoraVideoEncoderConfiguration(
                size: CGSize(width: 640, height: 360),
                frameRate: .fps15,
                bitrate: AgoraVideoBitrateStandard,
                orientationMode: .adaptative, mirrorMode: AgoraVideoMirrorMode.auto
            )
            agoraKit?.setVideoEncoderConfiguration(videoConfig)
            agoraKit?.enableVideo()
            if asHost {
                let view = UIView()
                localCanvas = view
                agoraKit?.startPreview()
                let videoCanvas = AgoraRtcVideoCanvas()
                videoCanvas.uid = 0
                videoCanvas.view = view
                videoCanvas.renderMode = .hidden
                agoraKit?.setupLocalVideo(videoCanvas)
                print("[Agora] Local video setup complete (host)")
            }
            agoraKit?.joinChannel(byToken: token, channelId: channel, info: nil, uid: uidUInt) { (sid, uid, elapsed) in
                print("[Agora] Joined channel. SID: \(sid), UID: \(uid), elapsed: \(elapsed)")
            }
        } else {
            print("[Agora] Failed to parse UID string to UInt: \(uid)")
        }
    }
    
    func publish() {
        if isHost && !isPublished {
            agoraKit?.setClientRole(.broadcaster) // Ensure role is correct
            print("[Agora] Publishing stream...")
            isPublished = true
        }
    }

    func unpublish() {
        if isHost && isPublished {
            agoraKit?.setClientRole(.audience) // Revert to audience to stop publishing
            print("[Agora] Unpublishing stream...")
            isPublished = false
        }
    }

    func leaveChannel() {
        agoraKit?.leaveChannel(nil)
        agoraKit?.stopPreview()
        localCanvas = nil
        isPublished = false
        AgoraRtcEngineKit.destroy()
        agoraKit = nil
        print("[Agora] Channel left and engine destroyed.")
    }
}

extension AgoraManager: AgoraRtcEngineDelegate {
    func rtcEngine(_ engine: AgoraRtcEngineKit, didJoinedOfUid uid: UInt, elapsed: Int) {
        print("[Agora] Remote user joined: \(uid)")
        let videoCanvas = AgoraRtcVideoCanvas()
        videoCanvas.uid = uid
        videoCanvas.view = remoteCanvas
        videoCanvas.renderMode = .hidden
        agoraKit?.setupRemoteVideo(videoCanvas)
    }
}

struct AgoraVideoView: UIViewRepresentable {
    @ObservedObject var agoraManager: AgoraManager
    var isLocal: Bool
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        if isLocal {
            if let local = agoraManager.localCanvas {
                local.frame = view.bounds
                local.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                view.addSubview(local)
            }
        } else {
            if let remote = agoraManager.remoteCanvas {
                remote.frame = view.bounds
                remote.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                view.addSubview(remote)
            }
        }
        return view
    }
    func updateUIView(_ uiView: UIView, context: Context) {
        uiView.subviews.first?.frame = uiView.bounds
    }
    class Coordinator: NSObject {
        var parent: AgoraVideoView
        init(_ parent: AgoraVideoView) {
            self.parent = parent
        }
    }
}

#Preview {
    ContentView()
}
