#!/bin/bash
set -e

if [ ! -f .env ]; then
  echo "ERROR: .env file not found. Copy .env.example and add your keys."
  exit 1
fi

python3 -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload
