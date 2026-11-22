FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    npm \
    cups \
    cups-bsd \
    printer-driver-escpr \
    ghostscript \
    poppler-utils \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN chmod +x /app/entrypoint.sh

# Allow CUPS FileDevice so lpadmin can materialize the Epson PPD
RUN echo "FileDevice Yes" >> /etc/cups/cups-files.conf

EXPOSE 3000
ENTRYPOINT ["/app/entrypoint.sh"]
