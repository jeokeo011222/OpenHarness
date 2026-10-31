FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# 依赖层单独缓存，改代码不必重装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY serve.py ./serve.py

# 非 root 运行；审计目录挂载到 /srv/var
RUN useradd -m -u 10001 ontorag && mkdir -p /srv/var && chown -R ontorag:ontorag /srv
USER ontorag

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"

# 用 serve.py 而非 `uvicorn app.main:app`：事件循环策略必须在 uvicorn 建循环前生效
CMD ["python", "serve.py"]
