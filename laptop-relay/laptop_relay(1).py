import os
import socket
import ssl
import urllib.request

# Configure these two values (or set environment variables CLOUD_PRINT_URL / CLOUD_PRINT_TOKEN)
CLOUD_URL = os.environ.get("CLOUD_PRINT_URL", "https://your-app-name.onrender.com").rstrip("/")
PRINT_TOKEN = os.environ.get("CLOUD_PRINT_TOKEN", "your-secret-token")
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 9100


def forward_to_cloud(data: bytes):
    url = f"{CLOUD_URL}/api/print-raw"
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/octet-stream",
            "x-print-token": PRINT_TOKEN,
            "x-job-name": "Windows Laptop Job",
        },
    )
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
        return resp.status, resp.read().decode("utf-8", errors="ignore")


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((LISTEN_HOST, LISTEN_PORT))
    srv.listen(5)
    print(f"[Relay] Listening on {LISTEN_HOST}:{LISTEN_PORT} -> {CLOUD_URL}")
    print("[Relay] Keep this window open only while printing from this laptop away from home/office.")

    while True:
        conn, addr = srv.accept()
        conn.settimeout(5.0)
        chunks = []
        try:
            while True:
                try:
                    buf = conn.recv(65536)
                    if not buf:
                        break
                    chunks.append(buf)
                except socket.timeout:
                    break
        finally:
            conn.close()

        payload = b"".join(chunks)
        if not payload:
            continue

        print(f"[Relay] Captured {len(payload):,} bytes from Windows, uploading...")
        try:
            status, body = forward_to_cloud(payload)
            print(f"[Relay] Uploaded (HTTP {status}): {body}")
        except Exception as exc:
            print(f"[Relay] Upload failed: {exc}")


if __name__ == "__main__":
    main()
