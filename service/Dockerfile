# Dockerfile — OG unfurl 서비스 (tsx 런타임, 빌드 없이 실행)
# 헤드리스(playwright)는 optionalDependency — 기본 이미지는 브라우저 미포함(static/oEmbed 경로만).
#   헤드리스가 필요하면 mcr.microsoft.com/playwright 베이스로 파생 이미지를 구성한다(EXTENSION).
FROM node:22-slim

# playwright 브라우저 다운로드/설치를 건너뛴다(headless.ts 가 미설치 시 graceful fallback).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# 의존성 먼저(레이어 캐시). package-lock 에 없는 신규 dep(pg) 도 반영하려 install 사용.
# tsx 는 devDependency(런타임에 필요) — omit=dev 하지 않는다. omit=optional 로 playwright 제외.
COPY package.json package-lock.json* ./
RUN npm install --omit=optional --no-audit --no-fund

# 소스
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations

EXPOSE 8080

# 기본은 API 서버. 마이그레이션은 compose 의 one-shot `migrate` 서비스가 담당(npm run migrate).
CMD ["npm", "start"]
