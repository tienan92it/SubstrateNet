(() => {
  "use strict";

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const canvas = document.createElement("canvas");
  canvas.className = "substrate-bg";
  canvas.setAttribute("aria-hidden", "true");
  document.body.insertBefore(canvas, document.body.firstChild);

  const ctx = canvas.getContext("2d");
  let width = 0;
  let height = 0;
  let dpr = 1;
  let layers = [];
  let raf = 0;

  const layerConfigs = [
    { count: 14, speed: 0.035, radius: 1.6, alpha: 0.28 },
    { count: 24, speed: 0.06, radius: 1.1, alpha: 0.2 },
    { count: 36, speed: 0.09, radius: 0.8, alpha: 0.14 },
  ];

  function themeColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      node: style.getPropertyValue("--node").trim() || "rgba(142, 199, 181, 0.2)",
      nodeStrong: style.getPropertyValue("--node-strong").trim() || "rgba(142, 199, 181, 0.34)",
    };
  }

  function spawnNode(speed) {
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * speed,
      vy: (Math.random() - 0.5) * speed,
    };
  }

  function initLayers() {
    layers = layerConfigs.map((cfg) => ({
      ...cfg,
      nodes: Array.from({ length: cfg.count }, () => spawnNode(cfg.speed)),
    }));
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    initLayers();
    draw();
  }

  function nudge(node, maxSpeed) {
    node.vx += (Math.random() - 0.5) * 0.025;
    node.vy += (Math.random() - 0.5) * 0.025;
    const speed = Math.hypot(node.vx, node.vy);
    if (speed > maxSpeed) {
      node.vx = (node.vx / speed) * maxSpeed;
      node.vy = (node.vy / speed) * maxSpeed;
    }
  }

  function wrap(node) {
    const pad = 24;
    if (node.x < -pad) node.x = width + pad;
    if (node.x > width + pad) node.x = -pad;
    if (node.y < -pad) node.y = height + pad;
    if (node.y > height + pad) node.y = -pad;
  }

  function draw() {
    const colors = themeColors();
    ctx.clearRect(0, 0, width, height);

    for (const layer of layers) {
      const nodes = layer.nodes;

      if (!reduced) {
        for (const node of nodes) {
          node.x += node.vx;
          node.y += node.vy;
          wrap(node);
          if (Math.random() < 0.014) nudge(node, layer.speed * 1.4);
        }
      }

      ctx.fillStyle = colors.nodeStrong;
      for (const node of nodes) {
        ctx.globalAlpha = layer.alpha;
        ctx.beginPath();
        ctx.arc(node.x, node.y, layer.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
  }

  function loop() {
    draw();
    raf = window.requestAnimationFrame(loop);
  }

  window.addEventListener("resize", resize, { passive: true });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);

  resize();
  if (!reduced) loop();
  else window.cancelAnimationFrame(raf);
})();
