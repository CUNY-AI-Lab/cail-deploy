FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/build-contract/package.json packages/build-contract/package.json
COPY packages/build-runner/package.json packages/build-runner/package.json

RUN npm ci

COPY packages/build-contract packages/build-contract
COPY packages/build-runner packages/build-runner

CMD ["npm", "run", "start", "--workspace", "@cuny-ai-lab/build-runner"]
