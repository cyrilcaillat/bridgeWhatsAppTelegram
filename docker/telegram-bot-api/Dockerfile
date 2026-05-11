FROM debian:bookworm-slim AS build

ARG TELEGRAM_BOT_API_REF=master

RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  cmake \
  git \
  gperf \
  libssl-dev \
  zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN git clone --recursive https://github.com/tdlib/telegram-bot-api.git . \
  && git checkout "$TELEGRAM_BOT_API_REF" \
  && git submodule update --init --recursive

RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
  && cmake --build build --target telegram-bot-api -j"$(nproc)"

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  libssl3 \
  zlib1g \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/build/telegram-bot-api /usr/local/bin/telegram-bot-api

ENTRYPOINT ["/usr/local/bin/telegram-bot-api"]
