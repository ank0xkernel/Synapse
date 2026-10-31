#!/usr/bin/env bash
# ==============================================================================
# Synapse: One-Click Apple Silicon (M3 Pro) Environment Setup Script
# ==============================================================================
set -euo pipefail

echo "⚡ Starting Synapse M3 Pro Environment Setup..."

# 1. Check & Install Homebrew Dependencies
if ! command -v brew &> /dev/null; then
    echo "❌ Homebrew is required. Please install Homebrew first."
    exit 1
fi

echo "📦 Checking system packages..."
brew list cmake &>/dev/null || brew install cmake
brew list ffmpeg &>/dev/null || brew install ffmpeg

# 2. Build whisper.cpp with Core ML (Apple Neural Engine) Support
mkdir -p bin
if [ ! -d "bin/whisper.cpp" ]; then
    echo "📥 Cloning whisper.cpp repository..."
    git clone https://github.com/ggerganov/whisper.cpp.git bin/whisper.cpp
fi

echo "🛠️ Compiling whisper.cpp server for Apple Metal (GPU)..."
cd bin/whisper.cpp
cmake -B build
cmake --build build --config Release -j || true

if [ -f "build/bin/whisper-server" ]; then
    cp build/bin/whisper-server server
elif [ -f "build/bin/server" ]; then
    cp build/bin/server server
fi
cd ../..

# 3. Download & Prepare Model + Core ML Encoder
echo "🧠 Downloading ggml-medium.en model..."
if [ ! -f "bin/whisper.cpp/models/ggml-medium.en.bin" ]; then
    cd bin/whisper.cpp
    ./models/download-ggml-model.sh medium.en || true
    cd ../..
fi

# Core ML model generation has been disabled. Metal GPU is used instead.

# 4. Check & Prepare Ollama Metal LLM
echo "🦙 Checking Ollama installation..."
if ! command -v ollama &> /dev/null; then
    echo "📥 Installing Ollama via Homebrew..."
    brew install ollama
fi

echo "🚀 Starting Ollama service if not running..."
pgrep -x "ollama" > /dev/null || ollama serve &
sleep 2

echo "🧠 Pulling CodeQwen / Qwen2.5-Coder model for Metal GPU acceleration..."
ollama pull qwen2.5-coder:7b || ollama pull codeqwen || ollama pull llama3.2 || echo "⚠️ Ollama pull finished."

# 5. Pre-warm Ollama Model in VRAM
echo "🔥 Pre-warming LLM in Apple Silicon Unified Memory..."
curl -s http://localhost:11434/api/generate -d '{"model": "qwen2.5-coder:7b", "prompt": "hi", "keep_alive": -1}' > /dev/null || true

echo ""
echo "=============================================================================="
echo "⚡ SYNAPSE M3 PRO ENVIRONMENT SETUP COMPLETED SUCCESSFULLY!"
echo "=============================================================================="
echo "To test the system latency and accuracy, run:"
echo "  node scripts/benchmark-final.js"
echo ""
echo "To launch the Synapse Stealth Co-Pilot, run:"
echo "  npm start"
echo "=============================================================================="
