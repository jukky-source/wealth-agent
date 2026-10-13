# 実行ランナー — Cloudflare Containers 用のイメージ（linux/amd64）
#
# 中身は「ffmpeg」と「espeak-ng」だけ。ffmpeg が動画を合成し、espeak-ng が
# 音声を作ります。どちらもオープンソースで、APIキーも従量課金も要りません
# （この2つが動かない場所では、動画づくりが止まる — それが実行環境が要る理由）。
#
# ビルドと配備（Docker が必要）：
#   npx wrangler deploy -c wrangler.containers.toml
#
# ローカルで同じコードを試す：
#   docker build -t wa-runner -f runner/Dockerfile runner/
#   docker run --rm -p 8080:8080 -e RUNNER_TOKEN=test wa-runner

FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg espeak-ng ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY jobs.mjs /app/jobs.mjs
COPY jobs-server.mjs /app/jobs-server.mjs

ENV PORT=8080 \
    WORKDIR=/tmp/wa-jobs

RUN mkdir -p /tmp/wa-jobs && chown -R node:node /tmp/wa-jobs

USER node
EXPOSE 8080

# 起動確認は GET /health。RUNNER_TOKEN は Worker 側から環境変数で渡します。
CMD ["node", "/app/jobs-server.mjs"]
