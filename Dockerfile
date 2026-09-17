FROM node:18-alpine

WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production

# 复制源代码
COPY . .

# 复制 .env.example 为默认 .env
RUN cp .env.example .env

# 创建数据和图片目录，并把整个 /app 交给非特权用户：
# 该镜像内含管理后台与文件写入路径，以 root 跑等于把容器 root 白送出去。
RUN mkdir -p data public/images && chown -R node:node /app

USER node

# 暴露端口
EXPOSE 8045

# 容器内必须监听 0.0.0.0 才能被端口映射访问。config.json 里的默认值是
# 127.0.0.1（本机直跑时是对的），而 Docker 不会因为 EXPOSE 就改它 ——
# 原样构建出来的镜像做 -p 映射时宿主连不上（实测 HTTP=000），
# 且容器内健康检查走回环照样 healthy，故障完全静默。
# 这里只影响镜像，本机 `npm start` 仍保持 127.0.0.1。
ENV AGY_SERVER_HOST=0.0.0.0

# 健康检查：进程假死后编排器能自动重建容器（原先没有 HEALTHCHECK，
# 假死状态下 docker 仍视为 running，故障不会被自动收敛）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -T 5 -O /dev/null http://127.0.0.1:8045/health || exit 1

# 启动应用
CMD ["sh", "-c", "node src/config/init-env.js && npm start"]
