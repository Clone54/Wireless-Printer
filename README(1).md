# Epson L3210 Cloud Print Relay (ESP32-S3)

Print from **any network** using either your **phone/browser** (PDFs & photos) or your **Windows/Mac laptop** (standard Epson L3210 driver), with **no local PC needed at the printer**.

## 1. Deploy the Cloud Server (Free Option: Render.com)
1. Push the `cloud-server/` folder to a private GitHub repository.
2. Create a free account at Render (https://render.com) -> **New +** -> **Blueprint** (or **Web Service** -> **Docker**), and select your repo's `cloud-server/` directory.
3. Render automatically builds `Dockerfile` (with CUPS + `printer-driver-escpr`) and generates a `PRINT_TOKEN` environment variable. Copy your public URL (e.g. `https://epson-l3210-cloud-relay.onrender.com`) and `PRINT_TOKEN` from Render's **Environment** tab.
   - *(Alternative: On any Ubuntu/Debian VPS with Docker, edit `PRINT_TOKEN` in `cloud-server/docker-compose.yml` and run `docker compose up -d --build` behind Nginx/Caddy HTTPS.)*

## 2. Update Your ESP32-S3 Firmware
Follow `esp32-firmware/ESP32S3_INTEGRATION.txt` to add `cloud_client.h` and `cloud_client.cpp` to your `ESP32S3_PrintServer` sketch, set `CLOUD_SERVER_URL` and `CLOUD_PRINT_TOKEN`, and upload via Arduino IDE.
- Your local `10.29.172.30:9100` printer continues working as before.
- The ESP32-S3 also polls your cloud server every 3 seconds over HTTPS.

## 3. Print from Your Phone (Anywhere)
1. Open your cloud server URL (`https://your-app-name.onrender.com`) in any phone or desktop browser.
2. Enter your `PRINT_TOKEN` once (it saves in your browser).
3. Select any PDF, PNG, or JPG and tap **Send to Printer**.

## 4. Print from Your Laptop (Anywhere)
1. In Windows **Printers & scanners**, add a second printer (or port) pointing to IP **`127.0.0.1`** (Protocol: **Raw**, Port: **9100**, Driver: **EPSON L3210 Series**, with **Enable bidirectional support** unchecked).
2. Edit `laptop-relay/start_relay.bat` with your cloud URL and `PRINT_TOKEN`.
3. Double-click `start_relay.bat` whenever you want to print from another network, then print normally to the `127.0.0.1` printer!
