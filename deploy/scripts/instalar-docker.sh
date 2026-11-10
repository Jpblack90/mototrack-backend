#!/usr/bin/env bash
# Prepara una VM Ubuntu 24.04: Docker, Compose, Git y 2 GB de swap (para compilar el frontend).
set -euo pipefail
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git
# Script oficial de instalación de Docker (docker.com)
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sudo sh /tmp/get-docker.sh
sudo usermod -aG docker "$USER"
# Swap de 2 GB si no existe
if ! swapon --show | grep -q swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi
echo "Listo. Cierra la ventana SSH y vuelve a abrirla para usar docker sin sudo."
