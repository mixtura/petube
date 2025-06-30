//
//  WebSocketManager.swift
//  Petube
//
//  Created by Danylo Sydorenko on 16.06.2025.
//

import Foundation

protocol WebSocketManagerDelegate {
    func webSocketDidReceiveCommand(_ action: String)
}

class WebSocketManager: NSObject {
    private var webSocketTask: URLSessionWebSocketTask?
    var delegate: WebSocketManagerDelegate?

    func connect(roomId: String, token: String) {
        // Replace with your actual stream-control worker URL
        let urlString = "wss://stream-control.petube.workers.dev/room/\(roomId)?token=\(token)"
        guard let url = URL(string:urlString) else {
            print("[WebSocket] Invalid URL")
            return
        }
        
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: OperationQueue())
        webSocketTask = session.webSocketTask(with: url)
        webSocketTask?.resume()
        
        print("[WebSocket] Connecting to \(urlString)")
        listen()
    }

    func sendRole(_ role: String) {
        let payload = ["type": "role", "role": role]
        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            print("[WebSocket] Failed to serialize role message")
            return
        }
        
        print("[WebSocket] Sending role: \(jsonString)")
        webSocketTask?.send(.string(jsonString)) { error in
            if let error = error {
                print("[WebSocket] Error sending message: \(error.localizedDescription)")
            }
        }
    }

    private func listen() {
        webSocketTask?.receive { [weak self] result in
            switch result {
            case .failure(let error):
                print("[WebSocket] Error in receiving message: \(error.localizedDescription)")
                // Handle disconnect or errors here
            case .success(let message):
                switch message {
                case .string(let text):
                    print("[WebSocket] Received string: \(text)")
                    self?.handleMessage(text)
                case .data(let data):
                    print("[WebSocket] Received data: \(data)")
                @unknown default:
                    fatalError()
                }
                // Continue listening for next message
                self?.listen()
            }
        }
    }
    
    private func handleMessage(_ jsonString: String) {
        guard let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String, type == "control",
              let action = json["action"] as? String else {
            return
        }
        
        DispatchQueue.main.async {
            self.delegate?.webSocketDidReceiveCommand(action)
        }
    }

    func disconnect() {
        print("[WebSocket] Disconnecting")
        webSocketTask?.cancel(with: .goingAway, reason: nil)
    }
}

extension WebSocketManager: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        print("[WebSocket] Connection opened")
    }
    
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        print("[WebSocket] Connection closed")
    }
} 
