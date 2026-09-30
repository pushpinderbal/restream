import { memo, useEffect, useRef } from "react";

type Cloud = {
  x: number;
  y: number;
  driftX: number;
  driftY: number;
  radius: number;
  age: number;
  life: number;
};
type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  distance: number;
  size: number;
  brightness: number;
  cloud: number;
};

const random = (min: number, max: number) => min + Math.random() * (max - min);
const smooth = (value: number) => value * value * (3 - 2 * value);

export const GalaxyBackdrop = memo(function GalaxyBackdrop() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const surface = canvas.current;
    const context = surface?.getContext("2d", { alpha: false });
    if (!surface || !context) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0;
    let height = 0;
    let frame = 0;
    let lastFrame = 0;
    let elapsed = 0;
    let clouds: Cloud[] = [];
    let particles: Particle[] = [];
    let stars: { x: number; y: number; size: number; opacity: number }[] = [];

    // Paint soft sprites once, then reuse them instead of blurring the full
    // canvas every frame. The palette stays close to pearl and slate.
    const glow = document.createElement("canvas");
    glow.width = glow.height = 64;
    const glowContext = glow.getContext("2d")!;
    const gradient = glowContext.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(226, 230, 237, 0.45)");
    gradient.addColorStop(0.15, "rgba(184, 191, 202, 0.18)");
    gradient.addColorStop(0.5, "rgba(145, 151, 162, 0.04)");
    gradient.addColorStop(1, "rgba(143, 148, 159, 0)");
    glowContext.fillStyle = gradient;
    glowContext.fillRect(0, 0, 64, 64);

    const newCloud = (): Cloud => ({
      x: random(0.05, 0.95) * width,
      y: random(0.05, 0.95) * height,
      driftX: random(-0.16, 0.16) * width,
      driftY: random(-0.16, 0.16) * height,
      radius: random(65, 150),
      age: 0,
      life: random(65, 110),
    });

    const resize = () => {
      width = surface.clientWidth;
      height = surface.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      surface.width = Math.round(width * ratio);
      surface.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = "#020308";
      context.fillRect(0, 0, width, height);
      clouds = Array.from({ length: 6 }, () => {
        const cloud = newCloud();
        cloud.age = random(0, cloud.life);
        return cloud;
      });
      const count = Math.min(
        440,
        Math.max(150, Math.round((width * height) / 3300)),
      );
      particles = Array.from({ length: count }, (_, i) => ({
        x: random(0, width),
        y: random(0, height),
        vx: random(-2, 2),
        vy: random(-1.5, 1.5),
        angle: random(0, Math.PI * 2),
        // Bias some stars toward a cloud's core, without evenly spaced rings.
        distance: Math.pow(Math.random(), 0.7),
        size: random(0.5, 1.6),
        brightness: random(0.2, 0.75),
        cloud: i % 7 === 0 ? -1 : i % clouds.length,
      }));
      stars = Array.from({ length: Math.round(count * 0.7) }, () => ({
        x: random(0, width),
        y: random(0, height),
        size: random(0.3, 0.85),
        opacity: random(0.1, 0.4),
      }));
      draw(0);
    };

    const draw = (delta: number) => {
      elapsed += delta;
      // Clear fully to avoid quantized glow edges on dark displays.
      // Diffuse light belongs to the broad clouds; stars stay round and small.
      context.globalAlpha = 1;
      context.fillStyle = "#020308";
      context.fillRect(0, 0, width, height);
      for (let i = 0; i < clouds.length; i++) {
        clouds[i].age += delta;
        if (clouds[i].age >= clouds[i].life) clouds[i] = newCloud();
        const cloud = clouds[i];
        const strength = Math.pow(
          Math.sin((Math.PI * cloud.age) / cloud.life),
          3,
        );
        const x = cloud.x + (cloud.driftX * cloud.age) / cloud.life;
        const y = cloud.y + (cloud.driftY * cloud.age) / cloud.life;
        context.globalAlpha = strength * 0.2;
        context.drawImage(
          glow,
          x - cloud.radius * 2,
          y - cloud.radius * 1.3,
          cloud.radius * 4,
          cloud.radius * 2.6,
        );
      }
      for (const star of stars) {
        context.globalAlpha = star.opacity;
        context.fillStyle = "#b9bec9";
        context.beginPath();
        context.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        context.fill();
      }
      for (const particle of particles) {
        particle.x = (particle.x + particle.vx * delta + width) % width;
        particle.y = (particle.y + particle.vy * delta + height) % height;
        let x = particle.x;
        let y = particle.y;
        let density = 0;
        const cloud = clouds[particle.cloud];
        if (cloud) {
          const phase = cloud.age / cloud.life;
          density = smooth(Math.pow(Math.sin(Math.PI * phase), 2)) * 0.86;
          const angle =
            particle.angle + elapsed * 0.018 * (1 - particle.distance * 0.5);
          const radius = cloud.radius * particle.distance;
          const targetX =
            cloud.x + cloud.driftX * phase + Math.cos(angle) * radius;
          const targetY =
            cloud.y + cloud.driftY * phase + Math.sin(angle) * radius * 0.65;
          x += (targetX - x) * density;
          y += (targetY - y) * density;
        }
        const glowSize = particle.size * 4;
        context.globalAlpha = particle.brightness * 0.25;
        context.drawImage(
          glow,
          x - glowSize,
          y - glowSize,
          glowSize * 2,
          glowSize * 2,
        );
        context.globalAlpha = particle.brightness * 0.45;
        context.fillStyle = "#d4d9e3";
        context.beginPath();
        context.arc(x, y, particle.size * 0.45, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const animate = (now: number) => {
      frame = requestAnimationFrame(animate);
      if (now - lastFrame < 1000 / 30) return;
      const delta = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 0;
      lastFrame = now;
      draw(delta);
    };
    const syncMotion = () => {
      cancelAnimationFrame(frame);
      lastFrame = 0;
      if (reducedMotion.matches) draw(0);
      else if (!document.hidden) frame = requestAnimationFrame(animate);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(surface);
    reducedMotion.addEventListener("change", syncMotion);
    document.addEventListener("visibilitychange", syncMotion);
    resize();
    syncMotion();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      reducedMotion.removeEventListener("change", syncMotion);
      document.removeEventListener("visibilitychange", syncMotion);
    };
  }, []);

  return (
    <div className="page-backdrop" aria-hidden="true">
      <canvas className="galaxy-field" ref={canvas} />
    </div>
  );
});
