//
//  ContentView.swift
//  Petube
//
//  Created by Danylo Sydorenko on 15.06.2025.
//

import SwiftUI
import AgoraRtcKit
import UIKit

struct ContentView: View {
    enum Role: String, CaseIterable, Identifiable {
        case monitor = "🐶 Pet Monitor"
        case owner = "👤 Owner"
        var id: String { self.rawValue }
    }
    
    @State private var role: Role = .monitor
    @State private var appId: String = UserDefaults.standard.string(forKey: "pawwatch-apikey") ?? ""
    @State private var token: String = UserDefaults.standard.string(forKey: "pawwatch-token") ?? ""
    @State private var channel: String = UserDefaults.standard.string(forKey: "pawwatch-channel") ?? ""
    @State private var started = false
    @State private var showAlert = false
    @State private var alertMsg = ""
    
    @StateObject private var agoraManager = AgoraManager()
    
    var body: some View {
        VStack {
            if !started {
                VStack(spacing: 20) {
                    Text("🐾 PawWatch")
                        .font(.largeTitle)
                        .bold()
                    Text("Keep an eye on your furry friend, anywhere!")
                        .foregroundColor(.pink)
                        .font(.subheadline)
                    Picker("Role", selection: $role) {
                        ForEach(Role.allCases) { r in
                            Text(r.rawValue).tag(r)
                        }
                    }
                    .pickerStyle(.segmented)
                    TextField("Agora App ID", text: $appId)
                        .textFieldStyle(.roundedBorder)
                    TextField("Agora Token", text: $token)
                        .textFieldStyle(.roundedBorder)
                    TextField("Channel Name", text: $channel)
                        .textFieldStyle(.roundedBorder)
                    Button("Start") {
                        if appId.isEmpty || token.isEmpty || channel.isEmpty {
                            alertMsg = "Please enter Agora App ID, Token, and Channel Name!"
                            showAlert = true
                            return
                        }
                        UserDefaults.standard.set(appId, forKey: "pawwatch-apikey")
                        UserDefaults.standard.set(token, forKey: "pawwatch-token")
                        UserDefaults.standard.set(channel, forKey: "pawwatch-channel")
                        agoraManager.setup(appId: appId, token: token, channel: channel, asHost: role == .monitor)
                        UIApplication.shared.isIdleTimerDisabled = true
                        started = true
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
    }
}

class AgoraManager: NSObject, ObservableObject {
    private var agoraKit: AgoraRtcEngineKit?
    @Published var localCanvas: UIView? = nil
    @Published var remoteCanvas: UIView? = nil
    private var isHost = false
    
    func setup(appId: String, token: String, channel: String, asHost: Bool) {
        isHost = asHost
        agoraKit = AgoraRtcEngineKit.sharedEngine(withAppId: appId, delegate: self)
        if asHost {
            agoraKit?.setChannelProfile(.liveBroadcasting)
            agoraKit?.setClientRole(.broadcaster)
        } else {
            agoraKit?.setChannelProfile(.liveBroadcasting)
            agoraKit?.setClientRole(.audience)
        }
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
        }
        agoraKit?.joinChannel(byToken: token, channelId: channel, info: nil, uid: 0) { [weak self] (channel, uid, elapsed) in
            print("Joined channel: \(channel) as \(asHost ? "host" : "audience")")
        }
    }
    
    func leaveChannel() {
        agoraKit?.leaveChannel(nil)
        if isHost {
            agoraKit?.stopPreview()
        }
        localCanvas = nil
        remoteCanvas = nil
        agoraKit = nil
    }
}
extension AgoraManager: AgoraRtcEngineDelegate {
    func rtcEngine(_ engine: AgoraRtcEngineKit, didJoinedOfUid uid: UInt, elapsed: Int) {
        if !isHost {
            let view = UIView()
            remoteCanvas = view
            let videoCanvas = AgoraRtcVideoCanvas()
            videoCanvas.uid = uid
            videoCanvas.view = view
            videoCanvas.renderMode = .hidden
            engine.setupRemoteVideo(videoCanvas)
        }
    }
    func rtcEngine(_ engine: AgoraRtcEngineKit, didOfflineOfUid uid: UInt, reason: AgoraUserOfflineReason) {
        if !isHost {
            remoteCanvas = nil
        }
    }
}

struct AgoraVideoView: UIViewRepresentable {
    @ObservedObject var agoraManager: AgoraManager
    var isLocal: Bool
    func makeUIView(context: Context) -> UIView {
        if isLocal {
            return agoraManager.localCanvas ?? UIView()
        } else {
            return agoraManager.remoteCanvas ?? UIView()
        }
    }
    func updateUIView(_ uiView: UIView, context: Context) {
        // No-op
    }
}

#Preview {
    ContentView()
}
